/**
 * The credit ledger functions (workorder 44J, migration plan 25, OP-03).
 *
 * One statement per SQL function: `public.deduct_credits`,
 * `public.refund_credits`, `public.claim_daily_credits` and
 * `public.grant_plan_credits`. They run through the privileged transaction
 * entry point of workorder 19 with a NULL actor: the caller's authorization was
 * decided above, and the functions are service-role only.
 *
 * Same rules as `credit-pool-write-repository.ts`:
 *
 * - A database error is NOT wrapped. It is thrown as it came, so the SQLSTATE
 *   (`err.code`, e.g. P0402 for an insufficient balance, 22P02 for an unknown
 *   plan) reaches the service, which maps it by `code` (402 and so on). The
 *   transaction has rolled back by then, so a refused charge never leaves a
 *   half-written ledger. Wrapping the error would hide that code.
 * - All ids and numbers are bind parameters; nothing a caller passes becomes
 *   SQL text. The plan is cast to `public.subscription_plan` in SQL, so an
 *   unknown plan name is refused by the database.
 * - A result row without a usable value is an error, never a silent default.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type CreditLedgerFunctionRepository = {
  /** Charge `amount` from the workspace balance; returns the ledger row id. Throws the database error as is (`code` = SQLSTATE, P0402 when short). */
  deductCredits(input: {
    workspaceId: string;
    userId: string;
    amount: number;
    jobId?: string | null | undefined;
    description?: string | null | undefined;
  }): Promise<string>;
  /** Refund a charge; one refund per job, a repeat returns the first ledger row id. */
  refundCredits(input: {
    workspaceId: string;
    userId: string;
    amount: number;
    jobId: string | null;
    description?: string | null | undefined;
  }): Promise<string>;
  /** Claim today's free credits; true when granted, false when already claimed today. */
  claimDailyCredits(input: {
    workspaceId: string;
    amount: number;
  }): Promise<boolean>;
  /** Set the subscription plan and grant its credits; returns the balance afterwards. */
  grantPlanCredits(input: {
    workspaceId: string;
    plan: string;
    credits: number;
  }): Promise<number>;
};

const DEDUCT_SQL =
  "select public.deduct_credits($1::uuid, $2::uuid, $3::int, $4::uuid, $5::text) as v";

const REFUND_SQL =
  "select public.refund_credits($1::uuid, $2::uuid, $3::int, $4::uuid, $5::text) as v";

const CLAIM_DAILY_SQL =
  "select public.claim_daily_credits($1::uuid, $2::int) as v";

const GRANT_PLAN_SQL =
  "select public.grant_plan_credits($1::uuid, $2::public.subscription_plan, $3::int) as v";

export function createCreditLedgerFunctionRepository(options: {
  getTransactionPool: () => TransactionPool;
}): CreditLedgerFunctionRepository {
  return {
    async deductCredits(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(DEDUCT_SQL, [
            input.workspaceId,
            input.userId,
            input.amount,
            input.jobId ?? null,
            input.description ?? null,
          ]);
          const row = result.rows[0] as { v?: unknown } | undefined;
          if (row === undefined || typeof row.v !== "string" || row.v.length === 0) {
            throw new Error("deduct_credits returned no value");
          }
          return row.v;
        },
      );
    },

    async refundCredits(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(REFUND_SQL, [
            input.workspaceId,
            input.userId,
            input.amount,
            input.jobId,
            input.description ?? null,
          ]);
          const row = result.rows[0] as { v?: unknown } | undefined;
          if (row === undefined || typeof row.v !== "string" || row.v.length === 0) {
            throw new Error("refund_credits returned no value");
          }
          return row.v;
        },
      );
    },

    async claimDailyCredits(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(CLAIM_DAILY_SQL, [
            input.workspaceId,
            input.amount,
          ]);
          const row = result.rows[0] as { v?: unknown } | undefined;
          if (row === undefined || typeof row.v !== "boolean") {
            throw new Error("claim_daily_credits returned no value");
          }
          return row.v;
        },
      );
    },

    async grantPlanCredits(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(GRANT_PLAN_SQL, [
            input.workspaceId,
            input.plan,
            input.credits,
          ]);
          const row = result.rows[0] as { v?: unknown } | undefined;
          if (row === undefined || row.v === null || row.v === undefined) {
            throw new Error("grant_plan_credits returned no value");
          }
          const value = Number(row.v);
          if (!Number.isFinite(value)) {
            throw new Error("grant_plan_credits returned no value");
          }
          return value;
        },
      );
    },
  };
}
