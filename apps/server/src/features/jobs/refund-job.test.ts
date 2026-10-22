import { describe, expect, it, vi } from "vitest";

import type { JobRefundBasisRow } from "../../db/job-refund-basis-repository.js";
import { REFUND_DESCRIPTION, createRefundJob } from "./refund-job.js";

/**
 * The refund decision (workorder 21O) — the money branches, one case each.
 *
 * This module was extracted from `worker.ts` precisely so that the conditions,
 * the amount, the description and the "never throws" contract can be pinned here
 * instead of being read off a worker process. Every branch below asserts the
 * COUNT of `refundCredits` calls as well as the arguments: a refund that happens
 * when it should not, or twice when it should happen once, is the defect this
 * file exists to catch.
 *
 * No database is involved. The read is a plain function, so a case can make it
 * answer a row, answer `null` or throw — which is exactly the three shapes the
 * refund path has to survive.
 */

const JOB_ID = "00000000-0000-0000-0000-0000000020a0";
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000020b0";
const USER_ID = "00000000-0000-0000-0000-0000000020c0";
const TX_ID = "tx-0000-0000-0000-0000-0000000020f0";
const TAG = "[worker:test]";

/** A complete basis, as the repository reports it for a charged job. */
function basis(overrides: Partial<JobRefundBasisRow> = {}): JobRefundBasisRow {
  return {
    creditsCost: 10,
    workspaceId: WORKSPACE_ID,
    createdBy: USER_ID,
    ...overrides,
  };
}

type Harness = {
  refundJob: (jobId: string, tag: string) => Promise<void>;
  refundCredits: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
  readRefundBasis: ReturnType<typeof vi.fn>;
};

/**
 * The module with every collaborator replaced by a recorder. `refundCredits`
 * resolves a transaction id, `log`/`logError` record their arguments, and the
 * reader answers `answer` — a row, `null` or a thrown error.
 */
function createHarness(
  answer: JobRefundBasisRow | null | Error,
): Harness {
  const readRefundBasis = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const refundCredits = vi.fn(async (..._args: unknown[]) => TX_ID);
  const log = vi.fn();
  const logError = vi.fn();

  const refundJob = createRefundJob({
    readRefundBasis,
    creditService: { refundCredits },
    log,
    logError,
  });

  return { refundJob, refundCredits, log, logError, readRefundBasis };
}

describe("refund-job: the charged job that is refunded", () => {
  it("case 1: refunds once, with the verbatim argument list", async () => {
    const harness = createHarness(basis());

    await expect(harness.refundJob(JOB_ID, TAG)).resolves.toBeUndefined();

    expect(harness.refundCredits).toHaveBeenCalledTimes(1);
    expect(harness.refundCredits).toHaveBeenCalledWith(
      WORKSPACE_ID,
      USER_ID,
      10,
      JOB_ID,
      "Auto-refund: job failed",
    );
    // The raw tuple too: it pins the ARITY, so a stray extra argument cannot
    // pass by matching the first five.
    expect(harness.refundCredits.mock.calls[0]).toEqual([
      WORKSPACE_ID,
      USER_ID,
      10,
      JOB_ID,
      "Auto-refund: job failed",
    ]);
  });

  it("case 2: the success log is the verbatim line the worker always wrote", async () => {
    const harness = createHarness(basis());

    await harness.refundJob(JOB_ID, TAG);

    expect(harness.log).toHaveBeenCalledTimes(1);
    expect(harness.log).toHaveBeenCalledWith(
      `${TAG} Refunded 10 credits for job ${JOB_ID} (tx: ${TX_ID})`,
    );
    // The tag comes from the caller, not from the module: two workers must stay
    // distinguishable in one log file.
    expect(harness.log.mock.calls[0]?.[0]).toContain(TAG);
    // Nothing failed, so nothing is reported as a failure.
    expect(harness.logError).not.toHaveBeenCalled();
  });

  it("case 3: the description is the exported constant and the exact literal", () => {
    // A ledger line a user reads. This is the one string in the module that is
    // quoted in the workorder character for character.
    expect(REFUND_DESCRIPTION).toBe("Auto-refund: job failed");
  });

  it("case 4: the reader is called once, with the job id named 'jobId'", async () => {
    const harness = createHarness(basis());

    await harness.refundJob(JOB_ID, TAG);

    expect(harness.readRefundBasis).toHaveBeenCalledTimes(1);
    expect(harness.readRefundBasis.mock.calls[0]).toEqual([{ jobId: JOB_ID }]);
  });

  it("case 5: a cost of 1 is refunded — the boundary of the refusal is <= 0", async () => {
    const harness = createHarness(basis({ creditsCost: 1 }));

    await harness.refundJob(JOB_ID, TAG);

    expect(harness.refundCredits).toHaveBeenCalledTimes(1);
    expect(harness.refundCredits.mock.calls[0]).toEqual([
      WORKSPACE_ID,
      USER_ID,
      1,
      JOB_ID,
      "Auto-refund: job failed",
    ]);
  });

  it("case 6: a custom tag reaches both log lines unchanged", async () => {
    const harness = createHarness(basis());

    await harness.refundJob(JOB_ID, "CUSTOM");

    expect(harness.log.mock.calls[0]?.[0]).toBe(
      `CUSTOM Refunded 10 credits for job ${JOB_ID} (tx: ${TX_ID})`,
    );

    const failing = createHarness(new Error("read exploded"));
    await failing.refundJob(JOB_ID, "CUSTOM");
    expect(failing.logError.mock.calls[0]?.[0]).toBe(
      `CUSTOM Failed to refund credits for job ${JOB_ID}:`,
    );
  });
});

describe("refund-job: the cases that must NOT refund", () => {
  const notRefunded: Array<[string, JobRefundBasisRow | null]> = [
    ["a cost of 0", basis({ creditsCost: 0 })],
    ["a NULL cost", basis({ creditsCost: null })],
    ["a negative cost", basis({ creditsCost: -5 })],
    ["no creator (a historic row)", basis({ createdBy: null })],
    ["an empty creator", basis({ createdBy: "" })],
    ["an empty workspace", basis({ workspaceId: "" })],
    ["no basis at all (no such job)", null],
  ];

  it("case 7: every one of them calls refundCredits zero times and logs nothing", async () => {
    for (const [label, answer] of notRefunded) {
      const harness = createHarness(answer);

      await expect(harness.refundJob(JOB_ID, TAG)).resolves.toBeUndefined();

      expect([label, harness.refundCredits.mock.calls.length]).toEqual([label, 0]);
      // Silent on purpose: this is the displaced behaviour, and a "nothing to
      // refund" line on every uncharged job would drown the log.
      expect([label, harness.log.mock.calls.length]).toEqual([label, 0]);
      expect([label, harness.logError.mock.calls.length]).toEqual([label, 0]);
    }
  });

  it("case 8: a NULL cost is refused by the same <= 0 rule, not by a special case", async () => {
    // The `?? 0` must happen BEFORE the guard: if NULL reached the comparison
    // unfixed it would be `null <= 0` — true in JavaScript, but only by
    // accident of coercion, and `null` would reach the ledger if the guard ever
    // moved. This case pins `creditsCost: null` to the same refusal as 0.
    const asNull = createHarness(basis({ creditsCost: null }));
    const asZero = createHarness(basis({ creditsCost: 0 }));

    await asNull.refundJob(JOB_ID, TAG);
    await asZero.refundJob(JOB_ID, TAG);

    expect(asNull.refundCredits).not.toHaveBeenCalled();
    expect(asZero.refundCredits).not.toHaveBeenCalled();
    expect(asNull.logError).not.toHaveBeenCalled();
    expect(asZero.logError).not.toHaveBeenCalled();
  });

  it("case 9: a missing creator is the historic-row rule and is never a refund", async () => {
    // `created_by` is nullable for historic rows, and the credits rule needs a
    // user to credit. Refunding with a fabricated user would credit the wrong
    // account, so the guard stays and this case keeps it honest.
    const harness = createHarness(basis({ createdBy: null }));

    await expect(harness.refundJob(JOB_ID, TAG)).resolves.toBeUndefined();

    expect(harness.refundCredits).not.toHaveBeenCalled();
    expect(harness.log).not.toHaveBeenCalled();
    expect(harness.logError).not.toHaveBeenCalled();
  });
});

describe("refund-job: the failing read and the failing refund", () => {
  it("case 10: a read that throws refunds nothing, reports it once, and resolves", async () => {
    const failure = new Error("connection terminated unexpectedly");
    const harness = createHarness(failure);

    await expect(harness.refundJob(JOB_ID, TAG)).resolves.toBeUndefined();

    expect(harness.refundCredits).not.toHaveBeenCalled();
    expect(harness.log).not.toHaveBeenCalled();
    expect(harness.logError).toHaveBeenCalledTimes(1);
    expect(harness.logError).toHaveBeenCalledWith(
      `${TAG} Failed to refund credits for job ${JOB_ID}:`,
      failure,
    );
    // The error OBJECT, not its message: the same line a failed refund writes,
    // and the reason travels with it for a reader who wants to classify it.
    expect(harness.logError.mock.calls[0]?.[1]).toBe(failure);
    // No retry: the read is attempted exactly once.
    expect(harness.readRefundBasis).toHaveBeenCalledTimes(1);
  });

  it("case 11: a refund that throws is reported once and resolves", async () => {
    const failure = new Error("RPC refund_credits failed");
    const harness = createHarness(basis());
    harness.refundCredits.mockRejectedValueOnce(failure);

    await expect(harness.refundJob(JOB_ID, TAG)).resolves.toBeUndefined();

    expect(harness.refundCredits).toHaveBeenCalledTimes(1);
    expect(harness.logError).toHaveBeenCalledTimes(1);
    expect(harness.logError).toHaveBeenCalledWith(
      `${TAG} Failed to refund credits for job ${JOB_ID}:`,
      failure,
    );
    // The success line is not written when the refund failed.
    expect(harness.log).not.toHaveBeenCalled();
  });

  it("case 12: a failed refund is NOT retried (idempotency belongs to T-40)", async () => {
    const harness = createHarness(basis());
    harness.refundCredits.mockRejectedValue(new Error("still failing"));

    await harness.refundJob(JOB_ID, TAG);

    // One attempt, one failure line. A retry here would refund twice the moment
    // the first attempt actually succeeded on the server and only the response
    // was lost.
    expect(harness.refundCredits).toHaveBeenCalledTimes(1);
    expect(harness.logError).toHaveBeenCalledTimes(1);
    expect(harness.readRefundBasis).toHaveBeenCalledTimes(1);
  });

  it("case 13: two calls refund twice — no de-duplication by job id lives here", async () => {
    const harness = createHarness(basis());

    await harness.refundJob(JOB_ID, TAG);
    await harness.refundJob(JOB_ID, TAG);

    // "At most one refund per job" is owned by `processJobMessage` (`markFailed`
    // must have moved the row) and by T-40 for a durable rule. Claiming it here
    // would silently move that ownership into a module that cannot see the job
    // status, so the module stays a pure function of what it is told.
    expect(harness.refundCredits).toHaveBeenCalledTimes(2);
  });
});

describe("refund-job: the contract every branch keeps", () => {
  it("case 14: no branch ever rejects", async () => {
    const branches: Array<[string, JobRefundBasisRow | null | Error, Error?]> = [
      ["charged", basis()],
      ["free", basis({ creditsCost: 0 })],
      ["null cost", basis({ creditsCost: null })],
      ["negative cost", basis({ creditsCost: -1 })],
      ["no creator", basis({ createdBy: null })],
      ["no workspace", basis({ workspaceId: "" })],
      ["no row", null],
      ["read failed", new Error("read failed")],
      ["refund failed", basis(), new Error("refund failed")],
    ];

    for (const [label, answer, refundFailure] of branches) {
      const harness = createHarness(answer);
      if (refundFailure) harness.refundCredits.mockRejectedValue(refundFailure);

      // `processJobMessage` archives the message after this call; a rejection
      // here would be the one thing the displaced contract never did.
      await expect(harness.refundJob(JOB_ID, TAG)).resolves.toBeUndefined();
      expect([label, harness.refundCredits.mock.calls.length <= 1]).toEqual([
        label,
        true,
      ]);
    }
  });

  it("case 15: the returned function takes (jobId, tag) and is built per dependency set", () => {
    const harness = createHarness(basis());

    // The worker passes `(jobId) => refundJob(jobId, tag)`: the tag is bound at
    // the call site, so the module's own arity must be exactly two.
    expect(harness.refundJob).toHaveLength(2);
    expect(typeof harness.refundJob).toBe("function");
  });

  it("case 16: without injected loggers the module writes to console", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const refundCredits = vi.fn(async (..._args: unknown[]) => TX_ID);
      const charged = createRefundJob({
        readRefundBasis: async () => basis(),
        creditService: { refundCredits },
      });
      await charged(JOB_ID, TAG);

      expect(logSpy).toHaveBeenCalledWith(
        `${TAG} Refunded 10 credits for job ${JOB_ID} (tx: ${TX_ID})`,
      );
      expect(errorSpy).not.toHaveBeenCalled();

      const failure = new Error("boom");
      const failing = createRefundJob({
        readRefundBasis: async () => {
          throw failure;
        },
        creditService: { refundCredits },
      });
      await expect(failing(JOB_ID, TAG)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        `${TAG} Failed to refund credits for job ${JOB_ID}:`,
        failure,
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("case 17: an injected logger pair replaces the console entirely", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const harness = createHarness(new Error("read failed"));

      await harness.refundJob(JOB_ID, TAG);

      // Injected loggers mean the console is untouched on both paths — otherwise
      // a worker log and a test log would both carry the same line.
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(harness.logError).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

/**
 * BL-41 / workorder 39K: a refund that FAILS is recorded for the compensation
 * queue instead of surviving only as a log line.
 *
 * Four cases, one per branch: recorded, recording failed, refund succeeded, and
 * the read that never learned the amount. The last two are the guard — a
 * compensation row written when nothing is owed would be a debt that is not one.
 */
describe("refund-job: BL-41 a failed refund is recorded for compensation", () => {
  type CompensationInput = {
    jobId: string;
    workspaceId: string;
    userId: string;
    amount: number;
    description: string;
    error: string;
  };

  function createRecordingHarness(answer: JobRefundBasisRow | null | Error) {
    const readRefundBasis = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const refundCredits = vi.fn(async (..._args: unknown[]) => TX_ID);
    const recordCompensation = vi.fn(async (_input: CompensationInput) => {});
    const log = vi.fn();
    const logError = vi.fn();

    const refundJob = createRefundJob({
      readRefundBasis,
      creditService: { refundCredits },
      recordCompensation,
      log,
      logError,
    });

    return { refundJob, refundCredits, recordCompensation, log, logError };
  }

  it("BL-41: a failed refund is recorded for compensation", async () => {
    const failure = new Error("RPC refund_credits failed");
    const harness = createRecordingHarness(basis());
    harness.refundCredits.mockRejectedValueOnce(failure);

    await expect(harness.refundJob(JOB_ID, TAG)).resolves.toBeUndefined();

    // The pre-39K line is still written, verbatim and first.
    expect(harness.logError.mock.calls[0]?.[0]).toBe(
      `${TAG} Failed to refund credits for job ${JOB_ID}:`,
    );
    expect(harness.logError.mock.calls[0]?.[1]).toBe(failure);
    expect(harness.recordCompensation).toHaveBeenCalledTimes(1);
    expect(harness.recordCompensation.mock.calls[0]?.length).toBe(1);
    expect(harness.recordCompensation.mock.calls[0]?.[0]).toEqual({
      jobId: JOB_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      amount: 10,
      description: "Auto-refund: job failed",
      error: "RPC refund_credits failed",
    });
    // The success line is not written when the refund failed.
    expect(harness.log).not.toHaveBeenCalled();
  });

  it("BL-41: a failed record is logged and still resolves", async () => {
    const recordFailure = new Error("record_refund_compensation failed");
    const harness = createRecordingHarness(basis());
    harness.refundCredits.mockRejectedValueOnce(new Error("refund rpc down"));
    harness.recordCompensation.mockRejectedValueOnce(recordFailure);

    await expect(harness.refundJob(JOB_ID, TAG)).resolves.toBeUndefined();

    expect(harness.recordCompensation).toHaveBeenCalledTimes(1);
    // Two lines: the refund failure, then the recording failure — the second one
    // names its own cause so a reader never mistakes it for a refund problem.
    expect(harness.logError).toHaveBeenCalledTimes(2);
    expect(harness.logError.mock.calls[1]?.[0]).toBe(
      `${TAG} Failed to record refund compensation for job ${JOB_ID}:`,
    );
    expect(harness.logError.mock.calls[1]?.[1]).toBe(recordFailure);
  });

  it("BL-41: a refund that succeeds records nothing", async () => {
    const harness = createRecordingHarness(basis());

    await expect(harness.refundJob(JOB_ID, TAG)).resolves.toBeUndefined();

    expect(harness.refundCredits).toHaveBeenCalledTimes(1);
    expect(harness.recordCompensation).not.toHaveBeenCalled();
    expect(harness.logError).not.toHaveBeenCalled();
  });

  it("BL-41: a failed basis read records nothing", async () => {
    // The amount is unknown, so there is nothing to record as owed. The read
    // failure keeps its own pre-39K log line and nothing else happens.
    const readFailure = new Error("connection terminated unexpectedly");
    const harness = createRecordingHarness(readFailure);

    await expect(harness.refundJob(JOB_ID, TAG)).resolves.toBeUndefined();

    expect(harness.recordCompensation).not.toHaveBeenCalled();
    expect(harness.logError).toHaveBeenCalledTimes(1);
    expect(harness.logError.mock.calls[0]?.[0]).toBe(
      `${TAG} Failed to refund credits for job ${JOB_ID}:`,
    );
    expect(harness.logError.mock.calls[0]?.[1]).toBe(readFailure);
  });
});

// BL-41 / workorder 39M：取消退款的描述逐字不变。它现在由 shared 的前缀拼出，
// 两边（shared 的判定与 server 的写入）因此不会各自漂移。
// 追加在这里而不是改写顶部 import：本单对测试文件只允许追加。
import { CANCEL_REFUND_DESCRIPTION } from "./refund-job.js";

describe("BL-41 the cancel refund description", () => {
  it("BL-41: the cancel description keeps its exact text", () => {
    expect(CANCEL_REFUND_DESCRIPTION).toBe(
      "Auto-refund: job canceled before start",
    );
  });
});
