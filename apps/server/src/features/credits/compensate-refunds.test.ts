import { describe, expect, it, vi } from "vitest";

import {
  REFUND_COMPENSATION_BATCH,
  REFUND_COMPENSATION_EXHAUSTED_LOG,
  compensateRefunds,
  type CompensateRefundsDeps,
  type DueRefundCompensationRow,
} from "./compensate-refunds.js";

/**
 * One compensation pass (workorder 39L, BL-41 step 4).
 *
 * Seven properties, one case each, and each of them is a way this pass could
 * lose or double money:
 *
 *   1. the claim asks for exactly one batch — the pass never decides for itself
 *      how many rows it owns;
 *   2. a successful refund closes the row as done, with the transaction id the
 *      refund answered;
 *   3. the optional link mark runs when the claimed row asks for it;
 *   4. a failing link mark does NOT fail the row — the money is already back;
 *   5. a failing refund closes the row as not ok, carrying the error text;
 *   6. an exhausted row is finished first and then ALERTed with the job id, so
 *      an operator can find what has to be refunded by hand;
 *   7. a row whose writes explode is counted and skipped, and the rows after it
 *      still get their turn.
 *
 * No database and no clock: every collaborator is a plain function double.
 */

const WS = "00000000-0000-0000-0000-0000000391a1";
const USER = "00000000-0000-0000-0000-0000000391a2";
const JOB_1 = "00000000-0000-0000-0000-0000000391b1";
const JOB_2 = "00000000-0000-0000-0000-0000000391b2";
const ID_1 = "00000000-0000-0000-0000-0000000391c1";
const ID_2 = "00000000-0000-0000-0000-0000000391c2";
const TX = "00000000-0000-0000-0000-0000000391d1";

type Harness = {
  deps: CompensateRefundsDeps;
  claimDue: ReturnType<typeof vi.fn<CompensateRefundsDeps["claimDue"]>>;
  refund: ReturnType<typeof vi.fn<CompensateRefundsDeps["refund"]>>;
  finish: ReturnType<typeof vi.fn<CompensateRefundsDeps["finish"]>>;
  markLinkRefunded: ReturnType<
    typeof vi.fn<(input: { jobId: string }) => Promise<unknown>>
  >;
};

function row(
  overrides: Partial<DueRefundCompensationRow> = {},
): DueRefundCompensationRow {
  return {
    id: ID_1,
    jobId: JOB_1,
    workspaceId: WS,
    userId: USER,
    amount: 12,
    description: "refund for job",
    markLinkRefunded: false,
    attempts: 1,
    maxAttempts: 12,
    ...overrides,
  };
}

function harness(
  rows: DueRefundCompensationRow[],
  options: {
    refund?: CompensateRefundsDeps["refund"];
    finish?: CompensateRefundsDeps["finish"];
    markLinkRefunded?: (input: { jobId: string }) => Promise<unknown>;
    log?: (m: string) => void;
  } = {},
): Harness {
  const claimDue = vi.fn<CompensateRefundsDeps["claimDue"]>(async () => rows);
  const refund = vi.fn<CompensateRefundsDeps["refund"]>(
    options.refund ?? (async () => TX),
  );
  const finish = vi.fn<CompensateRefundsDeps["finish"]>(
    options.finish ?? (async () => "done"),
  );
  const markLinkRefunded = vi.fn<(input: { jobId: string }) => Promise<unknown>>(
    options.markLinkRefunded ?? (async () => true),
  );

  const deps: CompensateRefundsDeps = {
    claimDue,
    refund,
    markLinkRefunded,
    finish,
    ...(options.log === undefined ? {} : { log: options.log }),
  };

  return { deps, claimDue, refund, finish, markLinkRefunded };
}

describe("compensateRefunds", () => {
  it("BL-41: claims one batch and nothing more", async () => {
    const { deps, claimDue } = harness([]);

    await expect(compensateRefunds(deps)).resolves.toEqual({
      done: 0,
      failed: 0,
      exhausted: 0,
    });

    expect(claimDue).toHaveBeenCalledTimes(1);
    expect(claimDue).toHaveBeenCalledWith(REFUND_COMPENSATION_BATCH);
  });

  it("BL-41: a successful refund closes the row as done with its transaction id", async () => {
    const { deps, refund, finish } = harness([row()]);

    const result = await compensateRefunds(deps);

    expect(result).toEqual({ done: 1, failed: 0, exhausted: 0 });
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith({
      workspaceId: WS,
      userId: USER,
      amount: 12,
      jobId: JOB_1,
      description: "refund for job",
    });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({
      id: ID_1,
      ok: true,
      refundTransactionId: TX,
      error: null,
    });
  });

  it("BL-41: the link mark runs for a row that asks for it", async () => {
    const { deps, markLinkRefunded } = harness([row({ markLinkRefunded: true })]);

    await compensateRefunds(deps);

    expect(markLinkRefunded).toHaveBeenCalledTimes(1);
    expect(markLinkRefunded).toHaveBeenCalledWith({ jobId: JOB_1 });
  });

  it("BL-41: a row that does not ask for the link mark never marks it", async () => {
    const { deps, markLinkRefunded } = harness([row({ markLinkRefunded: false })]);

    await compensateRefunds(deps);

    expect(markLinkRefunded).not.toHaveBeenCalled();
  });

  it("BL-41: a failing link mark is logged and the row still closes as done", async () => {
    const log = vi.fn<(m: string) => void>();
    const { deps, finish } = harness([row({ markLinkRefunded: true })], {
      markLinkRefunded: async () => {
        throw new Error("mark exploded");
      },
      log,
    });

    const result = await compensateRefunds(deps);

    expect(result).toEqual({ done: 1, failed: 0, exhausted: 0 });
    expect(finish).toHaveBeenCalledWith({
      id: ID_1,
      ok: true,
      refundTransactionId: TX,
      error: null,
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("mark exploded");
  });

  it("BL-41: a failing refund closes the row as not ok with the error text", async () => {
    const { deps, finish } = harness([row()], {
      refund: async () => {
        throw new Error("refund exploded");
      },
      finish: async () => "pending",
    });

    const result = await compensateRefunds(deps);

    expect(result).toEqual({ done: 0, failed: 1, exhausted: 0 });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({
      id: ID_1,
      ok: false,
      refundTransactionId: null,
      error: "refund exploded",
    });
  });

  it("BL-41: an exhausted row is finished, then alerted with its job id", async () => {
    const log = vi.fn<(m: string) => void>();
    const { deps, finish } = harness([row({ attempts: 12 })], {
      refund: async () => {
        throw new Error("still broken");
      },
      finish: async () => "exhausted",
      log,
    });

    const result = await compensateRefunds(deps);

    expect(result).toEqual({ done: 0, failed: 0, exhausted: 1 });
    expect(finish).toHaveBeenCalledWith({
      id: ID_1,
      ok: false,
      refundTransactionId: null,
      error: "still broken",
    });

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line.startsWith(REFUND_COMPENSATION_EXHAUSTED_LOG)).toBe(true);
    expect(line).toContain(`job=${JOB_1}`);
    expect(line).toContain("attempts=12");
  });

  it("BL-41: a row whose own writes explode does not stop the rows after it", async () => {
    const log = vi.fn<(m: string) => void>();
    const { deps, finish } = harness([row(), row({ id: ID_2, jobId: JOB_2 })], {
      refund: async (input) => {
        if (input.jobId === JOB_1) throw new Error("first refund exploded");
        return TX;
      },
      finish: async (input) => {
        if (input.id === ID_1) throw new Error("first finish exploded");
        return "done";
      },
      log,
    });

    const result = await compensateRefunds(deps);

    // The first row could not be closed, so it counts as failed; the second one
    // was still refunded and closed.
    expect(result).toEqual({ done: 1, failed: 1, exhausted: 0 });
    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenLastCalledWith({
      id: ID_2,
      ok: true,
      refundTransactionId: TX,
      error: null,
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("first finish exploded");
  });

  it("BL-41: a throwing logger cannot break the pass", async () => {
    const { deps } = harness([row()], {
      refund: async () => {
        throw new Error("refund exploded");
      },
      log: () => {
        throw new Error("logger exploded");
      },
    });

    await expect(compensateRefunds(deps)).resolves.toEqual({
      done: 0,
      failed: 1,
      exhausted: 0,
    });
  });
});
