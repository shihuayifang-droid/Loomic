// Covers the invariants that guard real money. These cannot be checked against
// the live system without paying for generations, so they are pinned here:
//
//   - refund happens exactly when nobody else owns it (no job created)
//   - a job existing means NO refund here, or the dead-letter handler would
//     refund the same charge a second time
//   - nothing is charged when a guard rejects
//   - the resolution a video request asked for still reaches the price lookup
//     (the bug this refactor fixed: POST /api/jobs/video-generation dropped
//     `resolution`, so 1080p was billed at the base rate)
//   - workorder 31B: the price is a QUOTE from the price table. A PENDING price
//     runs for 0 AND leaves a 0-amount ledger row; an UNREGISTERED model is
//     refused before any job, balance read or charge; an ACTIVE 0 is still free
//     with no ledger row at all.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BackgroundJob, PriceDetail } from "@loomic/shared";

import type { CreditLedgerWriteRepository } from "../../db/credit-ledger-write-repository.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
import { JobServiceError } from "../jobs/job-service.js";
import type { PriceQuoter } from "../pricing/price-quoter.js";
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
    ...overrides,
  } as unknown as TierGuard & Record<string, ReturnType<typeof vi.fn>>;
}

/**
 * 工单31B: a quote answer, shaped exactly like `resolvePriceFromCandidates` gives
 * it. The defaults are the "active, 10 credits" answer the old cost stub returned,
 * so every case that did not care about the price keeps its numbers.
 */
function makeDetail(overrides: Partial<PriceDetail> = {}): PriceDetail {
  return {
    base_price: 10,
    unit_name: "次",
    unit_count: 1,
    unit_price: 10,
    total_price: 10,
    search_key: "hd",
    search_key_matched: "hd",
    time_variant_period: "normal",
    disable_unlimited: false,
    entry_point: "canvas_generator",
    extras: [],
    price_status: "active",
    ...overrides,
  };
}

/** A quoted price, at a given status, with sane amount fields for that status. */
function makeQuote(overrides: {
  priceStatus?: "pending" | "active";
  totalPrice?: number;
  ruleId?: string;
}) {
  const priceStatus = overrides.priceStatus ?? "active";
  const totalPrice = overrides.totalPrice ?? 10;
  const price = priceStatus === "pending" ? 0 : totalPrice;

  return {
    ok: true as const,
    detail: makeDetail({
      base_price: price,
      unit_price: price,
      total_price: totalPrice,
      price_status: priceStatus,
    }),
    ruleId: overrides.ruleId ?? "rule-1",
  };
}

function makePriceQuoter(overrides: Partial<PriceQuoter> = {}) {
  return {
    quote: vi.fn(async () => makeQuote({})),
    ...overrides,
  } as unknown as PriceQuoter & Record<string, ReturnType<typeof vi.fn>>;
}

function makeLedger(overrides: Partial<CreditLedgerWriteRepository> = {}) {
  return {
    recordPendingConsume: vi.fn(async () => ({ transactionId: "tx-pending" })),
    ...overrides,
  } as unknown as CreditLedgerWriteRepository &
    Record<string, ReturnType<typeof vi.fn>>;
}

/**
 * 工单31B 裁决 9: an ACTIVE price of 0 is a DECISION (真免费), not the absence of
 * one. It charges nothing and, unlike `pending`, leaves no ledger row — the two
 * must not be conflated anywhere downstream.
 */
function makeFreeQuoter() {
  return makePriceQuoter({
    quote: vi.fn(async () => makeQuote({ priceStatus: "active", totalPrice: 0 })),
  });
}

/** A pending price: run for 0, and leave a 0-amount ledger row behind. */
function makePendingQuoter() {
  return makePriceQuoter({
    quote: vi.fn(async () => makeQuote({ priceStatus: "pending", totalPrice: 0 })),
  });
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
  entryPoint: "canvas_generator" as const,
  guard: { jobType: "image_generation" as const, quality: "hd" as const },
  description: "test image",
};

describe("withBilling", () => {
  let creditService: ReturnType<typeof makeCreditService>;
  let tierGuard: ReturnType<typeof makeTierGuard>;
  let jobService: ReturnType<typeof makeJobService>;
  let priceQuoter: ReturnType<typeof makePriceQuoter>;
  let ledger: ReturnType<typeof makeLedger>;

  beforeEach(() => {
    creditService = makeCreditService();
    tierGuard = makeTierGuard();
    jobService = makeJobService();
    priceQuoter = makePriceQuoter();
    ledger = makeLedger();
  });

  describe("refund ownership", () => {
    it("refunds when no job was created and the work fails", async () => {
      await expect(
        withBilling({ creditService, tierGuard, priceQuoter, creditLedgerWriteRepository: ledger }, IMAGE_REQUEST, async () => {
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
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
        withBilling({ creditService, tierGuard, priceQuoter, creditLedgerWriteRepository: ledger }, IMAGE_REQUEST, async () => "ok"),
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
        withBilling({ creditService, tierGuard, priceQuoter, creditLedgerWriteRepository: ledger }, IMAGE_REQUEST, async () => {
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
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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

  // 工单31B: the price lookup is a QUOTE against `pricing_rules`. What the caller
  // can still guarantee here is the INPUT it hands the quoter — model, entry point
  // and the tier key — because those decide which rule row is matched. The old
  // "duration AND resolution reach the cost function" pair has no equivalent for
  // duration: the price table has no duration dimension (ruling 4 keys video on
  // `resolution`, or `"unspecified"`), so the resolution half is what survives
  // and it is the half the P0 bug was about.
  describe("quote inputs (entry point and tier key)", () => {
    it("quotes a video at its requested resolution", async () => {
      await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
        {
          user: USER,
          workspaceId: WORKSPACE,
          modelId: "google-official/veo-3.1-generate-preview",
          entryPoint: "canvas_generator",
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
      expect(priceQuoter.quote).toHaveBeenCalledWith({
        modelId: "google-official/veo-3.1-generate-preview",
        entryPoint: "canvas_generator",
        searchKey: "1080p",
        at: expect.any(Date),
      });
    });

    it('quotes a video with no resolution at "unspecified" and checks nothing', async () => {
      await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
        {
          user: USER,
          workspaceId: WORKSPACE,
          modelId: "wan-video/wan-2.6",
          entryPoint: "agent",
          guard: { jobType: "video_generation", duration: 5 },
          description: "test video",
          job: { payload: {} },
        },
        async () => "ok",
      );

      expect(tierGuard.checkVideoResolution).not.toHaveBeenCalled();
      // 裁决 4: 视频只建默认行，所以 "unspecified" 命中的就是默认行 —— 这是预期行为。
      expect(priceQuoter.quote).toHaveBeenCalledWith({
        modelId: "wan-video/wan-2.6",
        entryPoint: "agent",
        searchKey: "unspecified",
        at: expect.any(Date),
      });
    });

    it('quotes the RESOLVED tier for image quality "plan_max" (not the literal)', async () => {
      await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
        {
          ...IMAGE_REQUEST,
          // pro -> maxResolution "hd"
          guard: { jobType: "image_generation", quality: "plan_max" },
          job: { payload: {} },
        },
        async () => "ok",
      );

      expect(tierGuard.checkResolution).toHaveBeenCalledWith("pro", "hd");
      // 裁决 4: 图片取 `plan_max` 解析之后的档位。把 "plan_max" 原样传下去会命中
      // 默认行，一个 hd 请求就按模型默认价结算了。
      expect(priceQuoter.quote).toHaveBeenCalledWith({
        modelId: "kwjm/gpt-image-2",
        entryPoint: "canvas_generator",
        searchKey: "hd",
        at: expect.any(Date),
      });
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
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
  // 工单31B（BL-14 第 3 条 / GN-07 运行时）—— the price is a quote, and the three
  // answers behave differently on purpose:
  //
  //   pending       -> run for 0 AND leave a 0-amount ledger row (T7-1, T7-2, T7-6)
  //   model unknown -> refuse before job/balance/charge (T7-3)
  //   active N / 0  -> charge N / charge nothing and write NO row (T7-4, T7-5)
  //
  // Plus the wiring rule (T7-7): billing on without a quoter throws instead of
  // quietly charging 0, and the two input fields the quote is keyed on (T7-8).
  // -------------------------------------------------------------------------
  describe("the price comes from the price table (工单31B)", () => {
    it("T7-1 pending price with a job: no deduction, one 0-amount ledger row, confirmation and run", async () => {
      priceQuoter = makePendingQuoter();
      const runSpy = vi.fn(async ({ job }: { job?: { id: string } }) => job?.id ?? "none");

      const result = await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
        { ...IMAGE_REQUEST, job: { payload: { prompt: "pending" } } },
        runSpy,
      );

      expect(result).toBe("job-1");
      // 待定价不扣费。
      expect(creditService.deductCredits).not.toHaveBeenCalled();
      // 但必须留下一条金额 0、带 price_pending 的消费流水。
      expect(ledger.recordPendingConsume).toHaveBeenCalledTimes(1);
      expect(ledger.recordPendingConsume).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WORKSPACE,
          userId: USER.id,
          jobId: "job-1",
          description: "test image",
          ruleId: "rule-1",
          priceDetail: expect.objectContaining({
            price_status: "pending",
            total_price: 0,
          }),
        }),
      );
      // 任务仍要留下「本次花 0」的确认，否则 worker 的门禁会把它当成「还没扣」。
      expect(jobService.setCreditsInfo).toHaveBeenCalledWith("job-1", 0, null);
      // 顺序（裁决 8）：写流水在确认之前，确认在 run 之前。
      const order = (fn: unknown): number =>
        (fn as { mock: { invocationCallOrder: number[] } }).mock
          .invocationCallOrder[0]!;
      expect(order(ledger.recordPendingConsume)).toBeLessThan(
        order(jobService.setCreditsInfo),
      );
      expect(order(jobService.setCreditsInfo)).toBeLessThan(order(runSpy));
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it("T7-2 pending price with no job (sync route): the ledger row is written with jobId null", async () => {
      priceQuoter = makePendingQuoter();

      await withBilling(
        { creditService, tierGuard, priceQuoter, creditLedgerWriteRepository: ledger },
        IMAGE_REQUEST,
        async () => "ok",
      );

      expect(jobService.createJob).not.toHaveBeenCalled();
      expect(ledger.recordPendingConsume).toHaveBeenCalledTimes(1);
      expect(ledger.recordPendingConsume).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: null, ruleId: "rule-1" }),
      );
      // 没有 job 就没有需要确认的东西。
      expect(jobService.setCreditsInfo).not.toHaveBeenCalled();
    });

    it("T7-3 an unregistered model is refused before the job, the balance read and the charge", async () => {
      priceQuoter = makePriceQuoter({
        quote: vi.fn(async () => ({ ok: false as const, code: "model_not_available" as const })),
      });
      const rejections: BillingRejection[] = [];

      const error = await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
        {
          ...IMAGE_REQUEST,
          modelId: "forged/not-a-real-model",
          job: { payload: {} },
          onRejected: (rejection) => rejections.push(rejection),
        },
        async () => "ok",
      )
        .then(() => null)
        .catch((thrown: unknown) => thrown as CreditServiceError);

      expect(error).toBeInstanceOf(CreditServiceError);
      expect(error?.code).toBe("model_not_available");
      expect(error?.statusCode).toBe(400);
      expect(rejections).toEqual([
        { kind: "model_not_available", modelId: "forged/not-a-real-model" },
      ]);
      // 裁决 6：建 job、查余额、扣费、写流水，一个都没有发生。
      expect(creditService.getBalance).not.toHaveBeenCalled();
      expect(jobService.createJob).not.toHaveBeenCalled();
      expect(creditService.deductCredits).not.toHaveBeenCalled();
      expect(ledger.recordPendingConsume).not.toHaveBeenCalled();
    });

    it("T7-4 an active price of 6 is what gets charged, and no ledger row is written", async () => {
      priceQuoter = makePriceQuoter({
        quote: vi.fn(async () => makeQuote({ priceStatus: "active", totalPrice: 6 })),
      });

      const result = await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
        { ...IMAGE_REQUEST, job: { payload: {} } },
        async ({ creditsCost }) => creditsCost,
      );

      expect(result).toBe(6);
      expect(creditService.deductCredits).toHaveBeenCalledTimes(1);
      expect(creditService.deductCredits).toHaveBeenCalledWith(
        WORKSPACE,
        USER.id,
        6,
        "job-1",
        "test image",
      );
      expect(ledger.recordPendingConsume).not.toHaveBeenCalled();
    });

    it("T7-5 an active price of 0 charges nothing and writes NO row (a free decision is not pending)", async () => {
      priceQuoter = makeFreeQuoter();

      await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
        { ...IMAGE_REQUEST, job: { payload: {} } },
        async () => "ok",
      );

      expect(creditService.deductCredits).not.toHaveBeenCalled();
      expect(ledger.recordPendingConsume).not.toHaveBeenCalled();
      expect(jobService.setCreditsInfo).toHaveBeenCalledWith("job-1", 0, null);
    });

    it("T7-6 a failed pending-ledger write cancels the job, rethrows, and never runs", async () => {
      priceQuoter = makePendingQuoter();
      const failure = new Error("ledger insert exploded");
      ledger.recordPendingConsume = vi.fn(async () => {
        throw failure;
      }) as unknown as CreditLedgerWriteRepository["recordPendingConsume"];
      const runSpy = vi.fn(async () => "ok");

      const error = await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
        { ...IMAGE_REQUEST, job: { payload: {} } },
        runSpy,
      )
        .then(() => null)
        .catch((thrown: unknown) => thrown);

      expect(error).toBe(failure);
      // 与 setCreditsInfo 失败同一个反应（裁决 8）：任务不能停在可启动状态。
      expect(jobService.cancelJob).toHaveBeenCalledWith(USER, "job-1");
      expect(jobService.cancelJob).toHaveBeenCalledTimes(1);
      // 流水没写成，所以「本次花 0」的确认也不该写。
      expect(jobService.setCreditsInfo).not.toHaveBeenCalled();
      expect(creditService.deductCredits).not.toHaveBeenCalled();
      expect(runSpy).not.toHaveBeenCalled();
    });

    it("T7-7 billing on without a price quoter is a wiring error, not a free generation", async () => {
      await expect(
        withBilling(
          { creditService, tierGuard, jobService, creditLedgerWriteRepository: ledger },
          { ...IMAGE_REQUEST, job: { payload: {} } },
          async () => "ok",
        ),
      ).rejects.toThrow(/priceQuoter is missing/);

      // 一个都不是「按 0 处理」：不查余额、不建 job、不扣费、不写流水。
      expect(creditService.getBalance).not.toHaveBeenCalled();
      expect(jobService.createJob).not.toHaveBeenCalled();
      expect(creditService.deductCredits).not.toHaveBeenCalled();
      expect(ledger.recordPendingConsume).not.toHaveBeenCalled();
    });

    it("T7-8 entryPoint and tier key reach the quote: resolved tier for plan_max, unspecified for video", async () => {
      // 图片：plan_max 解析成 hd，入口是调用方传的那个。
      await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
        {
          ...IMAGE_REQUEST,
          entryPoint: "agent",
          guard: { jobType: "image_generation", quality: "plan_max" },
          job: { payload: {} },
        },
        async () => "ok",
      );

      expect(priceQuoter.quote).toHaveBeenLastCalledWith({
        modelId: "kwjm/gpt-image-2",
        entryPoint: "agent",
        searchKey: "hd",
        at: expect.any(Date),
      });

      // 视频：没有 resolution 时档位是 "unspecified"。
      await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
        {
          user: USER,
          workspaceId: WORKSPACE,
          modelId: "wan-video/wan-2.6",
          entryPoint: "canvas_generator",
          guard: { jobType: "video_generation", duration: 5 },
          description: "test video",
          job: { payload: {} },
        },
        async () => "ok",
      );

      expect(priceQuoter.quote).toHaveBeenLastCalledWith({
        modelId: "wan-video/wan-2.6",
        entryPoint: "canvas_generator",
        searchKey: "unspecified",
        at: expect.any(Date),
      });
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
      priceQuoter = makeFreeQuoter();
      const runSpy = vi.fn(async ({ job }: { job?: { id: string } }) => job?.id ?? "none");

      const result = await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
        IMAGE_REQUEST,
        async () => "ok",
      );
      expect(jobService.createJob).not.toHaveBeenCalled();
      expect(jobService.setCreditsInfo).not.toHaveBeenCalled();

      await withBilling({ jobService }, IMAGE_REQUEST, async () => "ok");
      expect(jobService.setCreditsInfo).not.toHaveBeenCalled();
    });

    it("cancels the job and rethrows when the confirmation write fails", async () => {
      priceQuoter = makeFreeQuoter();
      const failure = new Error("job update exploded");
      jobService.setCreditsInfo = vi.fn(async () => {
        throw failure;
      });
      const runSpy = vi.fn(async () => "ok");

      const error = await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
      priceQuoter = makeFreeQuoter();
      const failure = new Error("job update exploded");
      jobService.setCreditsInfo = vi.fn(async () => {
        throw failure;
      });
      jobService.cancelJob = vi.fn(async () => {
        throw new Error("cancel endpoint down");
      });

      const error = await withBilling(
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
      priceQuoter = makeFreeQuoter();
      const failure = new Error("free confirmation exploded");
      jobService.setCreditsInfo = vi.fn(async () => {
        throw failure;
      });
      const logs = captureLogs("error");
      try {
        const error = await withBilling(
          { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
        { creditService, tierGuard, jobService, priceQuoter, creditLedgerWriteRepository: ledger },
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
        { creditService, tierGuard, priceQuoter, creditLedgerWriteRepository: ledger },
        { ...IMAGE_REQUEST, job: { payload: {} } },
        async () => "ok",
      ),
    ).rejects.toThrow(/jobService is missing/);
  });
});
