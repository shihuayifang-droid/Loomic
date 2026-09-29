// Covers the invariants that guard real money. These cannot be checked against
// the live system without paying for generations, so they are pinned here:
//
//   - refund happens exactly when nobody else owns it (no job created)
//   - a job existing means NO refund here, or the dead-letter handler would
//     refund the same charge a second time
//   - nothing is charged when a guard rejects
//   - video cost gets both duration AND resolution (the bug this refactor fixed:
//     POST /api/jobs/video-generation passed only duration, so 1080p billed at
//     the base rate)
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BackgroundJob } from "@loomic/shared";

import type { AuthenticatedUser } from "../../supabase/user.js";
import { CreditServiceError, type CreditService } from "./credit-service.js";
import { TierGuardError, type TierGuard } from "./tier-guard.js";
import { withBilling, type BillingRejection } from "./with-billing.js";

const USER: AuthenticatedUser = {
  id: "user-1",
  accessToken: "token",
  email: "a@b.c",
  userMetadata: {},
};
const WORKSPACE = "ws-1";

function makeCreditService(overrides: Partial<CreditService> = {}) {
  return {
    getBalance: vi.fn(async () => ({
      balance: 1000,
      plan: "pro" as const,
      dailyClaimed: false,
    })),
    getSubscription: vi.fn(async () => ({
      plan: "pro" as const,
      billingPeriod: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      canceledAt: null,
    })),
    deductCredits: vi.fn(async () => "tx-1"),
    refundCredits: vi.fn(async () => "tx-refund"),
    claimDailyCredits: vi.fn(async () => ({ success: true })),
    getTransactions: vi.fn(async () => []),
    updatePlan: vi.fn(async () => {}),
    ...overrides,
  } as unknown as CreditService & Record<string, ReturnType<typeof vi.fn>>;
}

function makeTierGuard(overrides: Partial<TierGuard> = {}) {
  return {
    checkModelAccess: vi.fn(),
    checkResolution: vi.fn(),
    checkVideoResolution: vi.fn(),
    checkConcurrency: vi.fn(async () => {}),
    calculateCreditCost: vi.fn(() => 10),
    ...overrides,
  } as unknown as TierGuard & Record<string, ReturnType<typeof vi.fn>>;
}

function makeJobService(jobId = "job-1") {
  const job = { id: jobId } as BackgroundJob;
  return {
    createJob: vi.fn(async () => job),
    cancelJob: vi.fn(async () => job),
    setCreditsInfo: vi.fn(async () => {}),
    getJob: vi.fn(),
    listJobs: vi.fn(),
    getJobAdmin: vi.fn(),
    markRunning: vi.fn(),
  } as any;
}

const IMAGE_REQUEST = {
  user: USER,
  workspaceId: WORKSPACE,
  modelId: "kwjm/gpt-image-2",
  guard: { jobType: "image_generation" as const, quality: "hd" as const },
  description: "test image",
};

describe("withBilling", () => {
  let creditService: ReturnType<typeof makeCreditService>;
  let tierGuard: ReturnType<typeof makeTierGuard>;
  let jobService: ReturnType<typeof makeJobService>;

  beforeEach(() => {
    creditService = makeCreditService();
    tierGuard = makeTierGuard();
    jobService = makeJobService();
  });

  describe("refund ownership", () => {
    it("refunds when no job was created and the work fails", async () => {
      await expect(
        withBilling({ creditService, tierGuard }, IMAGE_REQUEST, async () => {
          throw new Error("provider exploded");
        }),
      ).rejects.toThrow("provider exploded");

      expect(creditService.refundCredits).toHaveBeenCalledTimes(1);
      expect(creditService.refundCredits).toHaveBeenCalledWith(
        WORKSPACE,
        USER.id,
        10,
        undefined,
        expect.stringContaining("Refund"),
      );
    });

    it("does NOT refund when a job exists — the dead-letter handler owns it", async () => {
      await expect(
        withBilling(
          { creditService, tierGuard, jobService },
          { ...IMAGE_REQUEST, job: { payload: { prompt: "x" } } },
          async () => {
            throw new Error("poll timed out");
          },
        ),
      ).rejects.toThrow("poll timed out");

      expect(creditService.deductCredits).toHaveBeenCalledTimes(1);
      expect(creditService.refundCredits).not.toHaveBeenCalled();
    });

    it("does not refund a charge that never succeeded", async () => {
      creditService = makeCreditService({
        deductCredits: vi.fn(async () => {
          throw new CreditServiceError(
            "credit_deduct_failed",
            "db down",
            500,
          );
        }) as unknown as CreditService["deductCredits"],
      });

      await expect(
        withBilling({ creditService, tierGuard }, IMAGE_REQUEST, async () => "ok"),
      ).rejects.toThrow("db down");

      expect(creditService.refundCredits).not.toHaveBeenCalled();
    });

    it("surfaces the original error even if the refund itself fails", async () => {
      creditService = makeCreditService({
        refundCredits: vi.fn(async () => {
          throw new Error("refund endpoint down");
        }) as unknown as CreditService["refundCredits"],
      });

      await expect(
        withBilling({ creditService, tierGuard }, IMAGE_REQUEST, async () => {
          throw new Error("provider exploded");
        }),
      ).rejects.toThrow("provider exploded");
    });
  });

  describe("guards reject before any money moves", () => {
    it("reports a tier rejection and charges nothing", async () => {
      const error = new TierGuardError(
        "model_not_accessible",
        "nope",
        403,
      );
      tierGuard = makeTierGuard({
        checkModelAccess: vi.fn(() => {
          throw error;
        }),
      });
      const seen: BillingRejection[] = [];

      await expect(
        withBilling(
          { creditService, tierGuard, jobService },
          {
            ...IMAGE_REQUEST,
            job: { payload: {} },
            onRejected: (r) => seen.push(r),
          },
          async () => "ok",
        ),
      ).rejects.toBe(error);

      expect(seen).toEqual([{ kind: "tier", error }]);
      expect(jobService.createJob).not.toHaveBeenCalled();
      expect(creditService.deductCredits).not.toHaveBeenCalled();
    });

    it("reports insufficient credits and creates no job", async () => {
      creditService = makeCreditService({
        getBalance: vi.fn(async () => ({
          balance: 3,
          plan: "pro" as const,
          dailyClaimed: true,
        })) as unknown as CreditService["getBalance"],
      });
      const seen: BillingRejection[] = [];

      await expect(
        withBilling(
          { creditService, tierGuard, jobService },
          {
            ...IMAGE_REQUEST,
            job: { payload: {} },
            onRejected: (r) => seen.push(r),
          },
          async () => "ok",
        ),
      ).rejects.toThrow(CreditServiceError);

      expect(seen).toEqual([
        {
          kind: "insufficient_credits",
          currentBalance: 3,
          requiredAmount: 10,
          plan: "pro",
          dailyClaimed: true,
        },
      ]);
      expect(jobService.createJob).not.toHaveBeenCalled();
      expect(creditService.deductCredits).not.toHaveBeenCalled();
    });

    it("cancels the job when the deduction fails", async () => {
      creditService = makeCreditService({
        deductCredits: vi.fn(async () => {
          throw new Error("deduct failed");
        }) as unknown as CreditService["deductCredits"],
      });

      await expect(
        withBilling(
          { creditService, tierGuard, jobService },
          { ...IMAGE_REQUEST, job: { payload: {} } },
          async () => "ok",
        ),
      ).rejects.toThrow("deduct failed");

      expect(jobService.cancelJob).toHaveBeenCalledWith(USER, "job-1");
      expect(jobService.setCreditsInfo).not.toHaveBeenCalled();
    });
  });

  describe("happy path", () => {
    it("charges against the job id and records it on the job", async () => {
      const result = await withBilling(
        { creditService, tierGuard, jobService },
        { ...IMAGE_REQUEST, job: { payload: { prompt: "x" } } },
        async ({ job, creditsCost }) => `${job?.id}:${creditsCost}`,
      );

      expect(result).toBe("job-1:10");
      expect(creditService.deductCredits).toHaveBeenCalledWith(
        WORKSPACE,
        USER.id,
        10,
        "job-1",
        "test image",
      );
      expect(jobService.setCreditsInfo).toHaveBeenCalledWith("job-1", 10, "tx-1");
    });

    it("passes job refs through to createJob", async () => {
      await withBilling(
        { creditService, tierGuard, jobService },
        {
          ...IMAGE_REQUEST,
          job: {
            payload: { prompt: "x" },
            refs: { canvasId: "canvas-9", sessionId: "sess-9" },
          },
        },
        async () => "ok",
      );

      expect(jobService.createJob).toHaveBeenCalledWith(USER, {
        workspaceId: WORKSPACE,
        canvasId: "canvas-9",
        sessionId: "sess-9",
        jobType: "image_generation",
        payload: { prompt: "x" },
      });
    });

    it("skips guards and charging entirely when the credit system is off", async () => {
      const result = await withBilling(
        { jobService },
        { ...IMAGE_REQUEST, job: { payload: {} } },
        async ({ creditsCost }) => creditsCost,
      );

      expect(result).toBe(0);
      expect(jobService.createJob).toHaveBeenCalledTimes(1);
    });
  });

  describe("cost inputs", () => {
    it("passes BOTH duration and resolution for video", async () => {
      await withBilling(
        { creditService, tierGuard, jobService },
        {
          user: USER,
          workspaceId: WORKSPACE,
          modelId: "google-official/veo-3.1-generate-preview",
          guard: {
            jobType: "video_generation",
            duration: 8,
            resolution: "1080p",
          },
          description: "test video",
          job: { payload: {} },
        },
        async () => "ok",
      );

      expect(tierGuard.checkVideoResolution).toHaveBeenCalledWith("pro", "1080p");
      expect(tierGuard.calculateCreditCost).toHaveBeenCalledWith(
        "google-official/veo-3.1-generate-preview",
        "video_generation",
        { duration: 8, resolution: "1080p" },
      );
    });

    it("does not check video resolution when none was requested", async () => {
      await withBilling(
        { creditService, tierGuard, jobService },
        {
          user: USER,
          workspaceId: WORKSPACE,
          modelId: "wan-video/wan-2.6",
          guard: { jobType: "video_generation", duration: 5 },
          description: "test video",
          job: { payload: {} },
        },
        async () => "ok",
      );

      expect(tierGuard.checkVideoResolution).not.toHaveBeenCalled();
      expect(tierGuard.calculateCreditCost).toHaveBeenCalledWith(
        "wan-video/wan-2.6",
        "video_generation",
        { duration: 5 },
      );
    });

    it('resolves quality "plan_max" from the subscription plan', async () => {
      await withBilling(
        { creditService, tierGuard, jobService },
        {
          ...IMAGE_REQUEST,
          // pro -> maxResolution "hd"
          guard: { jobType: "image_generation", quality: "plan_max" },
          job: { payload: {} },
        },
        async () => "ok",
      );

      expect(tierGuard.checkResolution).toHaveBeenCalledWith("pro", "hd");
      expect(tierGuard.calculateCreditCost).toHaveBeenCalledWith(
        "kwjm/gpt-image-2",
        "image_generation",
        { quality: "hd" },
      );
    });

    it('resolves "plan_max" to standard on the free plan', async () => {
      creditService = makeCreditService({
        getSubscription: vi.fn(async () => ({
          plan: "free" as const,
          billingPeriod: null,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          canceledAt: null,
        })) as unknown as CreditService["getSubscription"],
      });

      await withBilling(
        { creditService, tierGuard, jobService },
        {
          ...IMAGE_REQUEST,
          guard: { jobType: "image_generation", quality: "plan_max" },
          job: { payload: {} },
        },
        async () => "ok",
      );

      expect(tierGuard.checkResolution).toHaveBeenCalledWith("free", "standard");
    });
  });

  it("fails loudly when a job is requested without a job service", async () => {
    await expect(
      withBilling(
        { creditService, tierGuard },
        { ...IMAGE_REQUEST, job: { payload: {} } },
        async () => "ok",
      ),
    ).rejects.toThrow(/jobService is missing/);
  });
});
