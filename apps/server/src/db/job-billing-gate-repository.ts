/**
 * Job billing gate repository (workorder 21H1, ADR-0001 migration step 2).
 *
 * One question, asked by the worker before it consumes an attempt or calls a
 * model: HAS THIS JOB BEEN PAID FOR YET? `createJob` enqueues the message
 * (`job-service.ts`) before `withBilling` charges the workspace, so the worker
 * can hold a message whose `credits_cost` is still NULL — which today is
 * indistinguishable from "free model" and from "billing is switched off"
 * (risk T-39 ①). This module is the read half and the timeout half of that
 * answer, in the pure `pg` layer.
 *
 * Rules this module keeps:
 *
 * - Exactly two methods, `readBillingGate` and `failUnbilledIfOverdue`. There is
 *   no access token, no workspace id, no job-type argument, no table name and no
 *   generic patch object, so a caller cannot widen either statement: the only
 *   row either one can reach is `id = $1::uuid`.
 * - Every value is a bind parameter, with an explicit cast, so a malformed job id
 *   fails as a real SQL error (SQLSTATE 22P02) inside the transaction instead of
 *   silently matching something else. The one literal in the write statement is
 *   a compile-time constant of this file (`billing_not_confirmed` and its fixed
 *   message), never a caller value.
 * - Both statements run through workorder 19's transaction entry point in
 *   `privileged` mode with a NULL actor. This is the system worker reading and
 *   writing a job row — there is no user behind it, and forging one would put a
 *   person's id on a row they had nothing to do with. The actor `null` is the
 *   honest context, and the pool's role owns `background_jobs` and bypasses RLS,
 *   so the statement's OWN predicate is the only thing selecting the row.
 * - Zero rows is a LEGAL answer for both methods, unlike the 21D profile write
 *   and the 21E1 settings write. For the read it means "no such job row"; for the
 *   write it means "a concurrent writer got there first" (the charge landed, or
 *   the job was cancelled) — an answer the caller acts on by deferring, so
 *   folding it into an error would turn a normal race into a stranded message.
 *   Zero rows is reported as `null` / `false` and the transaction still COMMITs.
 * - The timeout decision is made by the DATABASE, never by this process:
 *   `created_at < now() - make_interval(secs => $2)` compares two server-side
 *   values, so a worker with a skewed clock cannot fail a job early or keep one
 *   alive forever.
 * - The write's entire rule lives in its predicate — `status in
 *   ('queued','retrying') and credits_cost is null and created_at < ...` — and
 *   its `set` list names exactly the five columns a terminal billing failure
 *   owns. That is what makes it ATOMIC against a concurrent `setCreditsInfo`
 *   (which writes `credits_cost`) and against the guarded cancel (which writes
 *   `status`): either the row still matches and this statement claims it, or the
 *   other writer already moved it and this one answers zero rows. A check in
 *   JavaScript followed by an unguarded update would have exactly the race this
 *   predicate removes.
 * - The write does NOT go through `jobService.markFailed`. That transition has
 *   no `credits_cost is null` predicate (it would race a charge that is landing
 *   right now) and its callers treat a changed row as "refund this job" — a job
 *   that was never billed has nothing to refund, and `refundJob` already answers
 *   zero for a NULL cost, so the honest statement is the one below.
 * - A connect, SQL or row-shape failure throws `JobBillingGateError`, whose own
 *   message is fixed text built from the operation name: no SQL, no host, no
 *   connection string, no job id. The driver's own error rides along as `cause`
 *   so a caller can classify it without the driver's message reaching a log line
 *   or an HTTP body.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a gate failure on the call, never a silent fallback: nothing
 *   in this module can reach PostgREST, and a caller with no repository wired at
 *   all cannot silently skip the gate.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * The answer as this module reports it.
 *
 * `status` is the job's own status text, reported verbatim: this module does not
 * decide which statuses the gate applies to (the caller does), because narrowing
 * it here would hide the `running`/`succeeded`/`failed`/`canceled` rows the
 * caller must pass through untouched.
 *
 * `creditsCost` is `number | null` because BOTH are real answers: `null` means
 * "billing has not been recorded" (the state this gate exists for) and `0` is a
 * positive confirmation that the job is free. Folding the two together would
 * re-create the very ambiguity T-39 ① is about.
 *
 * `overdue` is whether the row is older than the caller's confirm window, as
 * decided by the database.
 */
export type JobBillingGateRow = {
  status: string;
  creditsCost: number | null;
  overdue: boolean;
};

export type JobBillingGateInput = {
  jobId: string;
  /** How long a job may stay unbilled before it is treated as overdue. */
  timeoutSeconds: number;
};

export type JobBillingGateRepository = {
  /**
   * Report the job's billing state, or `null` when the row does not exist.
   *
   * A missing job is not an error: the caller's original flow already answers
   * zero rows from the attempt counter by archiving the message.
   */
  readBillingGate(input: JobBillingGateInput): Promise<JobBillingGateRow | null>;
  /**
   * Claim an overdue, unbilled job as terminally failed.
   *
   * `true` = this call changed the row; `false` = the predicate matched nothing
   * (already charged, already cancelled, already terminal, not yet overdue, or
   * no such row). Neither answer is an error.
   */
  failUnbilledIfOverdue(input: JobBillingGateInput): Promise<boolean>;
};

export const READ_BILLING_GATE = "readBillingGate";
export const FAIL_UNBILLED_IF_OVERDUE = "failUnbilledIfOverdue";

export type JobBillingGateOperation =
  | typeof READ_BILLING_GATE
  | typeof FAIL_UNBILLED_IF_OVERDUE;

/**
 * The terminal error code and message this module writes. They are constants of
 * this file, which is what lets the write statement hold them as SQL literals
 * without ever carrying a caller value into statement text. `error_code` is
 * exported because it is part of the contract other layers read back.
 */
export const BILLING_NOT_CONFIRMED_ERROR_CODE = "billing_not_confirmed";

export const BILLING_NOT_CONFIRMED_MESSAGE =
  "Billing was not confirmed before the job started";

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line through us.
 */
export class JobBillingGateError extends Error {
  readonly operation: JobBillingGateOperation;

  constructor(operation: JobBillingGateOperation, cause: unknown) {
    super(
      `job billing gate failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "JobBillingGateError";
    this.operation = operation;
  }
}

/**
 * The read statement — one SELECT, no join, no write.
 *
 * `created_at < now() - make_interval(secs => $2)` is computed in the database:
 * both operands are server-side, so the overdue decision cannot be moved by this
 * process's clock. `$1::uuid` is the explicit cast that makes a malformed id a
 * real parse error instead of a silent non-match.
 *
 * A zero-row answer is not an error to PostgreSQL; it is the "no such job"
 * answer described in the header and is mapped to `null` below.
 */
const READ_BILLING_GATE_SQL = `
select status,
       credits_cost,
       created_at < now() - make_interval(secs => $2) as billing_overdue
  from public.background_jobs
 where id = $1::uuid
`;

/**
 * The write statement. Its whole rule is in the predicate, on purpose:
 *
 * - `status in ('queued','retrying')` — only a job that has not started (and, for
 *   `retrying`, has not been abandoned) may be failed for billing. A `running`
 *   job is being executed, a terminal one is somebody else's answer, and a
 *   `canceled` one must keep its credits story intact.
 * - `credits_cost is null` — the moment `setCreditsInfo` lands, this statement
 *   stops matching. That is the atomic exclusion the gate depends on: no
 *   read-then-write window, so a charge that completes while the worker is
 *   deciding can never be overwritten by a billing failure.
 * - `created_at < now() - make_interval(secs => $2)` — the same server-side
 *   window as the read, re-evaluated at write time.
 *
 * `set` names exactly five columns: the terminal status, the code and message
 * that say why, and the two stamps. `payload`, `result`, `credits_transaction_id`
 * and every transition timestamp of the state machine are NOT reachable.
 *
 * `returning id` is what turns the predicate into an answer: zero rows means the
 * rule did not match, which is a legal `false` and not a failure.
 */
const FAIL_UNBILLED_IF_OVERDUE_SQL = `
update public.background_jobs
   set status = 'failed',
       error_code = 'billing_not_confirmed',
       error_message = 'Billing was not confirmed before the job started',
       failed_at = now(),
       updated_at = now()
 where id = $1::uuid
   and status in ('queued', 'retrying')
   and credits_cost is null
   and created_at < now() - make_interval(secs => $2)
returning id
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `JobBillingGateError` on an actual call.
 *
 * There is no fallback path. A caller that was handed this repository either
 * reads through it or fails — and a failing read is what keeps the worker from
 * executing an unbilled job.
 */
export function createJobBillingGateRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobBillingGateRepository {
  return {
    async readBillingGate(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const jobId = requireGateArgument(READ_BILLING_GATE, input.jobId, "jobId");
      const timeoutSeconds = requireGateSeconds(
        READ_BILLING_GATE,
        input.timeoutSeconds,
        "timeoutSeconds",
      );

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // System worker read: there is no acting user, so the context is
          // explicitly empty rather than borrowed from a caller. It grants
          // nothing — the statement's own `where id = $1::uuid` is the rule.
          null,
          async (client) => {
            const result = await client.query(READ_BILLING_GATE_SQL, [
              jobId,
              timeoutSeconds,
            ]);

            // `id` is the primary key, so the statement is at most one row. Zero
            // rows is the "no such job" answer (see the header) and is reported
            // as `null` — NOT as a failure.
            if (result.rows.length === 0) return null;

            // More than one row is impossible for the same reason and is treated
            // as a statement/mapper disagreement rather than a value: a gate that
            // answered two states has not answered.
            if (result.rows.length !== 1) {
              throw new Error("job billing gate read answered more than one row");
            }

            return mapGateRow(result.rows[0]);
          },
        );
      } catch (error) {
        throw new JobBillingGateError(READ_BILLING_GATE, error);
      }
    },

    async failUnbilledIfOverdue(input) {
      const jobId = requireGateArgument(
        FAIL_UNBILLED_IF_OVERDUE,
        input.jobId,
        "jobId",
      );
      const timeoutSeconds = requireGateSeconds(
        FAIL_UNBILLED_IF_OVERDUE,
        input.timeoutSeconds,
        "timeoutSeconds",
      );

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          null,
          async (client) => {
            const result = await client.query(
              FAIL_UNBILLED_IF_OVERDUE_SQL,
              [jobId, timeoutSeconds],
            );

            // Zero rows: the predicate matched nothing. `false`, and COMMIT.
            if (result.rows.length === 0) return false;

            // The predicate `id = $1::uuid` is the primary key, so at most one
            // row: a second one is a statement/mapper disagreement, not a value.
            if (result.rows.length !== 1) {
              throw new Error(
                "job billing gate write updated more than one row",
              );
            }

            return true;
          },
        );
      } catch (error) {
        throw new JobBillingGateError(FAIL_UNBILLED_IF_OVERDUE, error);
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
 *
 * The refusal carries no value: the message names the FIELD, never the id.
 */
function requireGateArgument(
  operation: JobBillingGateOperation,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobBillingGateError(
      operation,
      new Error(`job billing gate needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * The confirm window is a whole, non-negative number of seconds.
 *
 * A string, a fraction, a negative value or `NaN` is not a window: it would
 * either be rejected by the driver at the far end of a round trip (an opaque
 * failure) or silently shift the deadline by which a job is declared unbilled.
 * The check is cheap, local and has no side effect.
 */
function requireGateSeconds(
  operation: JobBillingGateOperation,
  value: unknown,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new JobBillingGateError(
      operation,
      new Error(`job billing gate needs "${field}" as whole non-negative seconds`),
    );
  }

  return value;
}

function mapGateRow(row: unknown): JobBillingGateRow {
  const record = asGateRow(row);

  return {
    status: requireRowStatus(record, "status"),
    creditsCost: requireRowCost(record, "credits_cost"),
    overdue: requireRowOverdue(record, "billing_overdue"),
  };
}

function asGateRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job billing gate read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/**
 * The job's status decides which arm of the caller's matrix runs, so a missing
 * or non-string status is not a value: folding it into "some other status" would
 * silently PASS the gate for a row whose state nobody could read.
 */
function requireRowStatus(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`job billing gate read returned no usable "${field}"`);
  }

  return value;
}

/**
 * `credits_cost` is `integer NULL`, and BOTH answers are meaningful:
 *
 * - `null` = nothing recorded yet (the state the gate exists to catch),
 * - a non-negative integer = a confirmed charge, `0` included.
 *
 * A string, a float, a negative value or a missing column is drift rather than
 * either of those, and folding it into a number would let a broken read pass as
 * "confirmed": the worker would run an unpaid job on the strength of a value the
 * database never produced.
 */
function requireRowCost(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`job billing gate read returned no usable "${field}"`);
  }

  return value;
}

/**
 * `billing_overdue` is a boolean expression: anything that is not a real boolean
 * means the mapper and the statement disagree. A truthy string would read as
 * "overdue" and fail a job that is merely late; a missing column would read as
 * "not overdue" and defer forever.
 */
function requireRowOverdue(
  row: Readonly<Record<string, unknown>>,
  field: string,
): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new Error(`job billing gate read returned no usable "${field}"`);
  }

  return value;
}
