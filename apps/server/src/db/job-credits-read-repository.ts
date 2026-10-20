/**
 * Job credits read repository (workorder 36K, GN-35 / CV-02).
 *
 * ONE read: the credits of a job as its OWNER may see them — what the job cost,
 * how much of it has been returned, and which ledger row paid for it. It backs
 * `GET /api/jobs/:jobId/credits`, the shape the failed-job line needs to say
 * "已退回 N 积分".
 *
 * Why a route of its own instead of two more columns on the job: the 22-column
 * projection of `backgroundJobSchema` is pinned by a long list of contract cases,
 * and widening it would change all of them for a number that only the failure
 * text reads. This module and its route are read-only and additive.
 *
 * Rules this module keeps:
 *
 * - `readOwnJobCredits` is the entire interface. There is no access token, no
 *   status filter, no table name, no column list and no generic predicate
 *   object, so a caller cannot widen the read: the only rows this module can
 *   ever return are selected by `id = $2::uuid and created_by = $1::uuid`.
 * - The ownership predicate IS the access rule, and it is in the statement, not
 *   in the caller. A job owned by somebody else and a job that does not exist
 *   are the SAME answer (`null`): telling them apart would let any authenticated
 *   caller probe for other people's job ids, so the caller projects both onto
 *   the route's one 404.
 * - The statement runs through workorder 19's transaction entry point in
 *   `privileged` mode WITH the acting user in the context. The predicate is the
 *   rule; the actor is written so the read is attributable. Nothing here relies
 *   on row-level security to narrow the rows, because the pool's role owns the
 *   tables and would see every row.
 * - `credits_refunded` is computed IN the statement: the `generation_refund`
 *   ledger rows of this job, summed, as a non-negative integer, with no row
 *   folded to 0. Migration `20261021000003` makes at most one such row per job
 *   exist, so the sum is the amount actually returned and a second refund cannot
 *   hide inside it.
 * - `credits_cost` is a non-negative `integer` or an explicit SQL NULL. NULL is
 *   NOT folded into 0: "never billed" and "billed zero" are different answers
 *   and the client renders them differently.
 * - `credits_refunded` is never null: `coalesce(..., 0)` happens in SQL, so a
 *   job with no refund row reports 0 rather than an absence the client would
 *   have to guess at.
 * - `credits_transaction_id` is a string or an explicit SQL NULL (the charge was
 *   never linked to a ledger row — a historic or unbilled job).
 * - A column that is MISSING from the row is a failure, not a null. Only an
 *   explicit SQL NULL becomes `null`. Folding the two together would let a
 *   projection that dropped a column read exactly like an unbilled job.
 * - A connect, SQL (including the 22P02 a malformed uuid raises) or row-shape
 *   failure throws `JobCreditsReadError`, whose own message is fixed text: no
 *   SQL, no host, no connection string, no job id, no amount. The driver's own
 *   error rides along as `cause` so a caller can classify it without the driver's
 *   message reaching a log line.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a failure on the read, never a silent fallback: the route
 *   projects it onto its existing `job_query_failed` 500, exactly as the job read
 *   beside it does.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * The credits of one job, keyed the module's own camelCase way — this is not a
 * table-row projection because the only caller reads the four fields directly.
 *
 * `creditsCost` is `null` exactly when the database says NULL (never billed) and
 * `creditsTransactionId` is `null` exactly when the database says NULL (never
 * linked). `creditsRefunded` is always a number: 0 means nothing came back.
 */
export type JobCreditsRow = {
  jobId: string;
  creditsCost: number | null;
  creditsRefunded: number;
  creditsTransactionId: string | null;
};

export type JobCreditsReadRepository = {
  /**
   * Read the credits of the one job with that id, provided `actorId` owns it, or
   * `null` when no such job is the actor's. `null` is not an error: the route
   * answers 404 and the caller learns nothing about other people's ids.
   */
  readOwnJobCredits(input: {
    actorId: string;
    jobId: string;
  }): Promise<JobCreditsRow | null>;
};

export const READ_OWN_JOB_CREDITS = "readOwnJobCredits";

export type JobCreditsReadOperation = typeof READ_OWN_JOB_CREDITS;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential or the job id must never reach a log line through us.
 */
export class JobCreditsReadError extends Error {
  readonly operation: JobCreditsReadOperation;

  constructor(operation: JobCreditsReadOperation, cause: unknown) {
    super(
      `job credits read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "JobCreditsReadError";
    this.operation = operation;
  }
}

/**
 * The columns this statement projects, in the order it names them. Exported so a
 * test can hold the statement's select list against this list: a column added to
 * one and not the other is the drift it refuses.
 */
export const JOB_CREDITS_COLUMNS = [
  "id",
  "credits_cost",
  "credits_transaction_id",
  "credits_refunded",
] as const satisfies readonly (keyof RawJobCreditsRow)[];

/** The row as the drivers hand it back, keyed by COLUMN name. */
type RawJobCreditsRow = {
  id: unknown;
  credits_cost: unknown;
  credits_transaction_id: unknown;
  credits_refunded: unknown;
};

/**
 * The one statement this module can issue.
 *
 * `where j.id = $2::uuid and j.created_by = $1::uuid` is the ONLY row rule: no
 * status, no workspace, no ordering and no limit. Both ids are bind parameters
 * with explicit casts, so a malformed one fails as a real SQL error (SQLSTATE
 * 22P02) inside the transaction instead of silently matching something else.
 *
 * The refund total is a correlated aggregate over `credit_transactions`, so the
 * answer is one row per job and never a client-side sum of a second read.
 */
const READ_OWN_JOB_CREDITS_SQL = `
select
  j.id,
  j.credits_cost,
  j.credits_transaction_id,
  coalesce((
    select sum(t.amount)
    from public.credit_transactions t
    where t.job_id = j.id
      and t.transaction_type = 'generation_refund'
  ), 0)::int as credits_refunded
from public.background_jobs j
where j.id = $2::uuid
  and j.created_by = $1::uuid
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `JobCreditsReadError` on an actual read.
 *
 * There is no fallback path: a caller that was handed this repository either
 * reads through it or fails.
 */
export function createJobCreditsReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobCreditsReadRepository {
  return {
    async readOwnJobCredits(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const actorId = requireReadArgument(input.actorId, "actorId");
      const jobId = requireReadArgument(input.jobId, "jobId");

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // The acting user is in the context so the read is attributable. It
          // grants nothing — the statement's own `created_by` predicate is the
          // rule, and the pool's role owns the table.
          { userId: actorId },
          async (client) => {
            const result = await client.query(READ_OWN_JOB_CREDITS_SQL, [
              actorId,
              jobId,
            ]);

            // `id` is the primary key, so the statement is at most one row. Zero
            // rows is the "no such job, or not yours" answer and is reported as
            // `null` — NOT as a failure.
            if (result.rows.length === 0) return null;

            // More than one row is impossible for the same reason and is treated
            // as a statement/mapper disagreement rather than a value.
            if (result.rows.length !== 1) {
              throw new Error("job credits read returned more than one row");
            }

            return mapCreditsRow(result.rows[0]);
          },
        );
      } catch (error) {
        throw new JobCreditsReadError(READ_OWN_JOB_CREDITS, error);
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
    throw new JobCreditsReadError(
      READ_OWN_JOB_CREDITS,
      new Error(`job credits read needs a non-empty "${field}"`),
    );
  }

  return value;
}

function mapCreditsRow(row: unknown): JobCreditsRow {
  const record = asReadRow(row);

  return {
    jobId: requireJobId(record, "id"),
    creditsCost: optionalCreditsCost(record, "credits_cost"),
    creditsRefunded: requireCreditsRefunded(record, "credits_refunded"),
    creditsTransactionId: optionalIdentity(record, "credits_transaction_id"),
  };
}

function asReadRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job credits read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/** The job the answer is about: a real, non-empty id string, or nothing. */
function requireJobId(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`job credits read returned no usable "${field}"`);
  }

  return value;
}

/**
 * What the job cost.
 *
 * An explicit SQL NULL is `null` — "this job was never billed" — and is NOT
 * turned into 0 here: "not billed" and "billed zero" render differently and the
 * client reads the difference.
 *
 * Anything else must be a real non-negative integer. `integer` columns come back
 * from both drivers as JavaScript numbers, so a string, a float, a negative value
 * or an absent column is drift rather than an amount — and a wrong amount here is
 * a wrong line shown to a person about their money.
 */
function optionalCreditsCost(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`job credits read returned no usable "${field}"`);
  }

  return value;
}

/**
 * What came back.
 *
 * The statement coalesces "no refund row" to 0, so this value is NEVER null: an
 * absent column or an unusable value is a failure rather than a silent 0, because
 * a fabricated 0 would claim nothing was refunded when the database was never
 * asked successfully.
 */
function requireCreditsRefunded(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`job credits read returned no usable "${field}"`);
  }

  return value;
}

/**
 * The ledger row that paid for the job. A nullable uuid column: the only two
 * usable answers are an explicit SQL NULL (`null`) and a string; an ABSENT
 * column is a failure, which is the whole point of reading the two apart.
 */
function optionalIdentity(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new Error(`job credits read returned no usable "${field}"`);
  }

  return value;
}
