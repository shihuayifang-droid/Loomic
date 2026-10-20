/**
 * Reclaiming jobs whose worker died while they were `running` (workorder 36I,
 * GN-31 step 2).
 *
 * Workorder 36H bounded an executor that is still ALIVE: the timer races the work
 * and the terminal failure is written by the process that owns the message. A
 * worker that is KILLED writes nothing at all. The row stays `running`, the
 * visibility timeout expires, the message is delivered again — and the second
 * delivery cannot help: `markRunning` only accepts `queued`/`retrying`, so the
 * message is archived and the row keeps `running` while the credits of that job
 * are never returned. This module is the way out.
 *
 * WHAT ONE PASS DOES
 *
 *   1. coarse filter — one bounded read of `running` jobs started before
 *      `now - <smallest per-attempt budget over every job type>`;
 *   2. per-row precise check — the row's own budget is
 *      `executorTimeoutMs(jobType, maxAttempts)`, which is LARGER for a job that
 *      was granted more attempts or belongs to a slower type. A row the coarse
 *      filter swept up but that has not actually overrun its own budget yet is
 *      skipped, untouched;
 *   3. terminal failure — `markFailed(..., errorCode: "timeout", ...)` moves the
 *      row out of `running`;
 *   4. refund — ONLY when `markFailed` answered `true`, i.e. only when THIS pass
 *      moved the row.
 *
 * WHY THE REFUND IS GATED ON `markFailed`'S ANSWER
 *
 * The acceptance rule is "the reaper refunds a given job once, however often it
 * runs". Two passes (or two reapers) can list the same row before either writes.
 * `markFailed` is a guarded write whose predicate re-checks the status, so the
 * loser answers `false` and refunds nothing: the guard, not this module's
 * bookkeeping, is what makes the refund idempotent. Refunding on `true` and never
 * on `false` is therefore the whole rule, and it stays true if a pass is
 * interrupted between the write and the refund — the row is then already `failed`
 * and outside the reader's population, so no later pass can pay it twice.
 *
 * WHY THE COARSE FILTER IS THE MINIMUM BUDGET
 *
 * The filter must never MISS an overrun, and it cannot know each row's budget
 * before reading it. The smallest budget over all types is a safe lower bound:
 * anything the filter returns may or may not be overrun (step 2 decides), and
 * anything it skips is younger than every possible budget and therefore cannot
 * be overrun. Erring small costs a few extra rows on each pass; erring large
 * would leave the exact population this module exists for.
 *
 * WHY A BAD ROW DOES NOT STOP THE PASS
 *
 * One job whose row has drifted (or whose write fails) must not hold every other
 * stuck job hostage: each row is handled in its own `try`, the failure is logged
 * and the pass continues. A failure of the LIST itself is different — nothing can
 * be decided without it — and is left to the caller.
 *
 * This module never touches a queue, a status other than `running`, or a clock of
 * its own: `now` is injected, so every decision it takes can be replayed.
 */

import type { BackgroundJobType } from "@loomic/shared";

import type {
  JobStuckReaderRepository,
  StuckRunningJob,
} from "../../db/job-stuck-reader-repository.js";
import { JOB_TYPE_REGISTRY } from "./job-registry.js";
import { executorTimeoutMs } from "./process-job-message.js";

/**
 * How many rows one pass may consider.
 *
 * Bounded on purpose: the reader's own ceiling is 500 and a reaper runs on a
 * timer, so a backlog is worked off over several passes instead of one unbounded
 * read. The next pass starts from the oldest row again — which is exactly right,
 * because the rows this pass retired are no longer `running`.
 */
export const REAP_STUCK_JOBS_LIMIT = 100;

/** The error code the reclaimer writes. GN-31 names it verbatim. */
export const STUCK_JOB_ERROR_CODE = "timeout";

/**
 * The message the reclaimer writes. Deliberately distinct from the live-timer
 * message in `processJobMessage` (which names the budget): a reader looking at a
 * failed job should be able to tell "the worker was there and the budget ran out"
 * from "nobody was there and this pass retired it".
 */
export const STUCK_JOB_ERROR_MESSAGE =
  "Job exceeded its execution budget and was reclaimed";

export type ReapStuckJobsDeps = {
  /** The bounded read of `running` rows. See `JobStuckReaderRepository`. */
  listRunningStartedBefore: JobStuckReaderRepository["listRunningStartedBefore"];
  /**
   * The guarded terminal write. `true` means THIS call moved the row, and only
   * then may the job be refunded.
   */
  markFailed: (input: {
    jobId: string;
    errorCode: string;
    errorMessage: string;
    failedAt: string;
  }) => Promise<boolean>;
  /** Refund for a terminally failed job. The worker's implementation never throws. */
  refundJob: (jobId: string) => Promise<void>;
  /** The instant the pass runs at. Injected so a pass can be replayed. */
  now: () => Date;
  /** Where per-row failures are reported. */
  log?: (m: string) => void;
};

/**
 * One reaping pass: fail every job still `running` past its budget as `timeout`,
 * and refund only the rows this pass actually moved.
 *
 * The returned ids are the rows this pass moved, oldest first — the order the
 * reader returned them in. It is a report, not a contract the caller may act on:
 * the refund has already happened inside the pass.
 */
export async function reapStuckJobs(
  deps: ReapStuckJobsDeps,
): Promise<{ reaped: string[] }> {
  const now = deps.now();
  const nowMs = now.getTime();
  const failedAt = now.toISOString();

  // The coarse filter. A row any younger than this cannot be past ANY type's
  // budget, so it is safe to exclude here and decided per row below.
  const before = new Date(nowMs - smallestAttemptBudgetMs()).toISOString();

  const rows = await deps.listRunningStartedBefore({
    before,
    limit: REAP_STUCK_JOBS_LIMIT,
  });

  const reaped: string[] = [];

  for (const row of rows) {
    try {
      if (!isPastItsBudget(row, nowMs)) continue;

      const moved = await deps.markFailed({
        jobId: row.id,
        errorCode: STUCK_JOB_ERROR_CODE,
        errorMessage: STUCK_JOB_ERROR_MESSAGE,
        failedAt,
      });

      // `false` = a concurrent pass (or a cancel) got there first. The money is
      // the point: refunding here would pay the job twice.
      if (!moved) continue;

      await deps.refundJob(row.id);
      reaped.push(row.id);
    } catch (error) {
      // One bad row must not stop the pass: the remaining rows are independent
      // jobs, each with its own row and its own refund.
      deps.log?.(
        `Stuck job reaper skipped job ${row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { reaped };
}

/**
 * The smallest budget any single attempt can have, in milliseconds.
 *
 * `executorTimeoutMs(jobType, 1)` is the budget of a job with ONE attempt left —
 * the smallest budget a registered type can grant. Taking the minimum over the
 * registry (rather than a hardcoded number) keeps this bound true when a type is
 * added or a visibility timeout changes: a new type with a shorter VT would
 * otherwise be invisible to the filter.
 */
function smallestAttemptBudgetMs(): number {
  const types = Object.keys(JOB_TYPE_REGISTRY) as BackgroundJobType[];

  return Math.min(...types.map((jobType) => executorTimeoutMs(jobType, 1)));
}

/**
 * Whether this row has really overrun its OWN budget.
 *
 * The row's budget depends on its type and on the attempts it was granted, so it
 * is computed per row rather than assumed from the coarse filter (which used the
 * smallest budget of all). A row whose `startedAt` cannot be read is NOT retired:
 * an unreadable instant is drift, and guessing "long ago" would refund a job that
 * may still be running.
 */
function isPastItsBudget(row: StuckRunningJob, nowMs: number): boolean {
  const startedMs = Date.parse(row.startedAt);
  if (!Number.isFinite(startedMs)) return false;

  return nowMs - startedMs >= executorTimeoutMs(row.jobType, row.maxAttempts);
}
