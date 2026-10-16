/**
 * Job status transition repository (workorder 21M, ADR-0001 migration step 2).
 *
 * The worker moves a job through its state machine with exactly four writes:
 * `queued|retrying -> running`, `running -> retrying`, `running -> succeeded`
 * and `queued|running|retrying -> failed`. Each one used to be an admin update
 * built AT THE CALL SITE, where the caller handed in the list of statuses a row
 * had to be in and the object of columns to write, and the guard existed only
 * because that call site happened to pass the right pair.
 *
 * This module is those four writes as four fixed statements. The state machine
 * is the SQL text, so a caller cannot widen, narrow or re-aim a transition:
 *
 * - Four methods, one statement each, and no fifth entry point. There is no
 *   access token, no workspace id, no table name, no status argument and no
 *   generic patch object, so the only row any statement can reach is
 *   `id = $1::uuid` and the only columns it can assign are the ones printed in
 *   its own `set` clause.
 * - The `from` sets and the `to` status are SQL LITERALS of this file, never a
 *   bind parameter. A caller cannot ask for a transition this module does not
 *   own — there is no argument that could carry one.
 * - Every value that IS a value (the job id, the two error fields, the result
 *   document and the timestamps) is a bind parameter with an explicit cast, so
 *   a malformed job id fails as a real SQL error (SQLSTATE 22P02) inside the
 *   transaction instead of silently matching something else.
 * - The timestamps stay the APPLICATION's clock: they are passed IN as ISO
 *   strings by the caller (`JobService` still calls `new Date().toISOString()`)
 *   and bound as `$n::timestamptz`. The database does not stamp them, because
 *   moving the clock source would be a behaviour change smuggled in under a
 *   migration — and it would also make the transition unobservable to a caller
 *   double.
 * - All four statements run through workorder 19's transaction entry point in
 *   `privileged` mode with a NULL actor. This is the worker writing its own job
 *   rows: there is no user behind it, and forging one would put a person's id on
 *   a row they had nothing to do with.
 * - Every statement is guarded, and the guard is why this module exists:
 *   zero rows means the row was NOT in a state this transition owns (it was
 *   cancelled, already finished, or never existed). That is reported as `false`,
 *   and the transaction still COMMITs.
 * - `false` is load-bearing, not informational: `markFailed`'s answer is the
 *   ONLY thing that authorises a refund (`processJobMessage` refunds when the
 *   transition returned `true`). Reporting a zero-row write as success would
 *   pay the same charge twice, so "the row did not move" must never be folded
 *   into `true`.
 * - A connect, SQL or row-shape failure throws `JobTransitionError`, whose own
 *   message is built from the fixed operation name: no SQL, no host, no
 *   connection string, no job id. The driver's own error rides along as `cause`
 *   so a caller can classify it without the driver's message reaching a log line
 *   or an HTTP body.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a failure on the call, never a silent fallback: nothing in
 *   this module can reach PostgREST.
 *
 * `updated_at` is deliberately NOT assigned here. The table carries a
 * `before update` trigger (`trg_background_jobs_updated_at`) that stamps it, and
 * that trigger is the row's single writer of the column — see
 * `supabase/migrations/20260325200000_background_jobs.sql`.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type JobTransitionMarkRunningInput = {
  jobId: string;
  /** The instant the job started, as an ISO-8601 string. */
  startedAt: string;
};

export type JobTransitionMarkRetryingInput = {
  jobId: string;
  errorCode: string;
  errorMessage: string;
};

export type JobTransitionMarkSucceededInput = {
  jobId: string;
  /** The document `result` becomes: a plain object, serialised as jsonb. */
  result: Record<string, unknown>;
  /** The instant the job finished, as an ISO-8601 string. */
  completedAt: string;
};

export type JobTransitionMarkFailedInput = {
  jobId: string;
  errorCode: string;
  errorMessage: string;
  /** The instant the job failed, as an ISO-8601 string. */
  failedAt: string;
};

/**
 * The four transitions, and nothing else.
 *
 * `true` = this call moved the row; `false` = the guard rejected it (the row was
 * cancelled, already terminal, or does not exist). Neither answer is an error,
 * and the caller decides what `false` means for its own flow — for `markFailed`
 * it means "do not refund", and for `markRunning` it means "do not execute".
 */
export type JobTransitionRepository = {
  markRunning(input: JobTransitionMarkRunningInput): Promise<boolean>;
  markRetrying(input: JobTransitionMarkRetryingInput): Promise<boolean>;
  markSucceeded(input: JobTransitionMarkSucceededInput): Promise<boolean>;
  markFailed(input: JobTransitionMarkFailedInput): Promise<boolean>;
};

export const MARK_RUNNING = "markRunning";
export const MARK_RETRYING = "markRetrying";
export const MARK_SUCCEEDED = "markSucceeded";
export const MARK_FAILED = "markFailed";

export type JobTransitionOperation =
  | typeof MARK_RUNNING
  | typeof MARK_RETRYING
  | typeof MARK_SUCCEEDED
  | typeof MARK_FAILED;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line through us, and a transition failure is
 * not a lookup, so the job id does not travel with it either.
 */
export class JobTransitionError extends Error {
  readonly operation: JobTransitionOperation;

  constructor(operation: JobTransitionOperation, cause: unknown) {
    super(
      `job status transition failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "JobTransitionError";
    this.operation = operation;
  }
}

/**
 * `queued|retrying -> running`, stamping `started_at`.
 *
 * Both not-yet-started states are startable: a job that was re-queued after a
 * retryable failure carries `retrying`, and it must be able to start again. A
 * `running` row is NOT startable (a second delivery of the same message must not
 * start the job twice), and neither is a terminal or cancelled one.
 *
 * `set` names exactly two columns. `error_code` is left alone on purpose: a job
 * that is starting has not failed yet, and clearing it here would erase the code
 * of the failure this attempt is retrying.
 */
const MARK_RUNNING_SQL = `
update public.background_jobs
   set status = 'running',
       started_at = $2::timestamptz
 where id = $1::uuid
   and status in ('queued', 'retrying')
returning id
`;

/**
 * `running -> retrying`, recording why the attempt will be repeated.
 *
 * `failed_at` is deliberately NOT written: `retrying` is not a terminal state
 * (GN-30), and stamping a failure time on a job that is still going to run would
 * report it as over. Only a `running` row is retryable — a `queued` row has not
 * attempted anything, and a terminal one is somebody else's answer.
 */
const MARK_RETRYING_SQL = `
update public.background_jobs
   set status = 'retrying',
       error_code = $2,
       error_message = $3
 where id = $1::uuid
   and status = 'running'
returning id
`;

/**
 * `running -> succeeded`, storing the result document and `completed_at`.
 *
 * A `queued`/`retrying` row is NOT success-able: the transition that starts the
 * job is the one that owns `started_at`, and letting success in from a state
 * that never started would settle a job whose message is still in flight.
 *
 * `result` is bound as `$2::jsonb` and is ALWAYS a string by the time it gets
 * here (`JSON.stringify`), never the JavaScript value. The driver serialises a
 * JavaScript array into a PostgreSQL ARRAY literal rather than JSON — the
 * 2026-10-15 incident — so the encoding is done in this module, once, for every
 * caller. `result` must be a plain object: an array, `null` or a string is
 * refused before a connection is opened, because none of those is the document
 * the column holds.
 */
const MARK_SUCCEEDED_SQL = `
update public.background_jobs
   set status = 'succeeded',
       result = $2::jsonb,
       completed_at = $3::timestamptz
 where id = $1::uuid
   and status = 'running'
returning id
`;

/**
 * `queued|running|retrying -> failed`, the terminal failure.
 *
 * Every non-terminal state may fail: a job that never started (the attempt
 * budget was already spent, or the billing gate refused it), one that is
 * executing, and one that was waiting to be retried. A `canceled` row keeps its
 * own status — the user's action is not overwritten by the worker — and a
 * `succeeded` one is already answered.
 *
 * This is the statement whose answer decides whether money moves: the worker
 * refunds the job's charge if and only if this returned `true`.
 */
const MARK_FAILED_SQL = `
update public.background_jobs
   set status = 'failed',
       error_code = $2,
       error_message = $3,
       failed_at = $4::timestamptz
 where id = $1::uuid
   and status in ('queued', 'running', 'retrying')
returning id
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `JobTransitionError` on an actual write.
 *
 * There is no fallback path. A caller that was handed this repository either
 * writes through it or fails — and a failing write is a failure the caller can
 * see, unlike the unchecked update this replaces.
 */
export function createJobTransitionRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobTransitionRepository {
  return {
    async markRunning(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const jobId = requireJobId(MARK_RUNNING, input.jobId);
      const startedAt = requireTimestamp(MARK_RUNNING, input.startedAt, "startedAt");

      return runWrite(MARK_RUNNING, options, MARK_RUNNING_SQL, [jobId, startedAt]);
    },

    async markRetrying(input) {
      const jobId = requireJobId(MARK_RETRYING, input.jobId);
      const errorCode = requireText(MARK_RETRYING, input.errorCode, "errorCode");
      const errorMessage = requireText(
        MARK_RETRYING,
        input.errorMessage,
        "errorMessage",
      );

      return runWrite(MARK_RETRYING, options, MARK_RETRYING_SQL, [
        jobId,
        errorCode,
        errorMessage,
      ]);
    },

    async markSucceeded(input) {
      const jobId = requireJobId(MARK_SUCCEEDED, input.jobId);
      const result = requireResult(MARK_SUCCEEDED, input.result);
      const completedAt = requireTimestamp(
        MARK_SUCCEEDED,
        input.completedAt,
        "completedAt",
      );

      return runWrite(MARK_SUCCEEDED, options, MARK_SUCCEEDED_SQL, [
        jobId,
        // Serialised HERE, not by the driver: a JavaScript array would otherwise
        // be bound as a PostgreSQL array literal instead of a JSON document.
        JSON.stringify(result),
        completedAt,
      ]);
    },

    async markFailed(input) {
      const jobId = requireJobId(MARK_FAILED, input.jobId);
      const errorCode = requireText(MARK_FAILED, input.errorCode, "errorCode");
      const errorMessage = requireText(
        MARK_FAILED,
        input.errorMessage,
        "errorMessage",
      );
      const failedAt = requireTimestamp(MARK_FAILED, input.failedAt, "failedAt");

      return runWrite(MARK_FAILED, options, MARK_FAILED_SQL, [
        jobId,
        errorCode,
        errorMessage,
        failedAt,
      ]);
    },
  };
}

/**
 * One guarded transition, one privileged transaction, one statement.
 *
 * Zero rows is the guard answering "this transition does not own that row" — a
 * legal `false` that COMMITs. More than one row is impossible for a statement
 * keyed on the primary key, so it is treated as a statement/mapper disagreement
 * rather than a value: a write that answered two rows has not answered, and the
 * transaction must roll back.
 */
async function runWrite(
  operation: JobTransitionOperation,
  options: { getTransactionPool: () => TransactionPool },
  sql: string,
  params: readonly unknown[],
): Promise<boolean> {
  try {
    const pool = options.getTransactionPool();

    return await withPrivilegedTransaction(
      pool,
      // System worker write: there is no acting user, so the context is
      // explicitly empty rather than borrowed from a caller. It grants nothing —
      // each statement's own `where id = $1::uuid` plus its transition predicate
      // is the rule.
      null,
      async (client) => {
        const result = await client.query(sql, params);

        if (result.rows.length === 0) return false;

        if (result.rows.length !== 1) {
          throw new Error(
            `job status transition write updated more than one row (${operation})`,
          );
        }

        return true;
      },
    );
  } catch (error) {
    throw new JobTransitionError(operation, error);
  }
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction,
 * the transaction rolls back and the connection stays usable. Pre-validating it
 * here would hide that path instead of exercising it.
 *
 * The refusal carries no value: the message names the FIELD, never the id.
 */
function requireJobId(operation: JobTransitionOperation, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobTransitionError(
      operation,
      new Error('job status transition needs a non-empty "jobId"'),
    );
  }

  return value;
}

/**
 * The two error fields are TEXT, and a text column takes any string.
 *
 * Only a non-string is refused. `null`/`undefined` would be bound as SQL NULL by
 * the driver, which ERASES the failure the row is supposed to record — that is
 * the dangerous case, and it is a different thing from an empty string, which
 * the caller really did pass and which the previous writer stored verbatim
 * (`processJobMessage` derives the message from an arbitrary thrown value, so an
 * empty one is reachable). Refusing empty strings here would be a behaviour
 * change under the cover of a migration.
 */
function requireText(
  operation: JobTransitionOperation,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string") {
    throw new JobTransitionError(
      operation,
      new Error(`job status transition needs "${field}" as a string`),
    );
  }

  return value;
}

/**
 * The result document must be a plain object.
 *
 * An array is the incident this check exists for (it reaches PostgreSQL as an
 * array literal, not as JSON), and `null`/a string/`undefined` are simply not
 * what the column holds. A class instance is refused too: it would be serialised
 * to something `JSON.parse` cannot read back as the same value (a `Map` becomes
 * `{}`, a `Date` becomes a string), so accepting one would store a document
 * nobody wrote.
 *
 * Nested arrays and nested objects INSIDE the result are untouched — they are
 * exactly what `JSON.stringify` is for.
 */
function requireResult(
  operation: JobTransitionOperation,
  value: unknown,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !isPlainObject(value)
  ) {
    throw new JobTransitionError(
      operation,
      new Error('job status transition needs "result" as a plain object'),
    );
  }

  return value as Record<string, unknown>;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A transition timestamp is a real instant in the exact form the application
 * produces.
 *
 * `new Date(value).toISOString() === value` is the whole rule: the caller is
 * `JobService`, which generates these strings with `new Date().toISOString()`,
 * so the canonical form (`YYYY-MM-DDTHH:mm:ss.sssZ`) round-trips byte for byte
 * while a date-only string, a local-time string or a `Date` object does not.
 * That is what keeps "the timestamp the caller passed" and "the timestamp the
 * column holds" the same value, milliseconds included.
 */
function requireTimestamp(
  operation: JobTransitionOperation,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string") {
    throw new JobTransitionError(
      operation,
      new Error(`job status transition needs "${field}" as an ISO timestamp`),
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new JobTransitionError(
      operation,
      new Error(`job status transition needs "${field}" as an ISO timestamp`),
    );
  }

  return value;
}
