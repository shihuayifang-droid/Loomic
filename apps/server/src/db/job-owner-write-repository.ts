/**
 * Owner job write repository (workorder 21U, ADR-0001 migration step 2).
 *
 * ONE write moves here: the caller cancelling their OWN job, behind
 * `JobService.cancelJob` — the `POST /api/jobs/:jobId/cancel` route, and the
 * reaction `withBilling` runs when a charge fails.
 *
 * What it was: a user-client PostgREST update of `background_jobs`, patched with
 * `{status: "canceled", canceled_at: <ISO>}`, matched by `id = jobId and status
 * in ('queued', 'running')`, projected with the service's shared column list and
 * awaited as `maybeSingle()`. Its ACL was RLS and nothing else: the table's
 * policy `background_jobs_user_policy` reads `auth.uid() = created_by`. The
 * 2026-09 team-workspace migration rewrote the policies of projects, canvases,
 * chat and workspace_settings but deliberately left `background_jobs` alone, so
 * membership is NOT a gate here — and it must not become one by accident. A user
 * who leaves a team still has to be able to cancel the job they started.
 *
 * Rules this module keeps:
 *
 * - The interface is exactly this one method. There is no access token, no
 *   workspace id, no table name, no status list, no column set and no generic
 *   predicate object, so a caller cannot widen the write: every row this module
 *   can ever touch is one whose `id` is the job asked for AND whose `created_by`
 *   is the actor it was handed AND whose status is one of the two the statement
 *   spells out.
 * - The ACL is the STATEMENT's own predicate — `created_by = $1::uuid` — written
 *   out in SQL rather than inherited from a session role. The transaction is
 *   opened privileged (the pool's role owns `background_jobs`), so RLS is not
 *   what decides; the explicit predicate is. That is deliberate: the rule is
 *   visible in the one file that implements the write, and a policy change can
 *   no longer silently widen or narrow it.
 * - The guard set is FIXED TEXT: `status in ('queued', 'running')` is part of the
 *   statement, never a bind parameter and never a caller argument. `retrying` is
 *   deliberately NOT in it — a job the worker is still going to retry is not
 *   cancellable, and the 21H0 baseline pins that as the existing behaviour
 *   (`test-support/db/background-job-write-acl-db.test.ts` case 13). Widening the
 *   set is a product decision, not a refactor.
 * - The `set` clause writes EXACTLY the two columns the old patch wrote:
 *   `status` and `canceled_at`. `updated_at` is deliberately NOT written —
 *   `trg_background_jobs_updated_at` stamps it on every UPDATE, and writing it
 *   here as well would give the column two sources that can disagree.
 * - The projection names all 22 columns explicitly, in exactly the order of
 *   `SELECT_COLS` in `features/jobs/job-service.ts`, and the row keeps the COLUMN
 *   names as its keys because the service runs it through `mapJobRow`. The
 *   mapping itself is REUSED, not reimplemented: `mapJobReadRow` of workorder
 *   21I normalises the six timestamps to ISO strings and fails loud on a column
 *   that is absent rather than null, and duplicating that here is how the cancel
 *   answer would start disagreeing with the reads about the same row.
 * - `canceledAt` is bound as `$3::timestamptz` under an explicit cast, and an
 *   unusable value is refused before any connection is opened: it must be a
 *   canonical ISO-8601 instant (the exact text `Date#toISOString()` produces,
 *   which is what the service has always passed). Accepting a looser spelling
 *   would let two processes write the same instant in two shapes.
 * - Zero rows is a LEGAL answer and is reported as `null`: the guard matching
 *   nothing means "no such job for this actor, or not in a cancellable state",
 *   which the service turns into its existing `job_not_found` 404. The
 *   transaction COMMITs — nothing was written and nothing failed. `id` is the
 *   primary key, so more than one row is a statement/mapper disagreement rather
 *   than a value and throws (which rolls the transaction back).
 * - A connect, SQL (including the 22P02 a malformed uuid raises) or row-shape
 *   failure throws `JobOwnerWriteError`, whose own message is fixed text: no SQL,
 *   no host, no connection string, no actor id and no job id. The driver's own
 *   error rides along as `cause` so a caller can classify it without the driver's
 *   message reaching a log line or an HTTP body.
 * - The uuid SHAPE is deliberately not checked: a malformed id is bound as
 *   `::uuid`, so PostgreSQL rejects it inside the transaction, the transaction
 *   rolls back and the connection stays usable.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a failure on the write, never a silent fallback: nothing in
 *   this module can reach PostgREST, and with no repository wired `JobService`
 *   fails closed rather than calling the user client it used to write through.
 * - Cancelling does NOT refund and does NOT archive the queue message: the
 *   message of a cancelled job is dropped by the worker's own `markRunning`
 *   guard. That is the existing semantics (workorder 21H0 case 12/13/16) and
 *   changing it belongs to GN-32, which is not this workorder.
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
 * It is the shape workorder 21I's admin read and workorder 21T's owner read both
 * answer with, on purpose: the cancel answer, the two owner reads and the admin
 * read all hand the service the same record, so `mapJobRow` — and with it the
 * `dead_letter` → `failed` translation and the `?? null` / `?? {}` defaults —
 * stays the single place a `background_jobs` row becomes a `BackgroundJob`.
 */
export type JobOwnerWriteRow = JobAdminReadRow;

export type JobOwnerWriteRepository = {
  /**
   * Cancel the one job row with that id **that this actor created** and that is
   * still cancellable, or `null` when the guard matched no row.
   *
   * The three arguments are all the caller may decide: WHO is cancelling (the
   * ACL value), WHICH job, and the timestamp to stamp. Neither the status set,
   * the columns written, nor the row's visibility is a caller input.
   */
  cancelOwnJob(input: {
    actorId: string;
    jobId: string;
    canceledAt: string;
  }): Promise<JobOwnerWriteRow | null>;
};

export const CANCEL_OWN_JOB = "cancelOwnJob";

export type JobOwnerWriteOperation = typeof CANCEL_OWN_JOB;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential, the actor's id or the job's id must never reach a log line through
 * us.
 */
export class JobOwnerWriteError extends Error {
  readonly operation: JobOwnerWriteOperation;

  constructor(operation: JobOwnerWriteOperation, cause: unknown) {
    super(
      `job owner write failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "JobOwnerWriteError";
    this.operation = operation;
  }
}

/**
 * The projection, in the order the statement names it and in the order of
 * `SELECT_COLS` in `features/jobs/job-service.ts`.
 *
 * It is exported so a test can hold the statement, this list and the service's
 * own list against each other: a column added to one and not to the others is
 * the drift the comparison refuses. The row mapper that goes with the list is
 * workorder 21I's, reused rather than copied.
 */
export const JOB_OWNER_WRITE_COLUMNS = [
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
] as const satisfies readonly (keyof JobOwnerWriteRow)[];

/**
 * The statuses the statement admits, as a MIRROR of the text inside it.
 *
 * The statement carries the literals `'queued'` and `'running'`; this constant
 * exists so a test can hold the two against each other and so the rule has one
 * name. It is never bound as a parameter and never reaches the SQL: a caller
 * cannot widen the guard by changing it, and a change here without the same
 * change in the statement is a failure rather than a silent widening.
 *
 * `retrying` is NOT in this set (see the header).
 */
export const CANCELABLE_JOB_STATUSES = ["queued", "running"] as const;

/**
 * The one statement this module can issue.
 *
 * `where id = $2::uuid and created_by = $1::uuid and status in ('queued',
 * 'running')` is the WHOLE rule: the row's id AND the fact that this actor
 * created it AND a status that may still be cancelled. There is no workspace
 * term, no membership subquery and no ordering. The two uuid values are bind
 * parameters with explicit casts, so a malformed one fails as a real SQL error
 * inside the transaction instead of silently matching something else; the status
 * set is statement text, so no call site decides it. The statement is a single
 * UPDATE — never a batch, never a concatenation — and touches exactly one table.
 *
 * The `set` clause names two columns and nothing else; `updated_at` belongs to
 * the table's BEFORE UPDATE trigger.
 */
const CANCEL_OWN_JOB_SQL = `
update public.background_jobs
   set status = 'canceled', canceled_at = $3::timestamptz
 where id = $2::uuid and created_by = $1::uuid and status in ('queued', 'running')
returning
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
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `JobOwnerWriteError` on an actual write.
 *
 * There is no fallback path. A caller that was handed this repository either
 * writes through it or fails.
 */
export function createJobOwnerWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobOwnerWriteRepository {
  /**
   * One privileged transaction around one statement, with the caller as the
   * actor. The three actor settings carry the acting user, so the write stays
   * attributable; the mode is the explicit privileged one because the statement's
   * own `created_by` predicate — not RLS — is the rule. The context grants
   * nothing on its own: it is a label on a transaction whose statement already
   * contains the ACL.
   *
   * A connect failure, a SQL failure, the 22P02 a malformed uuid raises, and a
   * row-shape failure all leave here as the same fixed-text
   * `JobOwnerWriteError`, with the driver's own error as `cause`.
   */
  async function write<T>(
    operation: JobOwnerWriteOperation,
    actorId: string,
    statement: (client: TransactionConnection) => Promise<T>,
  ): Promise<T> {
    try {
      const pool = options.getTransactionPool();

      return await withPrivilegedTransaction(pool, { userId: actorId }, statement);
    } catch (error) {
      throw new JobOwnerWriteError(operation, error);
    }
  }

  return {
    async cancelOwnJob(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const actorId = requireWriteArgument(CANCEL_OWN_JOB, input.actorId, "actorId");
      const jobId = requireWriteArgument(CANCEL_OWN_JOB, input.jobId, "jobId");
      const canceledAt = requireCanceledAt(CANCEL_OWN_JOB, input.canceledAt);

      return write(CANCEL_OWN_JOB, actorId, async (client) => {
        // Position matters and is part of the contract: $1 is the ACL value, $2
        // the row key, $3 the stamp. The status set is not in this list at all.
        const result = await client.query(CANCEL_OWN_JOB_SQL, [
          actorId,
          jobId,
          canceledAt,
        ]);

        // Zero rows is the "no such job for this actor, or it can no longer be
        // cancelled" answer (see the header) and is reported as `null`, NOT as a
        // failure — it is the old `maybeSingle()` null, which the service turns
        // into its existing 404. Nothing was written and the transaction COMMITs.
        if (result.rows.length === 0) return null;

        // More than one row is impossible for the same reason and is treated as
        // a statement/mapper disagreement rather than a value.
        if (result.rows.length !== 1) {
          throw new Error("job owner write returned more than one row");
        }

        return mapJobReadRow(result.rows[0]);
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
function requireWriteArgument(
  operation: JobOwnerWriteOperation,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobOwnerWriteError(
      operation,
      new Error(`job owner write needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * A canonical ISO-8601 INSTANT, and nothing else: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
 *
 * That is exactly the text `Date#toISOString()` produces, which is what the
 * service has always stamped. A date that only LOOKS like a timestamp
 * (`2026-02-30T00:00:00.000Z`, month 13) is caught by the round trip, not by the
 * pattern; a different offset (`+02:00`) or a missing millisecond is caught by
 * the round trip too, so two processes cannot write the same instant in two
 * shapes and a `timestamptz` comparison cannot be surprised by one of them.
 *
 * Like the other arguments, an unusable value is refused BEFORE a connection is
 * opened, and it is not reported as a database failure either.
 */
const CANONICAL_ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function requireCanceledAt(
  operation: JobOwnerWriteOperation,
  value: unknown,
): string {
  if (typeof value !== "string" || !CANONICAL_ISO_INSTANT.test(value)) {
    throw new JobOwnerWriteError(
      operation,
      new Error('job owner write needs a canonical ISO-8601 "canceledAt"'),
    );
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new JobOwnerWriteError(
      operation,
      new Error('job owner write needs a canonical ISO-8601 "canceledAt"'),
    );
  }

  return value;
}
