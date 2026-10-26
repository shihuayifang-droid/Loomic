/**
 * Per-task credit spend guard (QA-15).
 *
 * Requirement: a single manual task must stop spending once it has burned more
 * than 200 credits. This module is the pure-logic half of that rule: it holds no
 * network client, no database handle and no timers — it only counts. Callers ask
 * `wouldExceed()` before spending and report back with `charge()`, so the same
 * object serves both "may I run the next step" and "bill the step I just ran".
 *
 * Two deliberate choices:
 *
 * - Rejection is STICKY. Once one charge is refused, every later charge on the
 *   same guard is refused too and the running total never moves again. A budget
 *   stop is meant to end the task; letting a smaller amount through afterwards
 *   would silently continue a task the user was just told had stopped.
 * - A rejected amount is never accumulated (`charged: 0`), so `spent` is always
 *   the sum of the amounts that were actually allowed.
 *
 * The clock is injected so tests (and the audit trail) do not depend on wall
 * time; nothing here reads `Date.now()` more than once per rejection.
 */

/** Credits a single task may consume before the guard stops it. */
export const TASK_CREDIT_LIMIT = 200;

/** Machine-readable reason a charge was refused. */
export type SpendGuardRejectionCode = "task_budget_exceeded";

/** Outcome of one `charge()` call. */
export interface SpendGuardChargeResult {
  /** True when the amount fit inside the task budget and was accumulated. */
  allowed: boolean;
  /** Present only when `allowed` is false. */
  code?: SpendGuardRejectionCode;
  /** Amount accumulated by this call; 0 for a refused call. */
  charged: number;
  /** Task total after this call (unchanged by a refused call). */
  spent: number;
  /** The budget this guard enforces. */
  limit: number;
}

/** Construction options for {@link SpendGuard}. */
export interface SpendGuardOptions {
  /** Task budget in credits. Defaults to {@link TASK_CREDIT_LIMIT}. */
  limit?: number;
  /** Injectable clock (epoch milliseconds), used to stamp a rejection. */
  now?: () => number;
}

/**
 * Thrown for a programming error — a negative, NaN or non-finite amount.
 *
 * This is intentionally NOT a budget refusal: a caller passing a bad amount has
 * a bug, and silently treating it as "0 credits" hides it until the bill arrives.
 */
export class InvalidCreditAmountError extends Error {
  constructor(operation: string, amount: number) {
    super(`spend-guard.${operation}: amount must be a finite number >= 0, got ${String(amount)}`);
    this.name = "InvalidCreditAmountError";
  }
}

function assertValidAmount(operation: string, amount: number): void {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new InvalidCreditAmountError(operation, amount);
  }
}

/** Counting-only guard for one task's credit budget. */
export class SpendGuard {
  private readonly limitCredits: number;
  private readonly readNow: () => number;
  private spentCredits = 0;
  private blockedAtMs: number | null = null;

  constructor(options: SpendGuardOptions = {}) {
    const limit = options.limit ?? TASK_CREDIT_LIMIT;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
      throw new InvalidCreditAmountError("limit", limit);
    }
    this.limitCredits = limit;
    this.readNow = options.now ?? Date.now;
  }

  /** The budget being enforced, in credits. */
  get limit(): number {
    return this.limitCredits;
  }

  /** Credits accumulated by allowed charges so far. */
  get spent(): number {
    return this.spentCredits;
  }

  /** Credits still available; never negative. */
  get remaining(): number {
    return Math.max(0, this.limitCredits - this.spentCredits);
  }

  /** True once a charge has been refused; stays true until `reset()`. */
  get blocked(): boolean {
    return this.blockedAtMs !== null;
  }

  /** Epoch ms at which the guard first refused a charge, or null. */
  get blockedAt(): number | null {
    return this.blockedAtMs;
  }

  /** Would spending `amount` push this task over its budget? */
  wouldExceed(amount: number): boolean {
    assertValidAmount("wouldExceed", amount);
    if (this.blockedAtMs !== null) return true;
    return this.spentCredits + amount > this.limitCredits;
  }

  /** Accumulate `amount` if the task can still afford it, else refuse. */
  charge(amount: number): SpendGuardChargeResult {
    assertValidAmount("charge", amount);

    if (this.blockedAtMs !== null || this.spentCredits + amount > this.limitCredits) {
      if (this.blockedAtMs === null) this.blockedAtMs = this.readNow();
      return {
        allowed: false,
        code: "task_budget_exceeded",
        charged: 0,
        spent: this.spentCredits,
        limit: this.limitCredits,
      };
    }

    this.spentCredits += amount;
    return {
      allowed: true,
      charged: amount,
      spent: this.spentCredits,
      limit: this.limitCredits,
    };
  }

  /** Clear the counter and the sticky rejection — a new task starts fresh. */
  reset(): void {
    this.spentCredits = 0;
    this.blockedAtMs = null;
  }
}

/** Create a guard for one task. `createSpendGuard({ limit: 200 })`. */
export function createSpendGuard(options: SpendGuardOptions = {}): SpendGuard {
  return new SpendGuard(options);
}
