import { describe, expect, it, vi } from "vitest";

import type { StuckRunningJob } from "../../db/job-stuck-reader-repository.js";
import {
  REAP_STUCK_JOBS_LIMIT,
  STUCK_JOB_ERROR_CODE,
  STUCK_JOB_ERROR_MESSAGE,
  reapStuckJobs,
} from "./reap-stuck-jobs.js";

/**
 * The stuck-job reaper (workorder 36I, GN-31).
 *
 * Five properties, one case each, and every one of them is about MONEY or about
 * NOT touching a healthy job:
 *
 *   1. a row past its own budget is failed as `timeout` and refunded;
 *   2. a row inside its budget is left completely alone — no write, no refund.
 *      Its `started_at` is past the coarse filter on purpose: this case is the
 *      one that proves the per-row precise check exists, because the minimal
 *      filter alone would have swept it up;
 *   3. running the reaper twice refunds once — the second pass's guarded write
 *      answers `false`, and `false` means "someone else already moved this row";
 *   4. one bad row does not stop the pass: the second job is still reaped;
 *   5. the coarse filter asks for jobs older than the SMALLEST budget over all
 *      job types (`image_generation`'s 120s visibility timeout × 1 attempt), not
 *      for the budget of whichever type happens to come first.
 *
 * No database, no timer, no queue: the reader, the guarded write, the refund and
 * the clock are all plain functions, so each case can make one of them answer
 * exactly what it needs to. `now` is fixed for every case, so the instants below
 * are arithmetic rather than the wall clock.
 */

/** The instant every case runs at. Fixed, so the budget arithmetic is exact. */
const NOW = new Date("2026-05-01T12:00:00.000Z");
const MILLIS_PER_SECOND = 1000;

const FIRST_JOB_ID = "00000000-0000-0000-0000-0000000036a1";
const SECOND_JOB_ID = "00000000-0000-0000-0000-0000000036a2";

type ListInput = { before: string; limit: number };
type MarkFailedInput = {
  jobId: string;
  errorCode: string;
  errorMessage: string;
  failedAt: string;
};

/** An ISO instant that many seconds before the fixed `now`. */
function secondsBeforeNow(seconds: number): string {
  return new Date(NOW.getTime() - seconds * MILLIS_PER_SECOND).toISOString();
}

/** One stuck-row candidate, defaulted to the image job the cases care about. */
function runningJob(
  overrides: Partial<StuckRunningJob> & { id: string },
): StuckRunningJob {
  return {
    jobType: "image_generation",
    startedAt: secondsBeforeNow(361),
    maxAttempts: 3,
    ...overrides,
  };
}

/**
 * The four collaborators, each a spy answering the happy path.
 *
 * `markFailed` answers `true` by default: "this call moved the row", which is
 * the only answer that permits a refund. A case that wants the losing side of a
 * race overrides it per call.
 */
function harness(rows: StuckRunningJob[]) {
  const listRunningStartedBefore = vi.fn<
    (input: ListInput) => Promise<StuckRunningJob[]>
  >(async () => rows);
  const markFailed = vi.fn<(input: MarkFailedInput) => Promise<boolean>>(
    async () => true,
  );
  const refundJob = vi.fn<(jobId: string) => Promise<void>>(async () => {});
  const log = vi.fn<(m: string) => void>(() => {});

  return {
    deps: {
      listRunningStartedBefore,
      markFailed,
      refundJob,
      now: () => NOW,
      log,
    },
    listRunningStartedBefore,
    markFailed,
    refundJob,
    log,
  };
}

describe("GN-31: reclaiming jobs whose worker died while running", () => {
  it("GN-31: a job running past its budget is failed as timeout and refunded", async () => {
    // image_generation: 120s visibility timeout × 3 attempts = 360s. 361s is one
    // second past it, which is the whole reason this row is stuck.
    const stuck = runningJob({ id: FIRST_JOB_ID, startedAt: secondsBeforeNow(361) });
    const { deps, markFailed, refundJob } = harness([stuck]);

    const result = await reapStuckJobs(deps);

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed.mock.calls[0]?.[0]).toEqual({
      jobId: FIRST_JOB_ID,
      errorCode: STUCK_JOB_ERROR_CODE,
      errorMessage: STUCK_JOB_ERROR_MESSAGE,
      failedAt: NOW.toISOString(),
    });

    expect(refundJob).toHaveBeenCalledTimes(1);
    expect(refundJob).toHaveBeenCalledWith(FIRST_JOB_ID);

    expect(result.reaped).toEqual([FIRST_JOB_ID]);
  });

  it("GN-31: a job still within its budget is left alone", async () => {
    // 300s < 360s, yet 300s is past the 120s coarse filter: only the per-row
    // precise check can keep this job alive.
    const fresh = runningJob({ id: FIRST_JOB_ID, startedAt: secondsBeforeNow(300) });
    const { deps, markFailed, refundJob } = harness([fresh]);

    const result = await reapStuckJobs(deps);

    expect(markFailed).not.toHaveBeenCalled();
    expect(refundJob).not.toHaveBeenCalled();
    expect(result.reaped).toEqual([]);
  });

  it("GN-31: running the reaper twice refunds once", async () => {
    const stuck = runningJob({ id: FIRST_JOB_ID });
    const { deps, markFailed, refundJob } = harness([stuck]);

    // First pass moves the row; the second pass finds the same row in its list
    // (it was listed before the first pass wrote) and loses the guarded write.
    markFailed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const first = await reapStuckJobs(deps);
    const second = await reapStuckJobs(deps);

    expect(markFailed).toHaveBeenCalledTimes(2);
    expect(refundJob).toHaveBeenCalledTimes(1);
    expect(first.reaped).toEqual([FIRST_JOB_ID]);
    expect(second.reaped).toEqual([]);
  });

  it("GN-31: one bad row does not stop the pass", async () => {
    const bad = runningJob({ id: FIRST_JOB_ID });
    const good = runningJob({ id: SECOND_JOB_ID });
    const { deps, markFailed, refundJob, log } = harness([bad, good]);

    markFailed.mockRejectedValueOnce(new Error("row is gone")).mockResolvedValueOnce(true);

    const result = await reapStuckJobs(deps);

    expect(markFailed).toHaveBeenCalledTimes(2);
    expect(markFailed.mock.calls[1]?.[0]?.jobId).toBe(SECOND_JOB_ID);
    expect(refundJob).toHaveBeenCalledTimes(1);
    expect(refundJob).toHaveBeenCalledWith(SECOND_JOB_ID);
    expect(result.reaped).toEqual([SECOND_JOB_ID]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("GN-31: the coarse filter asks for jobs older than the smallest budget", async () => {
    const { deps, listRunningStartedBefore } = harness([]);

    await reapStuckJobs(deps);

    expect(listRunningStartedBefore).toHaveBeenCalledTimes(1);
    expect(listRunningStartedBefore.mock.calls[0]?.[0]).toEqual({
      // image_generation is the shortest: 120s × 1 attempt.
      before: secondsBeforeNow(120),
      limit: REAP_STUCK_JOBS_LIMIT,
    });
  });
});
