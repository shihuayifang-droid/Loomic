/**
 * Owner job read repository (workorder 21T, ADR-0001 migration step 2).
 *
 * TWO reads move here, both behind `JobService`:
 *
 * - `readOwnJob` — the caller's own job row, behind `GET /api/jobs/:jobId`;
 * - `listOwnJobs` — the caller's own job list, behind `GET /api/jobs`.
 *
 * Both were user-client PostgREST reads of `background_jobs`, and neither
 * carried a workspace check: the table's RLS policy
 * `background_jobs_user_policy` reads `auth.uid() = created_by` and nothing
 * else. The 2026-09 team-workspace migration rewrote the policies of projects,
 * canvases, chat and workspace_settings but deliberately left `background_jobs`
 * alone, so membership is NOT a gate here — and it must not become one by
 * accident. A user who leaves a team still has to see the jobs they created;
 * adding a membership predicate would hide their own history from them.
 *
 * Rules this module keeps:
 *
 * - The interface is exactly these two methods. There is no access token, no
 *   workspace id, no table name, no ordering, no page size and no generic
 *   predicate object, so a caller cannot widen the read: every row this module
 *   can ever return is one whose `created_by` is the actor it was handed.
 * - The ACL is the STATEMENT's own predicate — `created_by = $1::uuid` — written
 *   out in SQL rather than inherited from a session role. The transaction is
 *   opened privileged (the pool's role owns `background_jobs`), so RLS is not
 *   what decides; the explicit predicate is. That is deliberate: the rule is
 *   visible in the one file that implements the read, and a policy change can no
 *   longer silently widen or narrow it.
 * - Both statements are FIXED text with no string building of any kind. The list
 *   read's four filter combinations (no filter, status only, type only, both) are
 *   one statement with `is null or` terms, never a concatenation of clauses.
 * - The filter values are bound with their ENUM casts
 *   (`$2::public.background_job_status`, `$3::public.background_job_type`), not
 *   as text. Comparing them as text would make an invalid filter value quietly
 *   match nothing and answer `[]` with a 200, where the PostgREST read this
 *   replaces answered a 500. The enum cast keeps the failure a real SQL error
 *   (SQLSTATE 22P02) that the service turns into exactly that 500.
 * - `status = 'failed'` also matches the legacy `dead_letter` rows, because
 *   those read as failed everywhere else (see `mapJobRow`). `dead_letter` itself
 *   leaves here RAW: the translation belongs to the service's mapper, which is
 *   the server's only `dead_letter` → `failed` point, and moving it in here would
 *   let `getJob` and `listJobs` drift away from `getJobAdmin`.
 * - The projection names all 22 columns explicitly, in exactly the order of
 *   `SELECT_COLS` in `features/jobs/job-service.ts`, and the row keeps the COLUMN
 *   names as its keys because the service runs it through `mapJobRow`. The
 *   mapping itself is REUSED, not reimplemented: `mapJobReadRow` of workorder
 *   21I normalises the six timestamps to ISO strings and fails loud on a column
 *   that is absent rather than null, and duplicating that here is how the two job
 *   reads would start disagreeing about the same row.
 * - Zero rows is a LEGAL answer for both reads: `null` for the single row (the
 *   old `maybeSingle()`, which the service turns into its existing 404) and `[]`
 *   for the list. Neither is an error and both COMMIT. The single-row statement
 *   is by primary key, so more than one row is a statement/mapper disagreement
 *   rather than a value and throws.
 * - A connect, SQL (including the 22P02 that a malformed uuid or an invalid
 *   filter value raises) or row-shape failure throws `JobOwnerReadError`, whose
 *   own message is fixed text: no SQL, no host, no connection string, no actor id
 *   and no job id. The driver's own error rides along as `cause` so a caller can
 *   classify it without the driver's message reaching a log line or an HTTP body.
 * - An unusable ARGUMENT is refused before any connection is opened, and it is
 *   not reported as a database failure either. The uuid SHAPE is deliberately not
 *   checked: a malformed id is bound as `::uuid`, so PostgreSQL rejects it inside
 *   the transaction, the transaction rolls back and the connection stays usable.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a failure on the read, never a silent fallback: nothing in
 *   this module can reach PostgREST, and with no repository wired `JobService`
 *   fails closed rather than calling the user client it used to read through.
 */

import {
  withPrivilegedTransaction,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";
import {
  mapJobReadRow,
  type JobAdminReadRow,
} from "./job-admin-read-repository.js";

/**
 * One `background_jobs` row, keyed by COLUMN name, with every timestamp already
 * normalised to an ISO-8601 string.
 *
 * It is the shape workorder 21I's admin read already answers with, on purpose:
 * both reads hand the service the same record, so `mapJobRow` — and with it the
 * `dead_letter` → `failed` translation and the `?? null` / `?? {}` defaults —
 * stays the single place a `background_jobs` row becomes a `BackgroundJob`.
 */
export type JobOwnerReadRow = JobAdminReadRow;

export type JobOwnerReadRepository = {
  /**
   * Read the one job row with that id **that this actor created**, or `null`
   * when no such row exists. A job belonging to someone else is not an error the
   * caller should retry: it is "no such job", exactly what RLS answered before.
   */
  readOwnJob(input: {
    actorId: string;
    jobId: string;
  }): Promise<JobOwnerReadRow | null>;

  /**
   * Read the actor's own job rows, newest first, at most 50 of them, optionally
   * narrowed by status and/or job type. `null` means "no filter on this column";
   * an unknown value is a failure, never an empty list.
   */
  listOwnJobs(input: {
    actorId: string;
    status: string | null;
    jobType: string | null;
  }): Promise<JobOwnerReadRow[]>;
};

export const READ_OWN_JOB = "readOwnJob";
export const LIST_OWN_JOBS = "listOwnJobs";

export type JobOwnerReadOperation =
  | typeof READ_OWN_JOB
  | typeof LIST_OWN_JOBS;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential, the actor's id or the job's id must never reach a log line through
 * us.
 */
export class JobOwnerReadError extends Error {
  readonly operation: JobOwnerReadOperation;

  constructor(operation: JobOwnerReadOperation, cause: unknown) {
    super(
      `job owner read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "JobOwnerReadError";
    this.operation = operation;
  }
}

/**
 * The projection, in the order both statements name it and in the order of
 * `SELECT_COLS` in `features/jobs/job-service.ts`.
 *
 * It is exported so a test can hold the two new statements, this list and the
 * service's own list against each other: a column added to one and not to the
 * others is the drift the comparison refuses. The row mapper that goes with the
 * list is workorder 21I's, reused rather than copied.
 */
export const JOB_OWNER_READ_COLUMNS = [
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
] as const satisfies readonly (keyof JobOwnerReadRow)[];

/**
 * What the list read returns at most. It is written into the statement as a
 * literal, not bound: the cap is part of the statement's text, so no caller can
 * ask for a different number of rows.
 */
export const LIST_OWN_JOBS_LIMIT = 50;

/**
 * The single-row statement.
 *
 * `where id = $2::uuid and created_by = $1::uuid` is the WHOLE rule: the row's
 * id AND the fact that this actor created it. There is no workspace term, no
 * membership subquery, no status filter, no ordering and no limit — a job
 * belonging to another user simply is not there. Both values are bind parameters
 * with explicit casts, so a malformed one fails as a real SQL error inside the
 * transaction instead of silently matching something else. Exactly one table is
 * selected, and the statement is never a batch.
 */
const READ_OWN_JOB_SQL = `
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
where id = $2::uuid and created_by = $1::uuid
`;

/**
 * The list statement, and the four filter combinations it has to answer.
 *
 * The PostgREST read this replaces built its predicate from the caller's
 * arguments: the actor's own rows, then optionally a status clause — the legacy
 * `dead_letter` value included when the filter said `failed`, a plain equality
 * for anything else — then optionally a job-type clause, ordered newest first
 * and capped at 50. All four shapes are ONE statement here: `$2 is null or ...`
 * and `$3 is null or ...`, with the values bound, so no call site decides what
 * the SQL says and nothing is concatenated.
 *
 * Two details are load-bearing:
 *
 * - both filter parameters carry their enum cast. Bound as text, an unknown
 *   status would compare unequal to every row, match nothing and answer `[]`
 *   with a 200; cast to the enum, PostgreSQL rejects the value itself (22P02),
 *   which is the 500 the old read produced.
 * - the `failed` branch also admits `dead_letter`, spelled out in the statement
 *   rather than expanded into a value list by a caller.
 */
const LIST_OWN_JOBS_SQL = `
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
where created_by = $1::uuid
  and (
    $2::public.background_job_status is null
    or status = $2::public.background_job_status
    or ($2::public.background_job_status = 'failed' and status = 'dead_letter')
  )
  and (
    $3::public.background_job_type is null
    or job_type = $3::public.background_job_type
  )
order by created_at desc
limit 50
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `JobOwnerReadError` on an actual read.
 *
 * There is no fallback path. A caller that was handed this repository either
 * reads through it or fails.
 */
export function createJobOwnerReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobOwnerReadRepository {
  /**
   * One privileged transaction around one statement, with the caller as the
   * actor. The three actor settings carry the acting user, so an operation stays
   * attributable; the mode is the explicit privileged one because the statement's
   * own `created_by` predicate — not RLS — is the rule. The context grants
   * nothing on its own: it is a label on a transaction whose statement already
   * contains the ACL.
   *
   * A connect failure, a SQL failure, the 22P02 a malformed uuid or an invalid
   * filter value raises, and a row-shape failure all leave here as the same
   * fixed-text `JobOwnerReadError`, with the driver's own error as `cause`.
   */
  async function read<T>(
    operation: JobOwnerReadOperation,
    actorId: string,
    statement: (client: TransactionConnection) => Promise<T>,
  ): Promise<T> {
    try {
      const pool = options.getTransactionPool();

      return await withPrivilegedTransaction(pool, { userId: actorId }, statement);
    } catch (error) {
      throw new JobOwnerReadError(operation, error);
    }
  }

  return {
    async readOwnJob(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const actorId = requireReadArgument(READ_OWN_JOB, input.actorId, "actorId");
      const jobId = requireReadArgument(READ_OWN_JOB, input.jobId, "jobId");

      return read(READ_OWN_JOB, actorId, async (client) => {
        const result = await client.query(READ_OWN_JOB_SQL, [actorId, jobId]);

        // `id` is the primary key, so the statement is at most one row. Zero
        // rows is the "no such job for this actor" answer (see the header) and is
        // reported as `null`, NOT as a failure — it is the old `maybeSingle()`
        // null, which the service turns into its existing 404.
        if (result.rows.length === 0) return null;

        // More than one row is impossible for the same reason and is treated as
        // a statement/mapper disagreement rather than a value.
        if (result.rows.length !== 1) {
          throw new Error("job owner read returned more than one row");
        }

        return mapJobReadRow(result.rows[0]);
      });
    },

    async listOwnJobs(input) {
      const actorId = requireReadArgument(LIST_OWN_JOBS, input.actorId, "actorId");
      const status = requireOptionalFilter(LIST_OWN_JOBS, input.status, "status");
      const jobType = requireOptionalFilter(
        LIST_OWN_JOBS,
        input.jobType,
        "jobType",
      );

      return read(LIST_OWN_JOBS, actorId, async (client) => {
        const result = await client.query(LIST_OWN_JOBS_SQL, [
          actorId,
          status,
          jobType,
        ]);

        // No rows is the empty list, not an error: the old read answered an empty
        // array and the service answers `[]` unchanged. The cap is the statement's
        // own `limit`, so there is no row count to police here.
        return result.rows.map((row) => mapJobReadRow(row));
      });
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
function requireReadArgument(
  operation: JobOwnerReadOperation,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobOwnerReadError(
      operation,
      new Error(`job owner read needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * A filter value is either an explicit `null` ("do not filter on this column")
 * or a non-empty string. An absent field is NOT the same as `null` here: the
 * service always passes both keys, so a missing one is a caller that would
 * otherwise get an unfiltered list by accident — the widest read there is.
 *
 * The value's SPELLING is not checked: an unknown status is bound as its enum
 * type, so PostgreSQL rejects it and the failure stays the 500 it always was.
 */
function requireOptionalFilter(
  operation: JobOwnerReadOperation,
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;

  if (typeof value !== "string" || value.length === 0) {
    throw new JobOwnerReadError(
      operation,
      new Error(`job owner read needs a non-empty "${field}" or null`),
    );
  }

  return value;
}
