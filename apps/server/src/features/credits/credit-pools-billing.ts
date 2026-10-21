/**
 * The three-pool switch (workorder 37T, BL-04 / BL-41 / BL-45).
 *
 * `LOOMIC_CREDIT_POOLS=on` moves the charge, the refund and the balance
 * pre-check onto the three pools. Anything else leaves the credit service
 * exactly as it was: the wrapper below is only built when the switch is on.
 *
 * The wrapper replaces two methods and adds one optional capability; every
 * other method is the base service's own.
 */

import {
  availableCredits,
  planDeduction,
  type PoolBalances,
} from "@loomic/shared";

import { CreditServiceError, type CreditService } from "./credit-service.js";

/** SQLSTATEs raised by `deduct_from_pools` (37N). */
export const POOL_SQLSTATE = {
  insufficient: "P0402",
  personalCap: "P0403",
  teamPool: "P0404",
} as const;

/** Only the lowercase value `on` turns the pools on. */
export function creditPoolsEnabled(
  source: Record<string, string | undefined> = process.env,
): boolean {
  return source.LOOMIC_CREDIT_POOLS === "on";
}

export type CreditPoolsDeps = {
  resolveTeamWorkspaceId(): Promise<string | null>;
  deductFromPools(input: {
    workspaceId: string;
    userId: string;
    amount: number;
    jobId?: string | undefined;
    description?: string | undefined;
  }): Promise<string>;
  refundToPools(input: {
    jobId: string;
    description?: string | undefined;
  }): Promise<string | null>;
  readPoolBalances(input: {
    workspaceId: string;
    userId: string;
  }): Promise<PoolBalances>;
};

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function toDeductError(error: unknown): CreditServiceError {
  switch (sqlStateOf(error)) {
    case POOL_SQLSTATE.insufficient:
      return new CreditServiceError(
        "insufficient_credits",
        "Insufficient credits.",
        402,
      );
    case POOL_SQLSTATE.personalCap:
      return new CreditServiceError(
        "personal_cap_reached",
        "Personal monthly cap reached.",
        402,
      );
    case POOL_SQLSTATE.teamPool:
      return new CreditServiceError(
        "team_pool_exhausted",
        "Team credit pool exhausted.",
        402,
      );
    default:
      return new CreditServiceError(
        "credit_deduct_failed",
        "Failed to deduct credits.",
        500,
      );
  }
}

export function withCreditPools(
  base: CreditService,
  deps: CreditPoolsDeps,
): CreditService {
  return {
    getBalance: (workspaceId) => base.getBalance(workspaceId),
    claimDailyCredits: (workspaceId) => base.claimDailyCredits(workspaceId),
    getTransactions: (workspaceId, limit) =>
      base.getTransactions(workspaceId, limit),
    getSubscription: (workspaceId) => base.getSubscription(workspaceId),
    updatePlan: (workspaceId, plan) => base.updatePlan(workspaceId, plan),

    async deductCredits(workspaceId, userId, amount, jobId, description) {
      let teamWorkspaceId: string | null;
      try {
        teamWorkspaceId = await deps.resolveTeamWorkspaceId();
      } catch (error) {
        throw toDeductError(error);
      }
      if (teamWorkspaceId === null) {
        return base.deductCredits(workspaceId, userId, amount, jobId, description);
      }

      try {
        return await deps.deductFromPools({
          workspaceId: teamWorkspaceId,
          userId,
          amount,
          jobId,
          description,
        });
      } catch (error) {
        throw toDeductError(error);
      }
    },

    async refundCredits(workspaceId, userId, amount, jobId, description) {
      if (!jobId) {
        return base.refundCredits(workspaceId, userId, amount, jobId, description);
      }

      let refundId: string | null;
      try {
        refundId = await deps.refundToPools({ jobId, description });
      } catch {
        throw new CreditServiceError(
          "credit_refund_failed",
          "Failed to refund credits.",
          500,
        );
      }
      if (refundId !== null) return refundId;

      // The job was charged the old way: it is refunded the old way.
      return base.refundCredits(workspaceId, userId, amount, jobId, description);
    },

    async availableFor(input) {
      const teamWorkspaceId = await deps.resolveTeamWorkspaceId();
      if (teamWorkspaceId === null) return null;
      return availableCredits(
        await deps.readPoolBalances({
          workspaceId: teamWorkspaceId,
          userId: input.userId,
        }),
      );
    },

    // Workorder 38E (T-107 / BL-45): the same pools, the same split rule, but
    // asked BEFORE the charge so the pre-check can name which pool ran out.
    // The code comes from `planDeduction`, which is also what the SQL charge
    // applies — the two answers cannot drift apart.
    async refusalFor(input) {
      const teamWorkspaceId = await deps.resolveTeamWorkspaceId();
      if (teamWorkspaceId === null) return undefined;
      const balances = await deps.readPoolBalances({
        workspaceId: teamWorkspaceId,
        userId: input.userId,
      });
      const plan = planDeduction(balances, input.amount);
      if (plan.ok) return null;
      return { code: plan.code, personalCap: balances.personalCap };
    },
  };
}
