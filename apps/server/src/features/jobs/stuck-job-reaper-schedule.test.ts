import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STUCK_JOB_REAP_INTERVAL_MS,
  startStuckJobReaper,
} from "./stuck-job-reaper-schedule.js";

/**
 * The timer around the stuck-job reaper (workorder 36J, GN-31).
 *
 * Five properties, one case each, and each of them is a way the schedule could
 * quietly stop reclaiming money:
 *
 *   1. it runs at start — a restart reclaims what its previous life left
 *      `running`, instead of waiting a whole interval;
 *   2. it then runs every five minutes, and five minutes is 300000 ms, not a
 *      "roughly five minutes" that a later reader has to guess at;
 *   3. a tick that lands while a pass is still in flight is skipped — two passes
 *      over one population are two writers racing for one refund;
 *   4. a pass that rejects is logged and the schedule keeps its rhythm;
 *   5. `stop()` ends it, so shutdown does not leave a timer behind the process.
 *
 * No database and no real clock: `reap` is a plain function and the timers are
 * the fake ones, so "five minutes" here is an exact number of milliseconds.
 */

type Reap = () => Promise<unknown>;

let reap: ReturnType<typeof vi.fn<Reap>>;

beforeEach(() => {
  vi.useFakeTimers();
  reap = vi.fn<Reap>(async () => undefined);
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

describe("startStuckJobReaper", () => {
  it("GN-31: the reaper runs once at start", async () => {
    const { stop } = startStuckJobReaper({ reap });

    await flushMicrotasks();

    expect(reap).toHaveBeenCalledTimes(1);

    stop();
  });

  it("GN-31: then every five minutes", async () => {
    expect(STUCK_JOB_REAP_INTERVAL_MS).toBe(300000);

    const { stop } = startStuckJobReaper({ reap });

    await flushMicrotasks();
    await advance(STUCK_JOB_REAP_INTERVAL_MS * 2);

    // one at start + one per interval
    expect(reap).toHaveBeenCalledTimes(3);

    stop();
  });

  it("GN-31: an overlapping tick is skipped", async () => {
    // This pass never settles, so every tick during it lands "in flight".
    reap.mockImplementation(() => new Promise(() => undefined));

    const { stop } = startStuckJobReaper({ reap });

    await flushMicrotasks();
    await advance(STUCK_JOB_REAP_INTERVAL_MS * 2);

    expect(reap).toHaveBeenCalledTimes(1);

    stop();
  });

  it("GN-31: a failing pass does not stop the schedule", async () => {
    reap.mockImplementationOnce(async () => {
      throw new Error("pass 1 exploded");
    });
    const log = vi.fn<(m: string) => void>();

    const { stop } = startStuckJobReaper({ reap, log });

    await flushMicrotasks();
    expect(reap).toHaveBeenCalledTimes(1);

    await advance(STUCK_JOB_REAP_INTERVAL_MS);

    // The failure was reported, and the next tick still ran.
    expect(log).toHaveBeenCalledTimes(1);
    expect(reap).toHaveBeenCalledTimes(2);

    stop();
  });

  it("GN-31: stop ends the schedule", async () => {
    const { stop } = startStuckJobReaper({ reap });

    await flushMicrotasks();
    expect(reap).toHaveBeenCalledTimes(1);

    stop();

    await advance(STUCK_JOB_REAP_INTERVAL_MS * 2);
    expect(reap).toHaveBeenCalledTimes(1);
  });
});
