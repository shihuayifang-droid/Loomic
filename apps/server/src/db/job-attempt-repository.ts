/**
 * Job attempt counter repository (workorder 21F, ADR-0001 migration step 2).
 *
 * ONE runtime RPC moves here, and only this one: `increment_job_attempt`, the
 * atomic `attempt_count = attempt_count + 1` the worker runs before it starts a
 * job. The database function it replaces
 * (`supabase/migrations/20260331140000_atomic_increment_job_attempt.sql`) is a
 * single `UPDATE ... RETURNING`, and this module is that same statement in the
 * pure `pg` layer — not a rewrite of it.
 *
 * Rules this module keeps:
 *
 * - `incrementAttempt` is the entire interface. There is no access token, no
 *   workspace id, no status argument, no table name and no generic patch object,
 *   so a caller cannot widen the write: the only row this module can ever touch
 *   is `id = jobId`, and the only column it ever assigns is `attempt_count`
 *   (beside the `updated_at` stamp the superseded function also wrote).
 * - Every value is a bind parameter (`$1`) bound with an explicit cast, so a
 *   malformed job id fails as a real SQL error (SQLSTATE 22P02) inside the
 *   transaction instead of silently matching something else.
 * - The statement runs through workorder 19's transaction entry point in
 *   `privileged` mode with a NULL actor. This is a system worker write on a job
 *   row — there is no user behind it, and forging one would put a person's id on
 *   an audit trail they had nothing to do with. The actor `null` is therefore
 *   the honest context, and the pool's role owns `background_jobs` and bypasses
 *   RLS, so the statement's OWN predicate (`where id = $1::uuid`) is the only
 *   thing selecting the row.
 * - Zero rows is a LEGAL answer here, unlike the 21D profile write and the 21E1
 *   settings write. The old function answered zero rows for an unknown job id
 *   and the caller (`processJobMessage`) archives the message on that answer, so
 *   folding it into an error would strand the message instead of dropping it.
 *   Zero rows is reported as `null` and the transaction still COMMITs.
 * - The statement carries NO status predicate and writes no other column: a job
 *   that is already terminal or cancelled still has its attempt count moved,
 *   exactly as the replaced function did. Narrowing it (`and status in (...)`)
 *   would be a behaviour change smuggled in under a migration.
 * - A connect, SQL or row-shape failure throws `JobAttemptWriteError`, whose own
 *   message is fixed text: no SQL, no host, no connection string, no job id. The
 *   driver's own error rides along as `cause` so a caller can classify it without
 *   the driver's message reaching a log line or an HTTP body.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a write failure on the call, never a silent fallback:
 *   nothing in this module can reach PostgREST, and with no repository wired at
 *   all `JobService` fails closed rather than calling the old RPC.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * The answer as this module reports it: what `RETURNING` answered, and nothing
 * else. Both fields are non-null integers because the statement just wrote
 * `attempt_count` and the row cannot exist without `max_attempts`, so neither a
 * NULL nor a drifted type there is a value — it is a contract violation.
 */
export type JobAttemptRow = {
  attemptCount: number;
  maxAttempts: number;
};

export type JobAttemptRepository = {
  /**
   * Move `attempt_count` by exactly one for that job and report the row's new
   * pair. `null` means the job row does not exist; a missing job is not an
   * error the caller should retry.
   */
  incrementAttempt(input: { jobId: string }): Promise<JobAttemptRow | null>;
};

export const INCREMENT_ATTEMPT = "incrementAttempt";

export type JobAttemptOperation = typeof INCREMENT_ATTEMPT;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line through us.
 */
export class JobAttemptWriteError extends Error {
  readonly operation: JobAttemptOperation;

  constructor(operation: JobAttemptOperation, cause: unknown) {
    super(
      `job attempt write failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "JobAttemptWriteError";
    this.operation = operation;
  }
}

/**
 * The one statement this module can issue. It is the body of the replaced
 * database function, verbatim in shape:
 *
 * `set attempt_count = attempt_count + 1` reads and writes the column in the
 * same statement, so the database — not this process — decides the new value.
 * There is no `select` first and no read-modify-write window a second worker
 * could slip into, which is the whole reason the counter is not computed here.
 * `updated_at = now()` is the second assignment the function performed.
 *
 * `set` names exactly those two columns. `where id = $1::uuid` is the ONLY
 * predicate: no status is consulted, so a terminal or cancelled row still counts
 * an attempt (the previous semantics), and no other row can be reached.
 *
 * `returning attempt_count, max_attempts` names the two columns the answer is
 * projected from. A zero-row result is not an error to PostgreSQL; it is the
 * "no such job" answer described in the header and is mapped to `null` below.
 */
const INCREMENT_ATTEMPT_SQL = `
update public.background_jobs
   set attempt_count = attempt_count + 1,
       updated_at = now()
 where id = $1::uuid
returning attempt_count, max_attempts
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `JobAttemptWriteError` on an actual write.
 *
 * There is no fallback path. A caller that was handed this repository either
 * writes through it or fails.
 */
export function createJobAttemptRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobAttemptRepository {
  return {
    async incrementAttempt(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const jobId = requireWriteArgument(input.jobId, "jobId");

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // System worker write: there is no acting user, so the context is
          // explicitly empty rather than borrowed from a caller. It grants
          // nothing — the statement's own `where id = $1::uuid` is the rule.
          null,
          async (client) => {
            const result = await client.query(INCREMENT_ATTEMPT_SQL, [jobId]);

            // `id` is the primary key, so the statement is at most one row. Zero
            // rows is the "no such job" answer (see the header) and is reported
            // as `null` by the caller below — NOT as a failure.
            if (result.rows.length === 0) return null;

            // More than one row is impossible for the same reason and is treated
            // as a statement/mapper disagreement rather than a value.
            if (result.rows.length !== 1) {
              throw new Error("job attempt write updated more than one row");
            }

            return mapAttemptRow(result.rows[0]);
          },
        );
      } catch (error) {
        throw new JobAttemptWriteError(INCREMENT_ATTEMPT, error);
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
function requireWriteArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobAttemptWriteError(
      INCREMENT_ATTEMPT,
      new Error(`job attempt write needs a non-empty "${field}"`),
    );
  }

  return value;
}

function mapAttemptRow(row: unknown): JobAttemptRow {
  const record = asWriteRow(row);

  return {
    attemptCount: requireRowCount(record, "attempt_count"),
    maxAttempts: requireRowCount(record, "max_attempts"),
  };
}

function asWriteRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job attempt write returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/**
 * A column this statement always answers with a non-negative integer.
 *
 * `integer` columns come back from both drivers as JavaScript numbers, so a
 * string, a float, a negative value or a missing column is drift rather than a
 * count. Folding any of those into a number here would hand the retry decision
 * (`attemptCount > maxAttempts`, `attemptCount >= maxAttempts`) a value the
 * database never produced — and a wrong attempt count silently disables the
 * retry limit or refunds early.
 */
function requireRowCount(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`job attempt write returned no usable "${field}"`);
  }

  return value;
}
