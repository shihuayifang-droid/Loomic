import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REFUND_COMPENSATION_INTERVAL_MS,
  startRefundCompensator,
} from "./refund-compensation-schedule.js";

/**
 * The timer around the refund compensator (workorder 39L, BL-41 step 4).
 *
 * Five properties, one case each, and each of them is a way the schedule could
 * quietly stop paying refunds back:
 *
 *   1. it runs at start — a restart retries the rows its previous life left
 *      pending, instead of waiting a whole interval;
 *   2. it then runs every five minutes, and five minutes is 300000 ms, not a
 *      "roughly five minutes" that a later reader has to guess at;
 *   3. a tick that lands while a pass is still in flight is skipped — two passes
 *      over one population are two writers racing for one payout;
 *   4. a pass that rejects is logged and the schedule keeps its rhythm;
 *   5. `stop()` ends it, so shutdown does not leave a timer behind the process.
 *
 * No database and no real clock: `compensate` is a plain function and the timers
 * are the fake ones, so "five minutes" here is an exact number of milliseconds.
 */

type Compensate = () => Promise<unknown>;

let compensate: ReturnType<typeof vi.fn<Compensate>>;

beforeEach(() => {
  vi.useFakeTimers();
  compensate = vi.fn<Compensate>(async () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the immediate first pass get as far as its `await`. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Advance the fake clock by `ms` and flush everything the timers started. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushMicrotasks();
}

describe("startRefundCompensator", () => {
  it("BL-41: the compensator runs once at start", async () => {
    const { stop } = startRefundCompensator({ compensate });

    await flushMicrotasks();

    expect(compensate).toHaveBeenCalledTimes(1);

    stop();
  });

  it("BL-41: then every five minutes", async () => {
    expect(REFUND_COMPENSATION_INTERVAL_MS).toBe(300000);

    const { stop } = startRefundCompensator({ compensate });

    await flushMicrotasks();
    await advance(REFUND_COMPENSATION_INTERVAL_MS * 2);

    // one at start + one per interval
    expect(compensate).toHaveBeenCalledTimes(3);

    stop();
  });

  it("BL-41: an overlapping tick is skipped", async () => {
    // This pass never settles, so every tick during it lands "in flight".
    compensate.mockImplementation(() => new Promise(() => undefined));

    const { stop } = startRefundCompensator({ compensate });

    await flushMicrotasks();
    await advance(REFUND_COMPENSATION_INTERVAL_MS * 2);

    expect(compensate).toHaveBeenCalledTimes(1);

    stop();
  });

  it("BL-41: a failing pass does not stop the schedule", async () => {
    compensate.mockImplementationOnce(async () => {
      throw new Error("pass 1 exploded");
    });
    const log = vi.fn<(m: string) => void>();

    const { stop } = startRefundCompensator({ compensate, log });

    await flushMicrotasks();
    expect(compensate).toHaveBeenCalledTimes(1);

    await advance(REFUND_COMPENSATION_INTERVAL_MS);

    // The failure was reported, and the next tick still ran.
    expect(log).toHaveBeenCalledTimes(1);
    expect(compensate).toHaveBeenCalledTimes(2);

    stop();
  });

  it("BL-41: stop ends the schedule", async () => {
    const { stop } = startRefundCompensator({ compensate });

    await flushMicrotasks();
    expect(compensate).toHaveBeenCalledTimes(1);

    stop();

    await advance(REFUND_COMPENSATION_INTERVAL_MS * 2);
    expect(compensate).toHaveBeenCalledTimes(1);
  });
});
