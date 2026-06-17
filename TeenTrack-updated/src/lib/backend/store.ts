import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { getDb } from "@/lib/backend/firebase";
import { INITIAL_STATE } from "@/lib/default-state";
import type { AppState, Transaction, TransactionType } from "@/lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = "teentrack";
const DOC_ID = "state";
const LOCK_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Zod schemas (unchanged from original)
// ---------------------------------------------------------------------------

const moneySchema = z.number().finite().nonnegative();
const positiveMoneySchema = z.number().finite().positive();

const addTransactionSchema = z.object({
  amount: positiveMoneySchema,
  type: z.enum(["income", "expense"]),
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).optional().default(""),
  date: z.string().trim().min(1).max(40),
});

const savingsSchema = z.object({
  type: z.enum(["flex", "locked"]),
  amount: moneySchema,
  action: z.enum(["deposit", "withdraw", "lock", "adjust"]),
});

const goalsSchema = z.object({
  flexibleGoal: positiveMoneySchema,
  lockedGoal: positiveMoneySchema,
});

const categoryNameSchema = z.string().trim().min(1).max(40);
const currencySchema = z.string().trim().min(3).max(8);

// ---------------------------------------------------------------------------
// Firestore helpers
// ---------------------------------------------------------------------------

function normalizeState(value: Partial<AppState> | null | undefined): AppState {
  return {
    ...INITIAL_STATE,
    ...value,
    transactions: Array.isArray(value?.transactions) ? value.transactions : [],
    categories:
      Array.isArray(value?.categories) && value.categories.length > 0
        ? value.categories
        : INITIAL_STATE.categories,
    unlockedAchievements: Array.isArray(value?.unlockedAchievements)
      ? value.unlockedAchievements
      : [],
    lockedUntil:
      typeof value?.lockedUntil === "number" ? value.lockedUntil : null,
  };
}

function cloneState(state: AppState): AppState {
  return JSON.parse(JSON.stringify(state));
}

async function readState(): Promise<AppState> {
  const db = getDb();
  const snap = await db.collection(COLLECTION).doc(DOC_ID).get();
  if (!snap.exists) {
    await db.collection(COLLECTION).doc(DOC_ID).set(INITIAL_STATE);
    return cloneState(INITIAL_STATE);
  }
  return normalizeState(snap.data() as Partial<AppState>);
}

async function writeState(state: AppState): Promise<void> {
  const db = getDb();
  await db.collection(COLLECTION).doc(DOC_ID).set(state);
}

/**
 * Runs a mutation inside a Firestore transaction so concurrent requests
 * can't produce split-brain state. Replaces the in-process write-queue
 * used with the JSON file store.
 */
async function mutateState<T>(
  mutation: (state: AppState) => T | Promise<T>
): Promise<T> {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(DOC_ID);

  let result!: T;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const state = normalizeState(
      snap.exists ? (snap.data() as Partial<AppState>) : undefined
    );

    result = await mutation(state);
    tx.set(ref, state);
  });

  return result;
}

// ---------------------------------------------------------------------------
// Domain helpers (unchanged)
// ---------------------------------------------------------------------------

function createTransaction(input: {
  amount: number;
  type: TransactionType;
  category: string;
  description: string;
  date: string;
}): Transaction {
  return {
    id: crypto.randomUUID(),
    amount: input.amount,
    type: input.type,
    category: input.category,
    description: input.description,
    date: input.date,
    timestamp: Date.now(),
  };
}

function updateAchievements(state: AppState) {
  const achievements = new Set(state.unlockedAchievements);
  const incomeCount = state.transactions.filter(
    (t) => t.type === "income"
  ).length;
  const expenseCount = state.transactions.filter(
    (t) => t.type === "expense"
  ).length;

  if (state.transactions.length > 0) achievements.add("first_tx");
  if (expenseCount >= 5) achievements.add("five_exp");
  if (incomeCount >= 3) achievements.add("three_inc");
  if (state.flexibleSavings >= 100) achievements.add("flex_saver");
  if (state.lockedSavings >= 100) achievements.add("locked_champ");
  if (state.totalBalance >= 1000) achievements.add("balance_keeper");

  state.unlockedAchievements = Array.from(achievements);
}

function assertCanSpend(state: AppState, amount: number) {
  if (state.totalBalance < amount) {
    throw new Error("Insufficient funds");
  }
}

// ---------------------------------------------------------------------------
// Public API (identical signatures to the original file-based store)
// ---------------------------------------------------------------------------

export async function getAppState(): Promise<AppState> {
  const state = await readState();
  updateAchievements(state);
  return cloneState(state);
}

export async function addTransaction(input: unknown): Promise<AppState> {
  const data = addTransactionSchema.parse(input);

  return mutateState((state) => {
    if (data.type === "expense") {
      assertCanSpend(state, data.amount);
    }

    const transaction = createTransaction(data);
    state.transactions.push(transaction);
    state.totalBalance += data.type === "income" ? data.amount : -data.amount;
    updateAchievements(state);
    return cloneState(state);
  });
}

export async function updateSavings(input: unknown): Promise<AppState> {
  const data = savingsSchema.parse(input);
  if (data.action !== "adjust" && data.amount <= 0) {
    throw new Error("Amount must be greater than zero");
  }

  return mutateState((state) => {
    const date = new Date().toISOString().split("T")[0];
    const isFlexible = data.type === "flex";
    const balanceKey = isFlexible ? "flexibleSavings" : "lockedSavings";
    const categoryLabel = isFlexible ? "Flexible Stash" : "The Vault";

    if (data.action === "deposit" || data.action === "lock") {
      assertCanSpend(state, data.amount);
      state.totalBalance -= data.amount;
      state[balanceKey] += data.amount;

      if (!isFlexible) {
        state.lockedUntil = Date.now() + LOCK_DURATION_MS;
      }

      state.transactions.push(
        createTransaction({
          amount: data.amount,
          type: "income",
          category: "Other",
          description: `Saved to ${categoryLabel}`,
          date,
        })
      );
    }

    if (data.action === "withdraw") {
      if (state[balanceKey] < data.amount) {
        throw new Error(`Not enough in ${categoryLabel}`);
      }

      state[balanceKey] -= data.amount;
      state.totalBalance += data.amount;
      state.transactions.push(
        createTransaction({
          amount: data.amount,
          type: "expense",
          category: "Other",
          description: `Withdrew from ${categoryLabel}`,
          date,
        })
      );
    }

    if (data.action === "adjust") {
      state[balanceKey] = data.amount;
    }

    updateAchievements(state);
    return cloneState(state);
  });
}

export async function updateGoals(input: unknown): Promise<AppState> {
  const data = goalsSchema.parse(input);

  return mutateState((state) => {
    state.flexibleGoal = data.flexibleGoal;
    state.lockedGoal = data.lockedGoal;
    return cloneState(state);
  });
}

export async function addCategory(input: unknown): Promise<AppState> {
  const name = categoryNameSchema.parse(
    (input as { name?: unknown } | null)?.name ?? "New Category"
  );

  return mutateState((state) => {
    state.categories.push(name);
    return cloneState(state);
  });
}

export async function updateCategory(
  index: number,
  input: unknown
): Promise<AppState> {
  const name = categoryNameSchema.parse(
    (input as { name?: unknown } | null)?.name
  );

  return mutateState((state) => {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= state.categories.length
    ) {
      throw new Error("Category not found");
    }

    state.categories[index] = name;
    return cloneState(state);
  });
}

export async function deleteCategory(index: number): Promise<AppState> {
  return mutateState((state) => {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= state.categories.length
    ) {
      throw new Error("Category not found");
    }
    if (state.categories.length === 1) {
      throw new Error("At least one category is required");
    }

    state.categories.splice(index, 1);
    return cloneState(state);
  });
}

export async function updateCurrency(input: unknown): Promise<AppState> {
  const currency = currencySchema.parse(
    (input as { currency?: unknown } | null)?.currency
  );

  return mutateState((state) => {
    state.currency = currency;
    return cloneState(state);
  });
}

export async function unlockVault(): Promise<AppState> {
  return mutateState((state) => {
    if (!state.lockedUntil || state.lockedUntil > Date.now()) {
      throw new Error("Vault is not ready to unlock");
    }

    const bonus = state.lockedSavings * 0.05;
    state.totalBalance += state.lockedSavings + bonus;
    state.lockedSavings = 0;
    state.lockedUntil = null;
    state.transactions.push(
      createTransaction({
        amount: bonus,
        type: "income",
        category: "Other",
        description: "Vault Bonus (5%)",
        date: new Date().toISOString().split("T")[0],
      })
    );

    updateAchievements(state);
    return cloneState(state);
  });
}
