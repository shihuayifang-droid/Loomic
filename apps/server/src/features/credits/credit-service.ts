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
    | "credit_plan_update_failed";

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
};

// ── Factory ──────────────────────────────────────────────────

/**
 * `creditReadRepository` is OPTIONAL on purpose (workorder 21K): the two reads
 * it serves are the only ones that moved, and the remaining methods still work
 * through the admin client. When it is absent those two reads fail closed as
 * their existing `credit_query_failed` 500 — there is no PostgREST fallback and
 * the admin client is no longer reachable from them at all.
 */
export function createCreditService(options: {
  getAdminClient: () => AdminSupabaseClient;
  creditReadRepository?: CreditReadRepository;
}): CreditService {
  return {
    async getBalance(workspaceId) {
      const admin = options.getAdminClient();

      const [balanceResult, subscriptionResult, dailyClaimResult] =
        await Promise.all([
          admin
            .from("credit_balances")
            .select("balance")
            .eq("workspace_id", workspaceId)
            .maybeSingle(),
          admin
            .from("subscriptions")
            .select("plan")
            .eq("workspace_id", workspaceId)
            .maybeSingle(),
          admin
            .from("daily_credit_claims")
            .select("id")
            .eq("workspace_id", workspaceId)
            .eq("claim_date", new Date().toISOString().slice(0, 10))
            .maybeSingle(),
        ]);

      if (balanceResult.error || subscriptionResult.error) {
        throw new CreditServiceError(
          "credit_query_failed",
          "Failed to query credit balance.",
          500,
        );
      }

      return {
        balance: balanceResult.data?.balance ?? 0,
        plan: (subscriptionResult.data?.plan as SubscriptionPlan) ?? "free",
        dailyClaimed: dailyClaimResult.data !== null,
      };
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
        if (error.message?.includes("INSUFFICIENT_CREDITS")) {
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

      // Determine the workspace's plan
      const { data: sub, error: subError } = await admin
        .from("subscriptions")
        .select("plan")
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      if (subError) {
        throw new CreditServiceError(
          "credit_claim_failed",
          "Failed to query subscription.",
          500,
        );
      }

      const plan = (sub?.plan as SubscriptionPlan) ?? "free";
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

      // Fetch updated balance
      const { data: balanceRow } = await admin
        .from("credit_balances")
        .select("balance")
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      return {
        success: true,
        balance: balanceRow?.balance ?? 0,
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
