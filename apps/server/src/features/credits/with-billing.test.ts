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
import { JobServiceError } from "../jobs/job-service.js";
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
    // Workorder 21H2: the two steps of the compensation. `true` is the default
    // because that is the answer that lets the refund happen; every case below
    // that wants a refusal or a failure overrides one of them explicitly.
    claimUnlinkedCharge: vi.fn(async () => true),
    markChargeRefunded: vi.fn(async () => true),
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

  // -------------------------------------------------------------------------
  // Workorder 21H2: the charge can succeed and the LINK can still fail. That is
  // a different incident from a failed charge, and it gets a different answer:
  //
  //   claim (take ownership) -> refund exactly once -> mark -> rethrow the link
  //   error. NO cancel, and `run` is never called.
  //
  // The order matters because `refund_credits` does not de-duplicate by job id:
  // the claim is what makes the refund one-shot. Every case below pins one of
  // the ways that sequence can go wrong.
  // -------------------------------------------------------------------------
  describe("an unlinked charge is compensated exactly once (工单21H2)", () => {
    /** The link failure every case below starts from. */
    const linkFailure = new JobServiceError(
      "job_query_failed",
      "Failed to record the job credits for job-1.",
      500,
    );

    /** Silence the loud log lines while capturing them for assertions. */
    function captureLogs(level: "log" | "error") {
      const lines: string[] = [];
      const spy = vi
        .spyOn(console, level)
        .mockImplementation((...args: unknown[]) => {
          lines.push(args.map((arg) => String(arg)).join(" "));
        });
      return { lines, restore: () => spy.mockRestore() };
    }

    function failTheLink() {
      jobService.setCreditsInfo = vi.fn(async () => {
        throw linkFailure;
      });
    }

    it("claims, refunds with the exact arguments and marks — once each — and rethrows the link error", async () => {
      failTheLink();
      const logs = captureLogs("log");
      const runSpy = vi.fn(async () => "ok");
      try {
        const error = await withBilling(
          { creditService, tierGuard, jobService },
          { ...IMAGE_REQUEST, job: { payload: { prompt: "x" } } },
          runSpy,
        )
          .then(() => null)
          .catch((thrown: unknown) => thrown);

        // The caller learns why the REQUEST failed, never how the money was
        // cleaned up: the compensation must not replace the original error.
        expect(error).toBe(linkFailure);

        expect(jobService.claimUnlinkedCharge).toHaveBeenCalledTimes(1);
        expect(jobService.claimUnlinkedCharge).toHaveBeenCalledWith("job-1");
        expect(creditService.refundCredits).toHaveBeenCalledTimes(1);
        expect(creditService.refundCredits).toHaveBeenCalledWith(
          WORKSPACE,
          USER.id,
          10,
          "job-1",
          "Refund: test image (credits link failed)",
        );
        expect(jobService.markChargeRefunded).toHaveBeenCalledTimes(1);
        expect(jobService.markChargeRefunded).toHaveBeenCalledWith("job-1");

        // The order IS the ownership rule: the refund may only happen after the
        // claim answered, and the mark only after the refund succeeded.
        const firstCall = (fn: unknown): number =>
          (fn as { mock: { invocationCallOrder: number[] } }).mock
            .invocationCallOrder[0]!;
        expect(firstCall(jobService.claimUnlinkedCharge)).toBeLessThan(
          firstCall(creditService.refundCredits),
        );
        expect(firstCall(creditService.refundCredits)).toBeLessThan(
          firstCall(jobService.markChargeRefunded),
        );

        // No cancel: the claim already moved a queued/retrying job to failed, so
        // cancelling would either do nothing or race that write.
        expect(jobService.cancelJob).not.toHaveBeenCalled();
        // The work never started — this request did not happen.
        expect(runSpy).not.toHaveBeenCalled();
        // The one log line is the record that the money went back.
        expect(logs.lines).toHaveLength(1);
        expect(logs.lines[0]).toContain("refunded 10 credits");
      } finally {
        logs.restore();
      }
    });

    it("does not refund when the claim THROWS, and says what is at stake", async () => {
      failTheLink();
      const logs = captureLogs("error");
      jobService.claimUnlinkedCharge = vi.fn(async () => {
        throw new Error("claim endpoint down");
      });
      try {
        const error = await withBilling(
          { creditService, tierGuard, jobService },
          { ...IMAGE_REQUEST, job: { payload: {} } },
          async () => "ok",
        )
          .then(() => null)
          .catch((thrown: unknown) => thrown);

        expect(error).toBe(linkFailure);
        // Without ownership a refund can pay the same charge twice: it must not
        // happen, and the job is left for the compensation pass to reconcile.
        expect(creditService.refundCredits).not.toHaveBeenCalled();
        expect(jobService.markChargeRefunded).not.toHaveBeenCalled();
        expect(jobService.cancelJob).not.toHaveBeenCalled();

        expect(logs.lines).toHaveLength(1);
        const line = logs.lines[0]!;
        expect(line).toContain("NOT refunding");
        // The log names what the workspace is out: workspace, job, amount and the
        // transaction that took the money.
        expect(line).toContain(WORKSPACE);
        expect(line).toContain("job-1");
        expect(line).toContain("10");
        expect(line).toContain("tx-1");
        expect(line).toContain("claim endpoint down");
      } finally {
        logs.restore();
      }
    });

    it("does not refund when the claim answers false, and leaves the job to the worker", async () => {
      failTheLink();
      const logs = captureLogs("error");
      jobService.claimUnlinkedCharge = vi.fn(async () => false);
      try {
        const error = await withBilling(
          { creditService, tierGuard, jobService },
          { ...IMAGE_REQUEST, job: { payload: {} } },
          async () => "ok",
        )
          .then(() => null)
          .catch((thrown: unknown) => thrown);

        expect(error).toBe(linkFailure);
        expect(jobService.claimUnlinkedCharge).toHaveBeenCalledTimes(1);
        expect(creditService.refundCredits).not.toHaveBeenCalled();
        expect(jobService.markChargeRefunded).not.toHaveBeenCalled();
        expect(jobService.cancelJob).not.toHaveBeenCalled();

        expect(logs.lines).toHaveLength(1);
        const line = logs.lines[0]!;
        expect(line).toContain("NOT refunding");
        expect(line).toContain("job-1");
        expect(line).toContain("worker");
      } finally {
        logs.restore();
      }
    });

    it("does not retry and does not mark when the refund fails, and says the workspace is owed", async () => {
      failTheLink();
      const logs = captureLogs("error");
      creditService = makeCreditService({
        refundCredits: vi.fn(async () => {
          throw new CreditServiceError("credit_refund_failed", "refund rpc down", 500);
        }) as unknown as CreditService["refundCredits"],
      });
      try {
        const error = await withBilling(
          { creditService, tierGuard, jobService },
          { ...IMAGE_REQUEST, job: { payload: {} } },
          async () => "ok",
        )
          .then(() => null)
          .catch((thrown: unknown) => thrown);

        expect(error).toBe(linkFailure);
        expect(creditService.refundCredits).toHaveBeenCalledTimes(1);
        // No mark: the job must stay `credits_refund_pending` so a compensation
        // pass can find it. Marking it refunded here would hide the debt.
        expect(jobService.markChargeRefunded).not.toHaveBeenCalled();

        expect(logs.lines).toHaveLength(1);
        const line = logs.lines[0]!;
        expect(line).toContain("owed");
        expect(line).toContain(WORKSPACE);
        expect(line).toContain("10");
        expect(line).toContain("credits_refund_pending");
      } finally {
        logs.restore();
      }
    });

    it("refunds exactly once even when the mark throws, and rethrows the link error", async () => {
      failTheLink();
      const logs = captureLogs("error");
      jobService.markChargeRefunded = vi.fn(async () => {
        throw new Error("mark endpoint down");
      });
      try {
        const error = await withBilling(
          { creditService, tierGuard, jobService },
          { ...IMAGE_REQUEST, job: { payload: {} } },
          async () => "ok",
        )
          .then(() => null)
          .catch((thrown: unknown) => thrown);

        expect(error).toBe(linkFailure);
        expect(creditService.refundCredits).toHaveBeenCalledTimes(1);
        expect(jobService.markChargeRefunded).toHaveBeenCalledTimes(1);

        expect(logs.lines).toHaveLength(1);
        expect(logs.lines[0]).toContain("refunded 10 credits");
        expect(logs.lines[0]).toContain("was NOT written");
        expect(logs.lines[0]).toContain("mark endpoint down");
      } finally {
        logs.restore();
      }
    });

    it("refunds exactly once when the mark is refused, and says the refund stands", async () => {
      failTheLink();
      const logs = captureLogs("error");
      jobService.markChargeRefunded = vi.fn(async () => false);
      try {
        const error = await withBilling(
          { creditService, tierGuard, jobService },
          { ...IMAGE_REQUEST, job: { payload: {} } },
          async () => "ok",
        )
          .then(() => null)
          .catch((thrown: unknown) => thrown);

        expect(error).toBe(linkFailure);
        expect(creditService.refundCredits).toHaveBeenCalledTimes(1);
        expect(jobService.markChargeRefunded).toHaveBeenCalledTimes(1);

        expect(logs.lines).toHaveLength(1);
        expect(logs.lines[0]).toContain("refund stands");
      } finally {
        logs.restore();
      }
    });

    it("the FAILED-CHARGE path is untouched: cancel and rethrow, no claim and no refund", async () => {
      const logs = captureLogs("error");
      creditService = makeCreditService({
        deductCredits: vi.fn(async () => {
          throw new CreditServiceError("credit_deduct_failed", "deduct exploded", 500);
        }) as unknown as CreditService["deductCredits"],
      });
      try {
        const error = await withBilling(
          { creditService, tierGuard, jobService },
          { ...IMAGE_REQUEST, job: { payload: {} } },
          async () => "ok",
        )
          .then(() => null)
          .catch((thrown: unknown) => thrown);

        // 21H0 H10: the charge error survives and the guarded cancel ran.
        expect((error as Error).message).toBe("deduct exploded");
        expect(jobService.cancelJob).toHaveBeenCalledWith(USER, "job-1");
        // Nothing was taken, so there is nothing to claim, refund or mark — and
        // the link write was never reached.
        expect(jobService.setCreditsInfo).not.toHaveBeenCalled();
        expect(jobService.claimUnlinkedCharge).not.toHaveBeenCalled();
        expect(creditService.refundCredits).not.toHaveBeenCalled();
        expect(jobService.markChargeRefunded).not.toHaveBeenCalled();
        expect(logs.lines).toEqual([]);
      } finally {
        logs.restore();
      }
    });

    it("the FREE path is untouched: a failed (0, null) confirmation cancels and does not compensate", async () => {
      tierGuard = makeTierGuard({ calculateCreditCost: vi.fn(() => 0) });
      const failure = new Error("free confirmation exploded");
      jobService.setCreditsInfo = vi.fn(async () => {
        throw failure;
      });
      const logs = captureLogs("error");
      try {
        const error = await withBilling(
          { creditService, tierGuard, jobService },
          { ...IMAGE_REQUEST, job: { payload: {} } },
          async () => "ok",
        )
          .then(() => null)
          .catch((thrown: unknown) => thrown);

        // Nothing was charged, so there is nothing to give back: the 21H1
        // reaction (cancel + rethrow) is exactly right and is left alone.
        expect(error).toBe(failure);
        expect(jobService.cancelJob).toHaveBeenCalledWith(USER, "job-1");
        expect(creditService.deductCredits).not.toHaveBeenCalled();
        expect(jobService.claimUnlinkedCharge).not.toHaveBeenCalled();
        expect(creditService.refundCredits).not.toHaveBeenCalled();
        expect(jobService.markChargeRefunded).not.toHaveBeenCalled();
        expect(logs.lines).toEqual([]);
      } finally {
        logs.restore();
      }
    });

    it("the paid path with no job never claims or refunds: nobody is waiting on a queue message", async () => {
      const result = await withBilling(
        { creditService, tierGuard, jobService },
        IMAGE_REQUEST,
        async () => "ok",
      );

      expect(result).toBe("ok");
      expect(creditService.deductCredits).toHaveBeenCalledTimes(1);
      expect(jobService.setCreditsInfo).not.toHaveBeenCalled();
      expect(jobService.claimUnlinkedCharge).not.toHaveBeenCalled();
      expect(creditService.refundCredits).not.toHaveBeenCalled();
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
