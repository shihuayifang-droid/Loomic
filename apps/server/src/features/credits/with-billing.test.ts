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

  // -------------------------------------------------------------------------
  // Workorder 21H1: the paths that charge NOTHING still have to record that they
  // charged nothing. `createJob` enqueues the job before this function runs, so
  // the worker may already hold the message; a job left with a NULL
  // `credits_cost` is indistinguishable from one whose charge is still in
  // flight, and the worker's billing gate would defer it and then fail it as
  // `billing_not_confirmed`.
  //
  // The paid branch is deliberately NOT merged with these: the cases at the
  // bottom of this block pin that it still writes exactly once, with the real
  // amount and the real transaction.
  // -------------------------------------------------------------------------
  describe("billing confirmation when nothing is charged (工单21H1)", () => {
    it("records (0, null) for a free model, before the work runs", async () => {
      tierGuard = makeTierGuard({ calculateCreditCost: vi.fn(() => 0) });
      const runSpy = vi.fn(async ({ job }: { job?: { id: string } }) => job?.id ?? "none");

      const result = await withBilling(
        { creditService, tierGuard, jobService },
        { ...IMAGE_REQUEST, job: { payload: { prompt: "free" } } },
        runSpy,
      );

      expect(result).toBe("job-1");
      // A free model is not charged...
      expect(creditService.deductCredits).not.toHaveBeenCalled();
      // ...but it IS confirmed: `0` is a non-null cost the gate reads as billed.
      expect(jobService.setCreditsInfo).toHaveBeenCalledTimes(1);
      expect(jobService.setCreditsInfo).toHaveBeenCalledWith("job-1", 0, null);
      // `null` is the honest transaction id: no transaction exists, and the gate
      // keys on `credits_cost`, never on the link.
      // The worker may already be holding the queued message, so the record is
      // written before the caller's work starts.
      expect(jobService.setCreditsInfo.mock.invocationCallOrder[0]).toBeLessThan(
        runSpy.mock.invocationCallOrder[0]!,
      );
    });

    it("records (0, null) when the credit system is off and a job exists", async () => {
      const result = await withBilling(
        { jobService },
        { ...IMAGE_REQUEST, job: { payload: {} } },
        async ({ job, creditsCost }) => `${job?.id}:${creditsCost}`,
      );

      expect(result).toBe("job-1:0");
      expect(jobService.createJob).toHaveBeenCalledTimes(1);
      expect(jobService.setCreditsInfo).toHaveBeenCalledTimes(1);
      expect(jobService.setCreditsInfo).toHaveBeenCalledWith("job-1", 0, null);
    });

    it("records nothing when no job was created", async () => {
      // No job means nobody can be waiting on a queue message, so there is
      // nothing to confirm — on both the billing-enabled and the billing-off
      // path.
      await withBilling(
        { creditService, tierGuard, jobService },
        IMAGE_REQUEST,
        async () => "ok",
      );
      expect(jobService.createJob).not.toHaveBeenCalled();
      expect(jobService.setCreditsInfo).not.toHaveBeenCalled();

      await withBilling({ jobService }, IMAGE_REQUEST, async () => "ok");
      expect(jobService.setCreditsInfo).not.toHaveBeenCalled();
    });

    it("cancels the job and rethrows when the confirmation write fails", async () => {
      tierGuard = makeTierGuard({ calculateCreditCost: vi.fn(() => 0) });
      const failure = new Error("job update exploded");
      jobService.setCreditsInfo = vi.fn(async () => {
        throw failure;
      });
      const runSpy = vi.fn(async () => "ok");

      const error = await withBilling(
        { creditService, tierGuard, jobService },
        { ...IMAGE_REQUEST, job: { payload: {} } },
        runSpy,
      )
        .then(() => null)
        .catch((thrown: unknown) => thrown);

      // The caller sees the write error, not the cancel.
      expect(error).toBe(failure);
      // Same reaction as a failed deduction: the job must not stay startable
      // when the record of what it costs could not be written.
      expect(jobService.cancelJob).toHaveBeenCalledWith(USER, "job-1");
      expect(runSpy).not.toHaveBeenCalled();
      // Nothing was charged, so there is nothing to give back.
      expect(creditService.deductCredits).not.toHaveBeenCalled();
      expect(creditService.refundCredits).not.toHaveBeenCalled();
    });

    it("surfaces the confirmation error even when the cancel itself fails", async () => {
      tierGuard = makeTierGuard({ calculateCreditCost: vi.fn(() => 0) });
      const failure = new Error("job update exploded");
      jobService.setCreditsInfo = vi.fn(async () => {
        throw failure;
      });
      jobService.cancelJob = vi.fn(async () => {
        throw new Error("cancel endpoint down");
      });

      const error = await withBilling(
        { creditService, tierGuard, jobService },
        { ...IMAGE_REQUEST, job: { payload: {} } },
        async () => "ok",
      )
        .then(() => null)
        .catch((thrown: unknown) => thrown);

      expect(error).toBe(failure);
      expect(jobService.cancelJob).toHaveBeenCalledTimes(1);
    });

    it("the charged path still writes the real amount exactly once, and never a 0", async () => {
      await withBilling(
        { creditService, tierGuard, jobService },
        { ...IMAGE_REQUEST, job: { payload: {} } },
        async () => "ok",
      );

      // One write, carrying the amount and the transaction — and no second
      // "confirmed, costs nothing" record beside it.
      expect(jobService.setCreditsInfo).toHaveBeenCalledTimes(1);
      expect(jobService.setCreditsInfo).toHaveBeenCalledWith("job-1", 10, "tx-1");
      expect(jobService.setCreditsInfo).not.toHaveBeenCalledWith("job-1", 0, null);
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
