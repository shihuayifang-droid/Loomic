// @credits-system — Core credit operations: balance queries, deductions, refunds, grants, plan updates
import type {
  BillingPeriod,
  CreditTransaction,
  SubscriptionPlan,
} from "@loomic/shared";
import { PLAN_CONFIGS } from "@loomic/shared";

import type { CreditReadRepository } from "../../db/credit-read-repository.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";

// ── Error ────────────────────────────────────────────────────

export class CreditServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "insufficient_credits"
    | "credit_query_failed"
    | "credit_claim_failed"
    | "credit_deduct_failed"
    | "credit_refund_failed"
    | "credit_plan_update_failed"
    // Workorder 37T: the two refusals only the three-pool charge can give.
    | "personal_cap_reached"
    | "team_pool_exhausted"
    // 工单31B / GN-07: the price table has no usable row for this model. Raised by
    // `with-billing.ts` before any job or charge exists, and carried by this class
    // so the two HTTP error mappers that already handle it stay the only place a
    // billing refusal is turned into a status code.
    | "model_not_available"
    // Workorder 39P (AD-01 / BL-21 step 3): the member's generation is paused by
    // an administrator. Raised by `with-billing.ts` before any quote, job or
    // charge — an upgrade, a top-up or a new day does not lift it, only an
    // administrator does — and carried by this class so the two HTTP error
    // mappers that already turn a billing refusal into a status code keep being
    // the only place that decides one. 403, not 402: paying does not fix it.
    | "account_suspended";

  constructor(
    code: CreditServiceError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "CreditServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Types ────────────────────────────────────────────────────

export type BalanceInfo = {
  balance: number;
  plan: SubscriptionPlan;
  dailyClaimed: boolean;
};

export type SubscriptionInfo = {
  plan: SubscriptionPlan;
  billingPeriod: BillingPeriod | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
};

export type CreditService = {
  getBalance(workspaceId: string): Promise<BalanceInfo>;
  deductCredits(
    workspaceId: string,
    userId: string,
    amount: number,
    jobId?: string,
    description?: string,
  ): Promise<string>;
  refundCredits(
    workspaceId: string,
    userId: string,
    // LOCAL FORK: was `jobId: string` (required), which contradicted both its own
    // implementation (`p_job_id: jobId ?? null`) and deductCredits' `jobId?`.
    // Refunds are not always tied to a job -- the synchronous
    // /api/agent/generate-image route deducts without creating one -- and the
    // required signature was pushing callers toward inventing a fake id.
    amount: number,
    jobId?: string,
    description?: string,
  ): Promise<string>;
  claimDailyCredits(
    workspaceId: string,
  ): Promise<{ success: boolean; balance?: number }>;
  getTransactions(
    workspaceId: string,
    limit?: number,
  ): Promise<CreditTransaction[]>;
  getSubscription(workspaceId: string): Promise<SubscriptionInfo>;
  updatePlan(workspaceId: string, plan: SubscriptionPlan): Promise<void>;
  /**
   * Workorder 37T: the credits this member can spend under the three pools, or
   * `null` for "use the old balance". Only the `LOOMIC_CREDIT_POOLS=on` wrapper
   * has it.
   */
  /**
   * Workorder 39F (GN-33): the workspace a one-transaction charge hits and
   * whether it draws on the three pools. Only the pools wrapper has it; a
   * caller without it treats the answer as `{ workspaceId, usePools: false }`.
   */
  chargeTarget?(
    workspaceId: string,
  ): Promise<{ workspaceId: string; usePools: boolean }>;
  availableFor?(input: {
    workspaceId: string;
    userId: string;
  }): Promise<number | null>;
  /**
   * Workorder 38E (T-107 / BL-45): the precise refusal for `amount`, so the
   * pre-check can name the pool that ran out instead of always saying
   * `insufficient_credits`.
   *
   * `undefined` = no team workspace, use the old comparison;
   * `null` = the amount fits;
   * otherwise the BL-45 code plus the cap the message quotes.
   */
  refusalFor?(input: {
    workspaceId: string;
    userId: string;
    amount: number;
  }): Promise<
    | {
        code:
          | "personal_cap_reached"
          | "team_pool_exhausted"
          | "insufficient_credits";
        personalCap: number;
      }
    | null
    | undefined
  >;
  /**
   * Workorder 39P (AD-01 / BL-21 step 3): whether an administrator has paused
   * this member's generation. It is what `withBilling` asks before it quotes,
   * creates a job or charges anything.
   *
   * Optional on purpose: only `withGenerationPause` provides it, and a credit
   * service without it (an older wiring, a test double) keeps the pre-39P flow
   * rather than failing — see `with-billing.ts`. A THROW from it is not "not
   * paused": the caller lets it propagate, because "we could not tell" must not
   * be answered with a generation.
   */
  isGenerationPaused?(userId: string): Promise<boolean>;
};

// ── SQLSTATE ─────────────────────────────────────────────────

/**
 * X-40 §4: the SQLSTATE `deduct_credits` raises for an insufficient balance
 * (migration 20261020000001). Matched by code, never by message text.
 */
export const INSUFFICIENT_CREDITS_SQLSTATE = "P0402";

// ── Factory ──────────────────────────────────────────────────

/**
 * `creditReadRepository` is OPTIONAL on purpose (workorders 21K, 21P and 21Q):
 * it serves FOUR methods through FIVE reads — `getBalance` (balance snapshot),
 * `claimDailyCredits` (subscription row plus the post-claim balance snapshot),
 * `getTransactions` (transaction list) and `getSubscription` (subscription
 * row). Everything else still goes through the admin client: deduct, refund,
 * updatePlan and the claim RPC itself. With the repository absent there is no
 * PostgREST fallback: `getBalance`, `getTransactions` and `getSubscription`
 * fail closed as their existing `credit_query_failed` 500, while
 * `claimDailyCredits` keeps its own refusal for the subscription read and its
 * post-claim balance read is best effort — fixed log text, balance reported 0.
 */
export function createCreditService(options: {
  getAdminClient: () => AdminSupabaseClient;
  creditReadRepository?: CreditReadRepository;
}): CreditService {
  return {
    async getBalance(workspaceId) {
      try {
        const repository = options.creditReadRepository;
        if (!repository) {
          throw new Error("credit balance read needs a repository");
        }

        // The date is computed HERE, exactly as it always was: the JavaScript
        // UTC date, not the database's `current_date`. The two disagree whenever
        // the database timezone is not UTC — a known, separately registered
        // problem this migration deliberately does not touch.
        const row = await repository.readBalanceSnapshot({
          workspaceId,
          claimDate: new Date().toISOString().slice(0, 10),
        });

        return {
          balance: row.balance ?? 0,
          plan: (row.plan as SubscriptionPlan) ?? "free",
          dailyClaimed: row.daily_claimed,
        };
      } catch {
        throw new CreditServiceError(
          "credit_query_failed",
          "Failed to query credit balance.",
          500,
        );
      }
    },

    async deductCredits(workspaceId, userId, amount, jobId, description) {
      const admin = options.getAdminClient();

      const { data, error } = await admin.rpc("deduct_credits", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
        p_amount: amount,
        p_job_id: (jobId ?? null) as string,
        p_description: (description ?? null) as string,
      });

      if (error) {
        if (error.code === INSUFFICIENT_CREDITS_SQLSTATE) {
          throw new CreditServiceError(
            "insufficient_credits",
            "Not enough credits to perform this action.",
            402,
          );
        }
        throw new CreditServiceError(
          "credit_deduct_failed",
          `Failed to deduct credits: ${error.message}`,
          500,
        );
      }

      return data as string;
    },

    async refundCredits(workspaceId, userId, amount, jobId, description) {
      const admin = options.getAdminClient();

      const { data, error } = await admin.rpc("refund_credits", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
        p_amount: amount,
        // The generated RPC types declare these as non-nullable strings even
        // though the SQL functions accept NULL. Same cast as deductCredits above.
        p_job_id: (jobId ?? null) as string,
        p_description: (description ?? null) as string,
      });

      if (error) {
        throw new CreditServiceError(
          "credit_refund_failed",
          `Failed to refund credits: ${error.message}`,
          500,
        );
      }

      return data as string;
    },

    async claimDailyCredits(workspaceId) {
      const admin = options.getAdminClient();

      // Determine the workspace's plan. The subscription row now comes from the
      // read repository: a workspace without one is still the `free` plan, and a
      // missing repository or a failed read is still this method's existing
      // refusal, word for word — there is no PostgREST fallback behind it.
      let plan: SubscriptionPlan = "free";
      try {
        const repository = options.creditReadRepository;
        if (!repository) {
          throw new Error("credit claim needs a repository");
        }

        const subscription = await repository.readSubscription({ workspaceId });
        plan = (subscription?.plan as SubscriptionPlan) ?? "free";
      } catch {
        throw new CreditServiceError(
          "credit_claim_failed",
          "Failed to query subscription.",
          500,
        );
      }

      const config = PLAN_CONFIGS[plan];

      if (config.dailyCredits <= 0) {
        return { success: false };
      }

      const { data: claimed, error: claimError } = await admin.rpc(
        "claim_daily_credits",
        {
          p_workspace_id: workspaceId,
          p_amount: config.dailyCredits,
        },
      );

      if (claimError) {
        throw new CreditServiceError(
          "credit_claim_failed",
          `Failed to claim daily credits: ${claimError.message}`,
          500,
        );
      }

      if (!claimed) {
        return { success: false };
      }

      // Fetch updated balance. The credits are granted by this point, so a
      // failure HERE must never become a 500: the client would be told the claim
      // failed for credits it actually received, and its retry would then be
      // answered "already claimed today". The read is best effort — its failure
      // is logged with a FIXED text that carries no driver message — and the
      // balance is published as 0.
      let balance = 0;
      try {
        const repository = options.creditReadRepository;
        if (!repository) {
          throw new Error("credit claim needs a repository");
        }

        const snapshot = await repository.readBalanceSnapshot({
          workspaceId,
          claimDate: new Date().toISOString().slice(0, 10),
        });
        balance = snapshot.balance ?? 0;
      } catch {
        console.warn(
          "[credits] claimDailyCredits: the daily claim succeeded but the balance read failed; reporting balance 0",
        );
      }

      return {
        success: true,
        balance,
      };
    },

    async getTransactions(workspaceId, limit = 20) {
      const safeLimit = Math.min(Math.max(limit, 1), 100);

      try {
        const repository = options.creditReadRepository;
        if (!repository) {
          throw new Error("credit transaction read needs a repository");
        }

        // The clamp is passed on as-is: `NaN` stays `NaN`, the repository
        // refuses it before it can reach the database, and the refusal below is
        // therefore still this method's existing 500.
        return await repository.listTransactions({
          workspaceId,
          limit: safeLimit,
        });
      } catch {
        throw new CreditServiceError(
          "credit_query_failed",
          "Failed to query transactions.",
          500,
        );
      }
    },

    async getSubscription(workspaceId) {
      try {
        const repository = options.creditReadRepository;
        if (!repository) {
          throw new Error("credit subscription read needs a repository");
        }

        const data = await repository.readSubscription({ workspaceId });

        return {
          plan: (data?.plan as SubscriptionPlan) ?? "free",
          billingPeriod: (data?.billing_period as BillingPeriod) ?? null,
          stripeCustomerId: data?.stripe_customer_id ?? null,
          stripeSubscriptionId: data?.stripe_subscription_id ?? null,
          currentPeriodStart: data?.current_period_start ?? null,
          currentPeriodEnd: data?.current_period_end ?? null,
          canceledAt: data?.canceled_at ?? null,
        };
      } catch {
        throw new CreditServiceError(
          "credit_query_failed",
          "Failed to query subscription.",
          500,
        );
      }
    },

    async updatePlan(workspaceId, plan) {
      const admin = options.getAdminClient();
      const config = PLAN_CONFIGS[plan];

      // Atomic plan update + credit grant via RPC to avoid read-then-write race condition.
      // The RPC uses FOR UPDATE row locking so concurrent deductions cannot be overwritten.
      // TODO: Remove `as any` after running `supabase gen types` to regenerate database.ts
      const { error } = await (admin.rpc as any)("grant_plan_credits", {
        p_workspace_id: workspaceId,
        p_plan: plan,
        p_credits: config.monthlyCredits,
      });

      if (error) {
        throw new CreditServiceError(
          "credit_plan_update_failed",
          `Failed to update plan: ${error.message}`,
          500,
        );
      }
    },
  };
}
