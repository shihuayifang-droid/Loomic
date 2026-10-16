/**
 * Admin job read repository (workorder 21I, ADR-0001 migration step 2).
 *
 * ONE read moves here: the admin single-row lookup behind
 * `JobService.getJobAdmin`. It was an admin PostgREST read of one
 * `background_jobs` row by `id`, projecting the service's shared column list.
 * Its two callers are the job watcher's poll (`features/jobs/job-watcher.ts`,
 * which logs a failure and retries on the next tick) and the agent runtime's
 * re-read before it settles a run (`agent/runtime.ts`).
 *
 * Rules this module keeps:
 *
 * - `readJob` is the entire interface. There is no access token, no workspace
 *   id, no table name, no status filter and no generic predicate object, so a
 *   caller cannot widen the read: the only row this module can ever return is
 *   `id = $1::uuid`.
 * - The projection names all 22 columns explicitly, in exactly the order of
 *   `SELECT_COLS` in `features/jobs/job-service.ts`. The row keeps the COLUMN
 *   names as its keys, because the service still runs it through `mapJobRow`:
 *   that function is the server's only `dead_letter` → `failed` translation, and
 *   moving it in here would let `getJob` and `listJobs` drift away from
 *   `getJobAdmin`.
 * - The statement runs through workorder 19's transaction entry point in
 *   `privileged` mode with a NULL actor. This is a system read of a job row —
 *   the watcher and the runtime are not acting as any user — and forging an
 *   actor would put a person's id on an audit trail they had nothing to do with.
 *   The pool's role owns `background_jobs`, so the statement's OWN predicate
 *   (`where id = $1::uuid`) is the only thing selecting the row.
 * - Timestamps are NORMALISED, never passed through: `pg` and PGlite hand back
 *   `timestamptz` as a `Date`, while the HTTP contract publishes ISO strings, so
 *   `created_at` / `updated_at` (required) and `started_at` / `completed_at` /
 *   `failed_at` / `canceled_at` (nullable) all leave here as ISO-8601 text.
 *   Anything that is neither a `Date` nor an ISO string is drift and fails loud
 *   — `as string` on a `Date` compiles and then changes the JSON shape silently.
 * - A column that is MISSING from the row is a failure, not a null. Only an
 *   explicit SQL NULL becomes `null`. Folding the two together would let a
 *   projection that dropped a column read exactly like a job that has no
 *   project, no error and no start time (workorder 20D-fixup).
 * - `payload` and `result` are objects or `null` (both drivers parse `jsonb`
 *   already). A scalar or an array there is not the record this module promises
 *   its callers, so it fails loud.
 * - `attempt_count` and `max_attempts` are non-negative integers. A string, a
 *   float or a negative value would hand the retry decision a count the database
 *   never produced.
 * - Zero rows is a LEGAL answer and is reported as `null`: the old read answered
 *   "no row" for an unknown id and the service turns that into its existing
 *   `job_not_found` 404, so folding it into an error would turn a missing job
 *   into an outage. The transaction still COMMITs. `id` is the primary key, so
 *   more than one row is a statement/mapper disagreement rather than a value and
 *   throws.
 * - A connect, SQL (including the 22P02 a malformed uuid raises) or row-shape
 *   failure throws `JobAdminReadError`, whose own message is fixed text: no SQL,
 *   no host, no connection string, no job id. The driver's own error rides along
 *   as `cause` so a caller can classify it without the driver's message reaching
 *   a log line or an HTTP body.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a failure on the read, never a silent fallback: nothing in
 *   this module can reach PostgREST, and with no repository wired `JobService`
 *   fails closed rather than calling the admin client it used to.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * One `background_jobs` row, keyed by COLUMN name, with every timestamp already
 * normalised to an ISO-8601 string.
 *
 * The nullable columns are `null` exactly when the database says NULL:
 * `project_id`, `canvas_id`, `session_id`, `thread_id`, `error_code`,
 * `error_message` (schema: nullable) and `result`, `started_at`,
 * `completed_at`, `failed_at`, `canceled_at`. `payload` is NOT NULL in the
 * schema but is typed nullable because the service's mapper has always read a
 * missing payload as `{}` — this module reports what the row says.
 */
export type JobAdminReadRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  canvas_id: string | null;
  session_id: string | null;
  thread_id: string | null;
  queue_name: string;
  job_type: string;
  status: string;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  max_attempts: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  canceled_at: string | null;
};

export type JobAdminReadRepository = {
  /**
   * Read the one job row with that id, or `null` when no such row exists. A
   * missing job is not an error the caller should retry.
   */
  readJob(input: { jobId: string }): Promise<JobAdminReadRow | null>;
};

export const READ_JOB = "readJob";

export type JobAdminReadOperation = typeof READ_JOB;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential or the job id must never reach a log line through us.
 */
export class JobAdminReadError extends Error {
  readonly operation: JobAdminReadOperation;

  constructor(operation: JobAdminReadOperation, cause: unknown) {
    super(
      `job admin read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "JobAdminReadError";
    this.operation = operation;
  }
}

/**
 * The projection, in the order `SELECT_COLS` names it. It is exported so a test
 * can hold the statement's select list and the service's own list against this
 * one list: a column added to the service's read and not to this one (or the
 * other way round) is a drift the 22-column comparison in
 * `job-admin-read-repository.test.ts` refuses.
 */
export const JOB_ADMIN_READ_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "canvas_id",
  "session_id",
  "thread_id",
  "queue_name",
  "job_type",
  "status",
  "payload",
  "result",
  "error_code",
  "error_message",
  "attempt_count",
  "max_attempts",
  "created_by",
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
  "failed_at",
  "canceled_at",
] as const satisfies readonly (keyof JobAdminReadRow)[];

/**
 * The one statement this module can issue.
 *
 * `where id = $1::uuid` is the ONLY predicate: no status, no workspace, no
 * ordering and no limit. The id is a bind parameter with an explicit cast, so a
 * malformed one fails as a real SQL error (SQLSTATE 22P02) inside the
 * transaction instead of silently matching something else. There is exactly one
 * selected table, and the statement is never a batch.
 */
const READ_JOB_SQL = `
select
  id,
  workspace_id,
  project_id,
  canvas_id,
  session_id,
  thread_id,
  queue_name,
  job_type,
  status,
  payload,
  result,
  error_code,
  error_message,
  attempt_count,
  max_attempts,
  created_by,
  created_at,
  updated_at,
  started_at,
  completed_at,
  failed_at,
  canceled_at
from public.background_jobs
where id = $1::uuid
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `JobAdminReadError` on an actual read.
 *
 * There is no fallback path. A caller that was handed this repository either
 * reads through it or fails.
 */
export function createJobAdminReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobAdminReadRepository {
  return {
    async readJob(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const jobId = requireReadArgument(input.jobId, "jobId");

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // System read: there is no acting user, so the context is explicitly
          // empty rather than borrowed from a caller. It grants nothing — the
          // statement's own `where id = $1::uuid` is the rule.
          null,
          async (client) => {
            const result = await client.query(READ_JOB_SQL, [jobId]);

            // `id` is the primary key, so the statement is at most one row. Zero
            // rows is the "no such job" answer (see the header) and is reported
            // as `null`, NOT as a failure.
            if (result.rows.length === 0) return null;

            // More than one row is impossible for the same reason and is treated
            // as a statement/mapper disagreement rather than a value.
            if (result.rows.length !== 1) {
              throw new Error("job admin read returned more than one row");
            }

            return mapJobReadRow(result.rows[0]);
          },
        );
      } catch (error) {
        throw new JobAdminReadError(READ_JOB, error);
      }
    },
  };
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable. Pre-validating it here
 * would hide that path instead of exercising it.
 */
function requireReadArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobAdminReadError(
      READ_JOB,
      new Error(`job admin read needs a non-empty "${field}"`),
    );
  }

  return value;
}

function mapJobReadRow(row: unknown): JobAdminReadRow {
  const record = asReadRow(row);

  return {
    id: requireString(record, "id"),
    workspace_id: requireString(record, "workspace_id"),
    project_id: optionalText(record, "project_id"),
    canvas_id: optionalText(record, "canvas_id"),
    session_id: optionalText(record, "session_id"),
    thread_id: optionalText(record, "thread_id"),
    queue_name: requireString(record, "queue_name"),
    job_type: requireString(record, "job_type"),
    status: requireString(record, "status"),
    payload: optionalJsonObject(record, "payload"),
    result: optionalJsonObject(record, "result"),
    error_code: optionalText(record, "error_code"),
    error_message: optionalText(record, "error_message"),
    attempt_count: requireCount(record, "attempt_count"),
    max_attempts: requireCount(record, "max_attempts"),
    created_by: requireString(record, "created_by"),
    created_at: requireTimestamp(record, "created_at"),
    updated_at: requireTimestamp(record, "updated_at"),
    started_at: optionalTimestamp(record, "started_at"),
    completed_at: optionalTimestamp(record, "completed_at"),
    failed_at: optionalTimestamp(record, "failed_at"),
    canceled_at: optionalTimestamp(record, "canceled_at"),
  };
}

function asReadRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job admin read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/** A column the row cannot exist without: a non-empty string, nothing else. */
function requireString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`job admin read returned no usable "${field}"`);
  }

  return value;
}

/**
 * A nullable TEXT or uuid column. The only two usable answers are an explicit
 * SQL NULL (`null`) and a string; an ABSENT column is a failure, which is the
 * whole point of reading the two apart. An empty string is passed along rather
 * than rejected: `thread_id` and the error fields are plain `text`, and a stored
 * empty string is a value the old read returned too.
 */
function optionalText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new Error(`job admin read returned no usable "${field}"`);
  }

  return value;
}

/**
 * `jsonb` arrives as a parsed object from both drivers; a JSON `null` arrives as
 * SQL NULL. Anything else (an array, a scalar, an absent column) is not the
 * record this module promises its callers, so it fails loud instead of being
 * passed along.
 */
function optionalJsonObject(
  row: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`job admin read returned an unusable "${field}"`);
  }

  return value as Record<string, unknown>;
}

/**
 * A column this statement always answers with a non-negative integer.
 *
 * `integer` columns come back from both drivers as JavaScript numbers, so a
 * string, a float, a negative value or an absent column is drift rather than a
 * count.
 */
function requireCount(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`job admin read returned no usable "${field}"`);
  }

  return value;
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; the service's
 * `BackgroundJob` carries strings. Both are accepted and normalised, anything
 * else (an absent column, a number, a non-ISO string, an invalid `Date`) fails
 * loud. Passing the `Date` through would break the published shape the moment
 * the row is serialised, and no type check would notice.
 */
function requireTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`job admin read returned no usable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`job admin read returned no usable "${field}"`);
}

/** A nullable `timestamptz`: an explicit NULL, or the normalised timestamp. */
function optionalTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null) return null;

  return requireTimestamp(row, field);
}
