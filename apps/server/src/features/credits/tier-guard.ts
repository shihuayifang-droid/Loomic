// @credits-system — Tier enforcement: model access, resolution limits, concurrency guards per plan
import type {
  BillingErrorCode,
  ImageQualityLevel,
  SubscriptionPlan,
  VideoResolution,
} from "@loomic/shared";
import {
  canAccessModel,
  canUseResolution,
  canUseVideoResolution,
  PLAN_CONFIGS,
} from "@loomic/shared";

import type { JobConcurrencyRepository } from "../../db/job-concurrency-repository.js";

// ── Error ────────────────────────────────────────────────────

export type TierGuardErrorCode = Exclude<BillingErrorCode, "insufficient_credits">;

export class TierGuardError extends Error {
  readonly statusCode: number;
  readonly code: TierGuardErrorCode;

  constructor(
    code: TierGuardError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "TierGuardError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Types ────────────────────────────────────────────────────

/**
 * 守卫本身只管「这个套餐能不能做这件事」。
 *
 * 工单31B 把价格计算从这里移走了：本模块的成本函数已删除，价格改由
 * `features/pricing/price-quoter.ts` 去价目表问一次（BL-14 第 3 条 / GN-07）。
 * shared 里那两个成本函数仍被 `http/image-models.ts`、`http/video-models.ts`
 * 使用，本单不删，留给 31C。
 */
export type TierGuard = {
  checkModelAccess(plan: SubscriptionPlan, modelId: string): void;
  checkResolution(plan: SubscriptionPlan, quality: ImageQualityLevel): void;
  checkVideoResolution(plan: SubscriptionPlan, resolution: VideoResolution): void;
  checkConcurrency(
    workspaceId: string,
    plan: SubscriptionPlan,
  ): Promise<void>;
};

// ── Factory ──────────────────────────────────────────────────

export function createTierGuard(options: {
  jobConcurrencyRepository: JobConcurrencyRepository;
}): TierGuard {
  return {
    checkModelAccess(plan, modelId) {
      if (!canAccessModel(plan, modelId)) {
        throw new TierGuardError(
          "model_not_accessible",
          `Your ${plan} plan does not have access to model "${modelId}". Please upgrade your plan.`,
          403,
        );
      }
    },

    checkResolution(plan, quality) {
      if (!canUseResolution(plan, quality)) {
        throw new TierGuardError(
          "resolution_not_allowed",
          `Your ${plan} plan does not allow "${quality}" image quality. Maximum allowed: "${PLAN_CONFIGS[plan].maxResolution}". Please upgrade your plan.`,
          403,
        );
      }
    },

    checkVideoResolution(plan, resolution) {
      if (!canUseVideoResolution(plan, resolution)) {
        throw new TierGuardError(
          "resolution_not_allowed",
          `Your ${plan} plan does not allow "${resolution}" video resolution. Maximum allowed: "${PLAN_CONFIGS[plan].maxVideoResolution}". Please upgrade your plan.`,
          403,
        );
      }
    },

    async checkConcurrency(workspaceId, plan) {
      const maxConcurrent = PLAN_CONFIGS[plan].maxConcurrentJobs;

      let activeCount: number;
      try {
        // The count carries the same three statuses the admin read used: a
        // retrying job still holds its slot (and its pre-charged credits), so it
        // has to count towards concurrency too.
        activeCount =
          await options.jobConcurrencyRepository.countActiveJobs({ workspaceId });
      } catch {
        // Log but don't block — fail open on query errors. The logged text is
        // FIXED: the repository's own message is fixed too, and its `cause` may
        // carry a host or a statement, so neither is passed on here.
        console.error(
          "[tier-guard] Failed to check concurrency:",
          "concurrency count unavailable",
        );
        return;
      }

      if (activeCount >= maxConcurrent) {
        throw new TierGuardError(
          "concurrency_limit",
          `Concurrent job limit reached (${activeCount}/${maxConcurrent}). Wait for a job to finish or upgrade your plan.`,
          429,
        );
      }
    },
  };
}
