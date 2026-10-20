import { describe, expect, it } from "vitest";

import type { JobBillingGateRepository } from "../../db/job-billing-gate-repository.js";
import type { ExecutorContext, JobExecutor } from "./job-executor.js";
import type { JobService } from "./job-service.js";
import {
  BILLING_CONFIRM_TIMEOUT_SECONDS,
  BILLING_DEFER_VT_SECONDS,
  executorTimeoutMs,
  processJobMessage,
} from "./process-job-message.js";
import type { ProcessJobMessageDeps } from "./process-job-message.js";

/** A gate row, spelled out per case so the matrix below reads like the ticket. */
type GateRow = { status: string; creditsCost: number | null; overdue: boolean };

type Scenario = {
  increment?: () => Promise<{ attempt_count: number; max_attempts: number } | null>;
  markRunning?: () => Promise<boolean>;
  markRetrying?: () => Promise<boolean>;
  markSucceeded?: () => Promise<boolean>;
  markFailed?: () => Promise<boolean>;
  executorThrows?: { code?: string; message: string };
  executorReturns?: Record<string, unknown>;
  hasExecutor?: boolean;
  refundThrows?: boolean;
  /**
   * What the billing gate's read answers. Omitted = a confirmed job (cost 0),
   * i.e. the pass-through answer every case written before this ticket gets.
   * `null` is a real answer too: the job row does not exist.
   */
  gate?: GateRow | null;
  /** The gate read throws instead of answering. */
  gateReadThrows?: boolean;
  /** What the timeout claim answers. Default: it claimed the row. */
  gateClaim?: boolean;
  /** The timeout claim throws instead of answering. */
  gateClaimThrows?: boolean;
  /** `renewVt` settles on the next macrotask instead of synchronously (T-43). */
  renewVtAsync?: boolean;
  /** GN-31: the executor never settles — an upstream that hangs. */
  executorHangs?: boolean;
  /** GN-31: the executor settles this many ms after it was started. */
  executorDelayMs?: number;
  /** GN-31: shortens the execution budget, in ms. Omitted = the real default. */
  executorTimeoutMs?: number;
};

function makeHarness(scenario: Scenario = {}) {
  const calls: string[] = [];
  const failures: Array<{ code: string; message: string }> = [];
  const retries: Array<{ code: string; message: string }> = [];
  let refunds = 0;

  const jobService = {
    async incrementAttempt() {
      calls.push("incrementAttempt");
      if (scenario.increment) return scenario.increment();
      return { attempt_count: 1, max_attempts: 3 };
    },
    async markRunning() {
      calls.push("markRunning");
      return scenario.markRunning ? scenario.markRunning() : true;
    },
    async markRetrying(_jobId: string, code: string, message: string) {
      calls.push("markRetrying");
      retries.push({ code, message });
      return scenario.markRetrying ? scenario.markRetrying() : true;
    },
    async markSucceeded() {
      calls.push("markSucceeded");
      return scenario.markSucceeded ? scenario.markSucceeded() : true;
    },
    async markFailed(_jobId: string, code: string, message: string) {
      calls.push("markFailed");
      failures.push({ code, message });
      return scenario.markFailed ? scenario.markFailed() : true;
    },
  } as unknown as JobService;

  const pgmq = {
    async archive() {
      calls.push("archive");
    },
    async deleteMsg() {
      calls.push("deleteMsg");
    },
  };

  /** The context the executor was handed (GN-11 reads `creditsCharged` from it). */
  let executorCtx: ExecutorContext | undefined;

  const executor: JobExecutor = async (_jobId, _payload, ctx) => {
    calls.push("executor");
    executorCtx = ctx;
    if (scenario.executorHangs) {
      // Never settles: the shape of an upstream call that hangs while the
      // executor keeps renewing its visibility timeout, which is exactly what
      // GN-31's budget exists to end.
      return new Promise<Record<string, unknown>>(() => {});
    }
    const delayMs = scenario.executorDelayMs;
    if (delayMs !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
    if (scenario.executorThrows) throw Object.assign(new Error(scenario.executorThrows.message), {
      ...(scenario.executorThrows.code ? { code: scenario.executorThrows.code } : {}),
    });
    return scenario.executorReturns ?? { ok: true };
  };

  const logs: string[] = [];

  /** Every gate call, with the arguments it was given. */
  const gateReads: Array<{ jobId: string; timeoutSeconds: number }> = [];
  const gateClaims: Array<{ jobId: string; timeoutSeconds: number }> = [];

  const billingGate = {
    async readBillingGate(input: { jobId: string; timeoutSeconds: number }) {
      calls.push("readBillingGate");
      gateReads.push(input);
      if (scenario.gateReadThrows) throw new Error("gate read exploded");
      // The default is a CONFIRMED job, so every case written before this
      // ticket keeps measuring what it was written to measure.
      return scenario.gate === undefined
        ? { status: "queued", creditsCost: 0, overdue: false }
        : scenario.gate;
    },
    async failUnbilledIfOverdue(input: { jobId: string; timeoutSeconds: number }) {
      calls.push("failUnbilledIfOverdue");
      gateClaims.push(input);
      if (scenario.gateClaimThrows) throw new Error("gate claim exploded");
      return scenario.gateClaim ?? true;
    },
  } as unknown as JobBillingGateRepository;

  /** The visibility renewals the gate asked for. */
  const renewals: number[] = [];

  const ctx = {
    renewVt: (vtSeconds: number) => {
      calls.push("renewVt");
      renewals.push(vtSeconds);
      if (!scenario.renewVtAsync) return Promise.resolve();
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          calls.push("renewVt:settled");
          resolve();
        }, 0),
      );
    },
  } as unknown as ExecutorContext;

  const deps: ProcessJobMessageDeps = {
    jobService,
    billingGate,
    pgmq: pgmq as never,
    getExecutor: () =>
      scenario.hasExecutor === false ? undefined : executor,
    refundJob: async () => {
      calls.push("refundJob");
      refunds += 1;
      if (scenario.refundThrows) throw new Error("refund endpoint down");
    },
    log: (message: string) => {
      logs.push(message);
    },
  };

  // GN-31: only the cases that measure the budget shorten it — every case
  // written before this ticket keeps the real default, so its budget never
  // enters what it was written to measure.
  const injectedTimeoutMs = scenario.executorTimeoutMs;

  if (injectedTimeoutMs !== undefined) {
    const fixedBudgetMs = injectedTimeoutMs;
    deps.executorTimeoutMs = () => fixedBudgetMs;
  }

  const args = {
    queue: "image_generation",
    queueJobType: "image_generation" as const,
    msg: { msg_id: 7, message: { job_id: "job-1", job_type: "image_generation" } } as never,
    ctx,
  };

  return {
    deps,
    args,
    calls,
    failures,
    retries,
    logs,
    renewals,
    gateReads,
    gateClaims,
    refunds: () => refunds,
    executorCtx: () => executorCtx,
    run: () => processJobMessage(deps, args),
  };
}

/** The whole happy path, as the list of calls it is allowed to make. */
const PASS_THROUGH_AND_SUCCEED = [
  "readBillingGate",
  "incrementAttempt",
  "markRunning",
  "executor",
  "markSucceeded",
  "deleteMsg",
];

describe("processJobMessage", () => {
  it("case 1: a success runs the executor and deletes the message", async () => {
    const h = makeHarness();

    await h.run();

    expect(h.calls).toEqual(PASS_THROUGH_AND_SUCCEED);
    expect(h.refunds()).toBe(0);
    expect(h.calls).not.toContain("archive");
  });

  it("case 2: a retryable failure on attempt 1 of 3 writes retrying, never failed", async () => {
    const h = makeHarness({
      increment: async () => ({ attempt_count: 1, max_attempts: 3 }),
      executorThrows: { message: "provider hiccup" },
    });

    await h.run();

    expect(h.calls).toContain("markRetrying");
    expect(h.calls).not.toContain("markFailed");
    expect(h.calls).not.toContain("archive");
    expect(h.refunds()).toBe(0);
  });

  it("case 3: exhausting the attempts fails terminally, refunds once and archives", async () => {
    const h = makeHarness({
      increment: async () => ({ attempt_count: 3, max_attempts: 3 }),
      executorThrows: { message: "still broken" },
    });

    await h.run();

    expect(h.calls).toContain("markFailed");
    expect(h.calls).not.toContain("markRetrying");
    expect(h.refunds()).toBe(1);
    expect(h.calls).toContain("archive");
  });

  it("case 4: a non-retryable code fails terminally on the first attempt", async () => {
    const h = makeHarness({
      increment: async () => ({ attempt_count: 1, max_attempts: 3 }),
      executorThrows: { code: "safety_filter", message: "blocked" },
    });

    await h.run();

    expect(h.calls).not.toContain("markRetrying");
    expect(h.failures).toEqual([{ code: "safety_filter", message: "blocked" }]);
    expect(h.refunds()).toBe(1);
    expect(h.calls).toContain("archive");
  });

  it("case 5: a failed attempt count leaves the message completely untouched", async () => {
    const h = makeHarness({
      increment: async () => {
        throw new Error("rpc down");
      },
    });

    await h.run();

    expect(h.calls).not.toContain("executor");
    expect(h.calls).not.toContain("markRunning");
    expect(h.calls).not.toContain("markFailed");
    expect(h.calls).not.toContain("markRetrying");
    expect(h.calls).not.toContain("archive");
    expect(h.calls).not.toContain("deleteMsg");
    expect(h.refunds()).toBe(0);
    expect(h.logs.join(" ")).toContain("incrementAttempt failed");
  });

  it("case 6: a missing job row archives the message", async () => {
    const h = makeHarness({ increment: async () => null });

    await h.run();

    expect(h.calls).toContain("archive");
    expect(h.calls).not.toContain("executor");
    expect(h.refunds()).toBe(0);
  });

  it("case 7: an already-spent budget fails without executing", async () => {
    const h = makeHarness({ increment: async () => ({ attempt_count: 4, max_attempts: 3 }) });

    await h.run();

    expect(h.calls).not.toContain("executor");
    expect(h.failures).toEqual([
      { code: "max_attempts_exceeded", message: expect.stringContaining("4/3") },
    ]);
    expect(h.refunds()).toBe(1);
    expect(h.calls).toContain("archive");
  });

  it("case 8: a job that can no longer start is archived without executing or refunding", async () => {
    const h = makeHarness({ markRunning: async () => false });

    await h.run();

    expect(h.calls).not.toContain("executor");
    expect(h.calls).toContain("archive");
    expect(h.refunds()).toBe(0);
    expect(h.calls).not.toContain("markFailed");
  });

  it("case 9: being cancelled while running only drops the message", async () => {
    const h = makeHarness({ markSucceeded: async () => false });

    await h.run();

    expect(h.calls).toContain("deleteMsg");
    expect(h.calls).not.toContain("markFailed");
    expect(h.refunds()).toBe(0);
  });

  it("case 10: a terminal failure that did not change a row does not refund", async () => {
    const h = makeHarness({
      increment: async () => ({ attempt_count: 3, max_attempts: 3 }),
      executorThrows: { message: "broken" },
      markFailed: async () => false,
    });

    await h.run();

    expect(h.calls).toContain("markFailed");
    expect(h.refunds()).toBe(0);
    expect(h.calls).toContain("archive");
  });

  it("case 11: no executor registered is a terminal failure", async () => {
    const h = makeHarness({ hasExecutor: false });

    await h.run();

    expect(h.failures).toEqual([
      { code: "no_executor", message: expect.stringContaining("image_generation") },
    ]);
    expect(h.refunds()).toBe(1);
    expect(h.calls).toContain("archive");
  });

  it("case 12: a throwing refund does not stop the archive", async () => {
    const h = makeHarness({
      increment: async () => ({ attempt_count: 3, max_attempts: 3 }),
      executorThrows: { message: "broken" },
      refundThrows: true,
    });

    await expect(h.run()).resolves.toBeUndefined();

    expect(h.calls).toContain("refundJob");
    expect(h.calls).toContain("archive");
    expect(h.logs.join(" ")).toContain("Refund failed");
  });
});

// ---------------------------------------------------------------------------
// Workorder 21H1 — the billing gate, one case per row of the ticket's matrix.
//
// `case G<n>` numbering matches the table in the workorder, so a reviewer can
// read the two side by side. Every case asserts BOTH the calls that must happen
// and the calls that must not, because "did nothing" is the whole behaviour of
// the deferring arms: a deferral that quietly incremented, archived or refunded
// would look identical from the outside and be wrong.
// ---------------------------------------------------------------------------

/** The gate row for a job that is queued, unbilled and past its window. */
const OVERDUE_UNBILLED: GateRow = {
  status: "queued",
  creditsCost: null,
  overdue: true,
};

/** The gate row for a job that is queued, unbilled and still inside the window. */
const WAITING_UNBILLED: GateRow = {
  status: "queued",
  creditsCost: null,
  overdue: false,
};

describe("processJobMessage: the billing gate (工单21H1)", () => {
  it("case G1: a gate READ failure logs and touches nothing at all", async () => {
    const h = makeHarness({ gateReadThrows: true });

    await h.run();

    // The read is the only call. No increment (so no attempt is spent), no
    // status write, no execute, no archive, no delete, no refund — the message
    // stays invisible and comes back when its visibility timeout expires.
    expect(h.calls).toEqual(["readBillingGate"]);
    expect(h.refunds()).toBe(0);
    expect(h.failures).toEqual([]);
    expect(h.logs.join(" ")).toContain("Billing gate read failed");
    expect(h.logs.join(" ")).toContain("gate read exploded");
  });

  it("case G2: no gate row falls through to the original flow, with no new branch", async () => {
    // `null` means the job row is gone. The gate adds nothing here: the original
    // flow already answers a missing row by archiving the message, and that is
    // what must happen — nothing else.
    const h = makeHarness({ gate: null, increment: async () => null });

    await h.run();

    expect(h.calls).toEqual(["readBillingGate", "incrementAttempt", "archive"]);
    expect(h.calls).not.toContain("executor");
    expect(h.calls).not.toContain("markRunning");
    expect(h.refunds()).toBe(0);
  });

  it("case G3: a recorded cost — 0 included — passes straight through", async () => {
    // 0 is a confirmation (free model, or billing switched off), and any positive
    // number is a charge. Neither the amount nor the age changes the answer: the
    // gate keys on `creditsCost === null`, and nothing else.
    const rows: GateRow[] = [
      { status: "queued", creditsCost: 0, overdue: false },
      { status: "queued", creditsCost: 0, overdue: true },
      { status: "queued", creditsCost: 10, overdue: true },
      { status: "retrying", creditsCost: 3, overdue: false },
    ];

    for (const gate of rows) {
      const h = makeHarness({ gate });

      await h.run();

      expect(h.calls).toEqual(PASS_THROUGH_AND_SUCCEED);
      expect(h.calls).not.toContain("renewVt");
      expect(h.calls).not.toContain("failUnbilledIfOverdue");
      expect(h.refunds()).toBe(0);
    }
  });

  it("case G4: an unbilled job inside the window is deferred, and nothing else happens", async () => {
    const h = makeHarness({ gate: WAITING_UNBILLED });

    await h.run();

    // Exactly one visibility renewal, and no other call of any kind: no attempt
    // is consumed while the charge is in flight (see the module header).
    expect(h.calls).toEqual(["readBillingGate", "renewVt"]);
    expect(h.renewals).toEqual([BILLING_DEFER_VT_SECONDS]);
    expect(h.gateClaims).toEqual([]);
    expect(h.logs.join(" ")).toContain("not billed yet");

    // `retrying` is deferred the same way: the gate is about the money, not
    // about which of the two startable statuses the row is in.
    const retrying = makeHarness({
      gate: { status: "retrying", creditsCost: null, overdue: false },
    });
    await retrying.run();
    expect(retrying.calls).toEqual(["readBillingGate", "renewVt"]);
  });

  it("case G5 (claim won): an overdue unbilled job is archived, and NEVER refunded", async () => {
    const h = makeHarness({ gate: OVERDUE_UNBILLED, gateClaim: true });

    await h.run();

    // The claim is attempted, it changed the row, and the message is retired.
    // Neither `terminalFail` nor `refundJob` may run: nothing was ever charged,
    // so a refund here would pay out for a payment that never happened — and
    // `markFailed` would race a charge landing right now.
    expect(h.calls).toEqual(["readBillingGate", "failUnbilledIfOverdue", "archive"]);
    expect(h.calls).not.toContain("refundJob");
    expect(h.calls).not.toContain("markFailed");
    expect(h.calls).not.toContain("incrementAttempt");
    expect(h.calls).not.toContain("executor");
    expect(h.calls).not.toContain("renewVt");
    expect(h.refunds()).toBe(0);
    expect(h.failures).toEqual([]);
    expect(h.gateClaims).toEqual([
      { jobId: "job-1", timeoutSeconds: BILLING_CONFIRM_TIMEOUT_SECONDS },
    ]);
  });

  it("case G5 (claim lost): a refused claim defers exactly like G4", async () => {
    // `false` means the predicate matched nothing: a charge landed, or the job
    // was cancelled, between the read and the write. Neither is this worker's to
    // overrule, so the answer is the deferring arm rather than a failure.
    const h = makeHarness({ gate: OVERDUE_UNBILLED, gateClaim: false });

    await h.run();

    expect(h.calls).toEqual([
      "readBillingGate",
      "failUnbilledIfOverdue",
      "renewVt",
    ]);
    expect(h.renewals).toEqual([BILLING_DEFER_VT_SECONDS]);
    expect(h.calls).not.toContain("archive");
    expect(h.calls).not.toContain("executor");
    expect(h.refunds()).toBe(0);
  });

  it("T-43: the deferring arm waits for renewVt before returning", async () => {
    // `renewVt` here settles on the next macrotask, so `renewVt:settled` can only
    // appear in `calls` if the deferring arm awaited the renewal before returning.
    const h = makeHarness({ gate: WAITING_UNBILLED, renewVtAsync: true });

    await h.run();

    expect(h.calls).toEqual(["readBillingGate", "renewVt", "renewVt:settled"]);
    expect(h.renewals).toEqual([BILLING_DEFER_VT_SECONDS]);
  });

  it("case G5 (claim threw): a failed claim is treated as G1, not as a refusal", async () => {
    const h = makeHarness({ gate: OVERDUE_UNBILLED, gateClaimThrows: true });

    await h.run();

    // An unknown claim must not be mistaken for "somebody else handled it": the
    // message is left alone and comes back, exactly as on a failed read.
    expect(h.calls).toEqual(["readBillingGate", "failUnbilledIfOverdue"]);
    expect(h.calls).not.toContain("archive");
    expect(h.calls).not.toContain("renewVt");
    expect(h.refunds()).toBe(0);
    expect(h.logs.join(" ")).toContain("Billing gate claim failed");
  });

  it("case G6: any status other than queued/retrying passes through, even unbilled and overdue", async () => {
    // This is the row that must add NO behaviour. A job that is running is being
    // executed by this or another worker; a terminal one is somebody else's
    // answer. Neither may be failed for billing, deferred, archived early or
    // refunded here.
    for (const status of [
      "running",
      "succeeded",
      "failed",
      "canceled",
      "dead_letter",
    ]) {
      const h = makeHarness({
        gate: { status, creditsCost: null, overdue: true },
      });

      await h.run();

      expect(h.calls).toEqual(PASS_THROUGH_AND_SUCCEED);
      expect(h.calls).not.toContain("failUnbilledIfOverdue");
      expect(h.calls).not.toContain("renewVt");
      expect(h.calls).not.toContain("markFailed");
      expect(h.refunds()).toBe(0);
    }
  });

  it("case G7: past the gate, every threshold and the single-refund rule are unchanged", async () => {
    // The gate passes here (a confirmed cost), so what follows is the original
    // flow verbatim: `>` before executing, `>=` after a failure, and a refund
    // only when `markFailed` really changed a row.
    const lastAttempt = makeHarness({
      gate: { status: "queued", creditsCost: 10, overdue: false },
      increment: async () => ({ attempt_count: 3, max_attempts: 3 }),
    });
    await lastAttempt.run();
    // 3/3 after the increment is the FINAL attempt and it must still run.
    expect(lastAttempt.calls).toEqual(PASS_THROUGH_AND_SUCCEED);

    const overBudget = makeHarness({
      increment: async () => ({ attempt_count: 4, max_attempts: 3 }),
    });
    await overBudget.run();
    expect(overBudget.failures).toEqual([
      { code: "max_attempts_exceeded", message: expect.stringContaining("4/3") },
    ]);
    expect(overBudget.refunds()).toBe(1);

    const failedWhileConfirmed = makeHarness({
      increment: async () => ({ attempt_count: 3, max_attempts: 3 }),
      executorThrows: { message: "still broken" },
    });
    await failedWhileConfirmed.run();
    expect(failedWhileConfirmed.refunds()).toBe(1);
    expect(failedWhileConfirmed.calls).toContain("archive");
  });

  it("case G8: the gate is READ before the attempt counter, and on every delivery", async () => {
    // The ordering IS the fix: a gate placed after `incrementAttempt` would spend
    // an attempt on every deferral, and three deferrals would turn a healthy paid
    // job into `max_attempts_exceeded`.
    const deferred = makeHarness({ gate: WAITING_UNBILLED });
    await deferred.run();

    expect(deferred.calls.indexOf("readBillingGate")).toBe(0);
    expect(deferred.calls).not.toContain("incrementAttempt");

    const confirmed = makeHarness();
    await confirmed.run();

    expect(confirmed.calls.indexOf("readBillingGate")).toBeLessThan(
      confirmed.calls.indexOf("incrementAttempt"),
    );

    // And every delivery re-reads: a second delivery of the same message after
    // the charge landed sees `creditsCost` and runs.
    const secondDelivery = makeHarness({
      gate: { status: "queued", creditsCost: 5, overdue: true },
    });
    await secondDelivery.run();
    expect(secondDelivery.calls).toEqual(PASS_THROUGH_AND_SUCCEED);
  });

  it("case G9: the gate is asked for the same job, with the ticket's window", async () => {
    const h = makeHarness();

    await h.run();

    expect(BILLING_CONFIRM_TIMEOUT_SECONDS).toBe(600);
    expect(BILLING_DEFER_VT_SECONDS).toBe(10);
    expect(h.gateReads).toEqual([
      { jobId: "job-1", timeoutSeconds: BILLING_CONFIRM_TIMEOUT_SECONDS },
    ]);
    // The read and the claim are asked about the same job with the same window,
    // so the claim cannot be made under a different rule than the read.
    const overdue = makeHarness({ gate: OVERDUE_UNBILLED, gateClaim: true });
    await overdue.run();
    expect(overdue.gateReads).toEqual(overdue.gateClaims);
  });

  it("GN-11: the executor receives the charged amount the billing gate read", async () => {
    const h = makeHarness({ gate: { status: "queued", creditsCost: 12, overdue: false } });

    await h.run();

    expect(h.executorCtx()?.creditsCharged).toBe(12);
  });

  it("GN-11: a free job hands the executor 0, not undefined", async () => {
    const h = makeHarness();

    await h.run();

    expect(h.executorCtx()?.creditsCharged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Workorder 36H — the executor's overall execution budget (GN-31).
//
// Until this ticket an attempt was unbounded: the executor renews its own
// visibility timeout while it works, so an upstream that never answers kept the
// message invisible forever and the job stayed `running`. These four cases pin
// the budget, the terminal `timeout` outcome, and the fact that a late success
// after the timeout writes nothing at all.
// ---------------------------------------------------------------------------

describe("processJobMessage: the execution budget (工单36H / GN-31)", () => {
  it("GN-31: an executor that never answers fails the job as timeout and refunds it", async () => {
    const h = makeHarness({ executorHangs: true, executorTimeoutMs: 20 });

    await h.run();

    expect(h.failures).toEqual([
      {
        code: "timeout",
        message: expect.stringContaining("exceeded its 20ms execution budget"),
      },
    ]);
    expect(h.refunds()).toBe(1);
    expect(h.calls).toContain("archive");
    expect(h.calls).not.toContain("markRetrying");
  });

  it("GN-31: a timeout is not retried even with attempts left", async () => {
    const h = makeHarness({
      executorHangs: true,
      executorTimeoutMs: 20,
      increment: async () => ({ attempt_count: 1, max_attempts: 3 }),
    });

    await h.run();

    // Attempt 1 of 3: a retryable failure would have written `retrying` here.
    expect(h.failures.map((failure) => failure.code)).toEqual(["timeout"]);
    expect(h.calls).not.toContain("markRetrying");
  });

  it("GN-31: a late success after the timeout does not turn the job into succeeded", async () => {
    // The executor needs 40ms, the budget is 10ms: the timeout is answered
    // first, and the executor's own resolution arrives 30ms later.
    const h = makeHarness({ executorDelayMs: 40, executorTimeoutMs: 10 });

    await h.run();

    expect(h.failures.map((failure) => failure.code)).toEqual(["timeout"]);

    // Wait past the executor's own resolution, then check that losing the race
    // really did drop the result instead of letting it through a little later.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });

    expect(h.calls).not.toContain("markSucceeded");
    expect(h.calls).not.toContain("deleteMsg");
    expect(h.refunds()).toBe(1);
  });

  it("GN-31: the default budget is the visibility timeout times the attempts", () => {
    // The registry's visibility timeouts (image 120s, video 300s) times the
    // attempt budget, in ms. `0` attempts means "not counted yet" and must not
    // collapse the budget to nothing.
    expect(executorTimeoutMs("image_generation", 3)).toBe(120 * 3 * 1000);
    expect(executorTimeoutMs("video_generation", 0)).toBe(300 * 1000);
  });
});
