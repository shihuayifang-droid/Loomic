/**
 * Stuck running job reader (workorder 36I, GN-31 step 2).
 *
 * One read moves here: the list a reaper needs before it can retire a job whose
 * worker died. Workorder 36H bounded an executor that is still ALIVE — the timer
 * races the work and the terminal failure is written from the same process. A
 * worker that is killed mid-job writes nothing at all, so its row stays `running`
 * forever and the credits of that job are never returned. This module is how that
 * population is found again.
 *
 * Rules this module keeps:
 *
 * - `listRunningStartedBefore` is the entire interface. There is no access
 *   token, no job type, no workspace, no arbitrary predicate object and no column
 *   list, so a caller cannot widen the read. The two things it may say are the
 *   threshold (`before`) and the page size (`limit`).
 * - The statement selects `id, job_type, started_at, max_attempts` — the four
 *   columns the reaper's own decision reads, and nothing else. `started_at` is
 *   the instant the budget is measured from; `max_attempts` is part of the budget
 *   (`executorTimeoutMs` multiplies by it), so both must be reported verbatim
 *   rather than recomputed here.
 * - `where status = 'running'` is fixed text, not a parameter: this module can
 *   never return a queued, retrying, succeeded or failed row. `started_at <
 *   $1::timestamptz` is a bind parameter with an explicit cast, so a malformed
 *   threshold fails as a real SQL error instead of silently matching something
 *   else. Rows with a NULL `started_at` are excluded by the comparison itself,
 *   which is correct: a row that never started cannot be overrun.
 * - `order by started_at` plus a bounded `limit` (1..500) makes the scan finite
 *   and stable: the oldest overruns are retired first, and a pathological backlog
 *   cannot turn one pass into an unbounded read.
 * - The statement runs through workorder 19's transaction entry point in
 *   `privileged` mode with a NULL actor. This is a system read — the reaper is
 *   not acting as any user — and forging an actor would put a person's id on an
 *   audit trail they had nothing to do with.
 * - Zero rows is a LEGAL answer and is reported as an empty array, not an error:
 *   "nothing is stuck" is the normal case, and turning it into a failure would
 *   make every healthy pass log a problem.
 * - A connect, SQL or row-shape failure throws `JobStuckReaderError`, whose own
 *   message is fixed text: no SQL, no host, no connection string, no job id. The
 *   driver's own error rides along as `cause` so a caller can classify it without
 *   the driver's message reaching a log line.
 * - Bad ARGUMENTS are refused before a connection is opened and are reported
 *   through the same error class: a `limit` outside 1..500 or a `before` that is
 *   not a timestamp is a caller bug, and silently clamping either one would hide
 *   it.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a failure on the read, never a silent fallback: with no
 *   repository wired the reaper fails and retires nothing, which is the safe
 *   direction — it never moves a job (or money) on a guess.
 */

import type { BackgroundJobType } from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * One `running` job that started before the requested threshold.
 *
 * `startedAt` is an ISO-8601 string, the same shape `markRunning` writes and
 * `markFailed` accepts, so the reaper can compare instants without re-parsing a
 * driver-specific date. `maxAttempts` is the job's own attempt budget, which the
 * per-job execution budget multiplies by.
 */
export type StuckRunningJob = {
  id: string;
  jobType: BackgroundJobType;
  startedAt: string;
  maxAttempts: number;
};

export type JobStuckReaderRepository = {
  /**
   * Every `running` job whose `started_at` is strictly before `before`, oldest
   * first, at most `limit` of them. An empty array means nothing is stuck.
   */
  listRunningStartedBefore(input: {
    before: string;
    limit: number;
  }): Promise<StuckRunningJob[]>;
};

export const LIST_RUNNING_STARTED_BEFORE = "listRunningStartedBefore";

export type JobStuckReaderOperation = typeof LIST_RUNNING_STARTED_BEFORE;

/** The smallest page a caller may ask for. Zero would be a silently empty read. */
export const MIN_STUCK_READ_LIMIT = 1;

/** The largest page: one pass must stay a bounded scan. */
export const MAX_STUCK_READ_LIMIT = 500;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line through us — and the reaper logs every
 * failure of this read.
 */
export class JobStuckReaderError extends Error {
  readonly operation: JobStuckReaderOperation;

  constructor(operation: JobStuckReaderOperation, cause: unknown) {
    super(
      `job stuck reader read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "JobStuckReaderError";
    this.operation = operation;
  }
}

/**
 * The columns this statement projects, in the order it names them. Exported so a
 * test can hold the statement's select list against this list: a column added to
 * one and not the other is the drift it refuses.
 */
export const JOB_STUCK_READER_COLUMNS = [
  "id",
  "job_type",
  "started_at",
  "max_attempts",
] as const satisfies readonly (keyof RawStuckRunningRow)[];

/** The row as the drivers hand it back, keyed by COLUMN name. */
type RawStuckRunningRow = {
  id: unknown;
  job_type: unknown;
  started_at: unknown;
  max_attempts: unknown;
};

/**
 * The one statement this module can issue.
 *
 * `status = 'running'` is fixed text and `started_at < $1::timestamptz` is the
 * only predicate that varies; the threshold is a bind parameter with an explicit
 * cast, so a malformed one fails as a real SQL error (SQLSTATE 22007) inside the
 * transaction instead of silently matching every row. `order by started_at` and
 * `limit $2` keep the scan finite and oldest-first. There is exactly one selected
 * table, and the statement is never a batch.
 */
const LIST_RUNNING_STARTED_BEFORE_SQL = `
select id, job_type, started_at, max_attempts
from public.background_jobs
where status = 'running' and started_at < $1::timestamptz
order by started_at
limit $2
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `JobStuckReaderError` on an actual read.
 *
 * There is no fallback path. A caller that was handed this repository either
 * reads through it or fails — and the reaper treats a failure as "retire
 * nothing", never as "retire something".
 */
export function createJobStuckReaderRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobStuckReaderRepository {
  return {
    async listRunningStartedBefore(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const before = requireThreshold(input.before);
      const limit = requireLimit(input.limit);

      try {
        const pool = options.getTransactionPool();

        const rows = await withPrivilegedTransaction(
          pool,
          // System read: there is no acting user, so the context is explicitly
          // empty rather than borrowed from a caller. It grants nothing — the
          // statement's own predicate is the rule.
          null,
          async (client) => {
            const result = await client.query(
              LIST_RUNNING_STARTED_BEFORE_SQL,
              [before, limit],
            );

            return result.rows.map(mapStuckRunningRow);
          },
        );

        return rows;
      } catch (error) {
        throw new JobStuckReaderError(LIST_RUNNING_STARTED_BEFORE, error);
      }
    },
  };
}

/**
 * The threshold, which must be a real timestamp.
 *
 * It is normalised to an ISO-8601 string before it is bound so the value this
 * module sends is the same shape the row mapper reports. Anything that
 * `Date.parse` cannot read is a caller bug rather than an empty window: silently
 * binding it would let PostgreSQL decide, and a caller that meant "one hour ago"
 * while passing garbage would reap nothing and never notice.
 */
function requireThreshold(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobStuckReaderError(
      LIST_RUNNING_STARTED_BEFORE,
      new Error('job stuck reader read needs a non-empty "before"'),
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new JobStuckReaderError(
      LIST_RUNNING_STARTED_BEFORE,
      new Error('job stuck reader read needs a readable "before"'),
    );
  }

  return parsed.toISOString();
}

/**
 * The page size, which must be a whole number in 1..500.
 *
 * Clamping instead of refusing would hide a caller that asked for "all of them"
 * or for zero: the first turns a bounded scan into an unbounded one, the second
 * turns every pass into a silent no-op.
 */
function requireLimit(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_STUCK_READ_LIMIT ||
    value > MAX_STUCK_READ_LIMIT
  ) {
    throw new JobStuckReaderError(
      LIST_RUNNING_STARTED_BEFORE,
      new Error(
        `job stuck reader read needs a "limit" between ${MIN_STUCK_READ_LIMIT} and ${MAX_STUCK_READ_LIMIT}`,
      ),
    );
  }

  return value;
}

function mapStuckRunningRow(row: unknown): StuckRunningJob {
  const record = asReadRow(row);

  return {
    id: requireIdentity(record, "id"),
    jobType: requireJobType(record, "job_type"),
    startedAt: requireInstant(record, "started_at"),
    maxAttempts: requireMaxAttempts(record, "max_attempts"),
  };
}

function asReadRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job stuck reader read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/**
 * The job id. `id` is the primary key and is NOT NULL, so an absent or empty one
 * is drift rather than a value — and this id is what the reaper will mark failed
 * and refund, so it must be a real row identity.
 */
function requireIdentity(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`job stuck reader read returned no usable "${field}"`);
  }

  return value;
}

/**
 * The job type, which decides the per-attempt budget. It is a NOT NULL enum
 * column, so both drivers hand back a string. The VALUE is not checked against
 * the registry here: the database layer has no business importing the job
 * registry, and the reaper's own per-row guard turns an unregistered type into a
 * logged skip rather than a failed pass.
 */
function requireJobType(
  row: Readonly<Record<string, unknown>>,
  field: string,
): BackgroundJobType {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`job stuck reader read returned no usable "${field}"`);
  }

  return value as BackgroundJobType;
}

/**
 * The instant the budget is measured from, normalised to ISO-8601.
 *
 * A `started_at` that is NULL is excluded by the statement's own comparison, so
 * a row reaching here has one. `Date` (the `pg` array parser) and string (PGlite
 * and the JSON wire) are both accepted; anything else is drift, and guessing an
 * instant would decide whether a job is killed.
 */
function requireInstant(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`job stuck reader read returned no usable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`job stuck reader read returned no usable "${field}"`);
    }

    return parsed.toISOString();
  }

  throw new Error(`job stuck reader read returned no usable "${field}"`);
}

/**
 * The job's own attempt budget, which the execution budget multiplies by.
 *
 * An `integer` column comes back from both drivers as a JavaScript number. A
 * negative or fractional value is drift rather than a budget. Zero is passed
 * through rather than rejected: `executorTimeoutMs` already clamps with
 * `Math.max(1, ...)`, so the reaper's decision stays defined for a row the
 * counter never touched.
 */
function requireMaxAttempts(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = row[field];

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`job stuck reader read returned no usable "${field}"`);
  }

  return value;
}
