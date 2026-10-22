// @credits-system — Tier enforcement: model access, resolution limits, concurrency guards per plan
import type {
  BillingErrorCode,
  ImageQualityLevel,
  SubscriptionPlan,
  VideoResolution,
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

/**
 * GN-20: how many unfinished jobs ONE member may hold at once, on every plan.
 * The plan no longer sets this number.
 */
export const MEMBER_CONCURRENCY_LIMIT = 4;

// ── Types ────────────────────────────────────────────────────

/**
 * BL-40: 守卫不再按套餐拒绝模型或画质；只剩按成员计的并发上限（GN-20）。
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
    userId?: string,
  ): Promise<void>;
};

// ── Factory ──────────────────────────────────────────────────

export function createTierGuard(options: {
  jobConcurrencyRepository: JobConcurrencyRepository;
}): TierGuard {
  return {
    // BL-40: model availability is decided by the price table (a model with no
    // usable row is refused as model_not_available) and by the member allow
    // list (MD-11, default ALL). The plan no longer refuses a model.
    checkModelAccess() {},

    // BL-40: image quality is no longer limited by plan.
    checkResolution() {},

    // BL-40: video resolution is no longer limited by plan.
    checkVideoResolution() {},

    async checkConcurrency(workspaceId, _plan, userId) {
      let activeCount: number;
      try {
        // The count carries the same three statuses the admin read used: a
        // retrying job still holds its slot (and its pre-charged credits), so it
        // has to count towards concurrency too. GN-20: with a user id the count
        // is that member's own jobs; without one it is the whole workspace.
        activeCount = await options.jobConcurrencyRepository.countActiveJobs(
          userId === undefined
            ? { workspaceId }
            : { workspaceId, createdBy: userId },
        );
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

      if (activeCount >= MEMBER_CONCURRENCY_LIMIT) {
        throw new TierGuardError(
          "concurrency_limit",
          `并发已满（${activeCount}/${MEMBER_CONCURRENCY_LIMIT}），请等待当前任务完成`,
          429,
        );
      }
    },
  };
}
