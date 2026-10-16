/**
 * Job refund basis repository (workorder 21O, ADR-0001 migration step 2).
 *
 * ONE read moves here: the admin single-row lookup `worker.ts` performed before
 * it could refund a terminally failed job. It projected three columns of one
 * `background_jobs` row — `credits_cost`, `workspace_id`, `created_by` — and it
 * is the only place the refund path ever learned HOW MUCH to give back and to
 * WHOM. The admin PostgREST call it replaces discarded its `error` field, so a
 * failed read and a missing row were the same answer (refund nothing, silently);
 * the statement below is the same projection, read through the pure `pg` layer.
 *
 * Rules this module keeps:
 *
 * - `readRefundBasis` is the entire interface. There is no access token, no
 *   status filter, no table name, no column list and no generic predicate
 *   object, so a caller cannot widen the read: the only row this module can ever
 *   return is `id = $1::uuid`.
 * - The projection names exactly the three columns the refund decision reads,
 *   in the order the displaced call named them. `credits_cost` and `created_by`
 *   are nullable in the schema; `workspace_id` is not.
 * - The statement runs through workorder 19's transaction entry point in
 *   `privileged` mode with a NULL actor. This is a system read on a job row —
 *   the worker is not acting as any user — and forging an actor would put a
 *   person's id on an audit trail they had nothing to do with. The pool's role
 *   owns `background_jobs`, so the statement's OWN predicate
 *   (`where id = $1::uuid`) is the only thing selecting the row.
 * - Zero rows is a LEGAL answer and is reported as `null`, exactly as the
 *   displaced read's null row was: the refund path then refunds NOTHING. Folding
 *   it into an error would turn "this job has no row" into a refund failure, and
 *   the caller would log a failure that says nothing about the money. The
 *   transaction still COMMITs. `id` is the primary key, so more than one row is
 *   a statement/mapper disagreement rather than a value and throws.
 * - `credits_cost` is a non-negative `integer` or an explicit SQL NULL. A
 *   string, a float, a negative value or an absent column is drift, not an
 *   amount: the refund moves real credits, so an amount the database never
 *   produced must never reach `refundCredits`. NULL is NOT folded into 0 here —
 *   the caller's own `?? 0` is the one place that happens, exactly as before.
 * - `workspace_id` is a non-empty string: it is NOT NULL in the schema and it is
 *   the account a refund would be credited to, so an absent or empty one is a
 *   failure rather than a refund with nowhere to go.
 * - `created_by` is a string or an explicit SQL NULL. Historic rows may carry
 *   NULL, and the caller's `!createdBy` guard is the rule that keeps those rows
 *   unrefunded; this module reports the NULL rather than inventing a user.
 * - A column that is MISSING from the row is a failure, not a null. Only an
 *   explicit SQL NULL becomes `null`. Folding the two together would let a
 *   projection that dropped a column read exactly like a job whose cost and
 *   creator are both absent — silently refunding nothing (workorder 20D-fixup).
 * - A connect, SQL (including the 22P02 a malformed uuid raises) or row-shape
 *   failure throws `JobRefundBasisError`, whose own message is fixed text: no
 *   SQL, no host, no connection string, no job id, no amount. The driver's own
 *   error rides along as `cause` so a caller can classify it without the
 *   driver's message reaching a log line.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a failure on the read, never a silent fallback: nothing in
 *   this module can reach PostgREST, and with no repository wired the refund
 *   path fails closed (it logs and refunds nothing) instead of reaching for the
 *   admin client it used to read through. It never moves money on a guess.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * The refund basis of one job: the amount, the account and the person, and
 * nothing else. Keys are the module's own camelCase names — this is not a
 * table-row projection (unlike the admin job read) because the only caller
 * reads the three fields directly.
 *
 * `creditsCost` is `null` exactly when the database says NULL (a job that was
 * never charged) and `createdBy` is `null` exactly when the database says NULL
 * (a historic row). `workspaceId` is never null: the column is NOT NULL.
 */
export type JobRefundBasisRow = {
  creditsCost: number | null;
  workspaceId: string;
  createdBy: string | null;
};

export type JobRefundBasisRepository = {
  /**
   * Read the refund basis of the one job with that id, or `null` when no such
   * row exists. A missing job is not an error the caller should retry: the
   * caller refunds nothing, which is what the displaced read did too.
   */
  readRefundBasis(input: { jobId: string }): Promise<JobRefundBasisRow | null>;
};

export const READ_REFUND_BASIS = "readRefundBasis";

export type JobRefundBasisOperation = typeof READ_REFUND_BASIS;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential or the job id must never reach a log line through us — and the
 * worker logs every failure of this read.
 */
export class JobRefundBasisError extends Error {
  readonly operation: JobRefundBasisOperation;

  constructor(operation: JobRefundBasisOperation, cause: unknown) {
    super(
      `job refund basis read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "JobRefundBasisError";
    this.operation = operation;
  }
}

/**
 * The columns this statement projects, in the order the displaced read named
 * them. Exported so a test can hold the statement's select list against this
 * list: a column added to one and not the other is the drift it refuses.
 */
export const JOB_REFUND_BASIS_COLUMNS = [
  "credits_cost",
  "workspace_id",
  "created_by",
] as const satisfies readonly (keyof RawRefundBasisRow)[];

/** The row as the drivers hand it back, keyed by COLUMN name. */
type RawRefundBasisRow = {
  credits_cost: unknown;
  workspace_id: unknown;
  created_by: unknown;
};

/**
 * The one statement this module can issue.
 *
 * `where id = $1::uuid` is the ONLY predicate: no status, no workspace, no
 * ordering and no limit. The id is a bind parameter with an explicit cast, so a
 * malformed one fails as a real SQL error (SQLSTATE 22P02) inside the
 * transaction instead of silently matching something else. There is exactly one
 * selected table, and the statement is never a batch.
 */
const READ_REFUND_BASIS_SQL = `
select credits_cost, workspace_id, created_by
from public.background_jobs
where id = $1::uuid
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `JobRefundBasisError` on an actual read.
 *
 * There is no fallback path. A caller that was handed this repository either
 * reads through it or fails — and the refund path treats a failure as "refund
 * nothing", never as "refund something".
 */
export function createJobRefundBasisRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobRefundBasisRepository {
  return {
    async readRefundBasis(input) {
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
            const result = await client.query(READ_REFUND_BASIS_SQL, [jobId]);

            // `id` is the primary key, so the statement is at most one row. Zero
            // rows is the "no such job" answer (see the header) and is reported
            // as `null` — NOT as a failure.
            if (result.rows.length === 0) return null;

            // More than one row is impossible for the same reason and is treated
            // as a statement/mapper disagreement rather than a value.
            if (result.rows.length !== 1) {
              throw new Error("job refund basis read returned more than one row");
            }

            return mapRefundBasisRow(result.rows[0]);
          },
        );
      } catch (error) {
        throw new JobRefundBasisError(READ_REFUND_BASIS, error);
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
    throw new JobRefundBasisError(
      READ_REFUND_BASIS,
      new Error(`job refund basis read needs a non-empty "${field}"`),
    );
  }

  return value;
}

function mapRefundBasisRow(row: unknown): JobRefundBasisRow {
  const record = asReadRow(row);

  return {
    creditsCost: optionalCreditsCost(record, "credits_cost"),
    workspaceId: requireWorkspaceId(record, "workspace_id"),
    createdBy: optionalIdentity(record, "created_by"),
  };
}

function asReadRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job refund basis read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/**
 * The amount, which is the whole point of this read.
 *
 * An explicit SQL NULL is `null` — "this job was never charged" — and is NOT
 * turned into 0 here: the caller's own `?? 0` is the single place that happens,
 * and moving it in here would hide the difference between "no cost recorded" and
 * "a cost of zero" from every test that pins the refund condition.
 *
 * Anything else must be a real non-negative integer. `integer` columns come back
 * from both drivers as JavaScript numbers, so a string, a float, a negative
 * value or an absent column is drift rather than an amount — and a wrong amount
 * is money moved to or from a workspace.
 */
function optionalCreditsCost(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`job refund basis read returned no usable "${field}"`);
  }

  return value;
}

/**
 * The account a refund would be credited to. It is NOT NULL in the schema and
 * the caller's `!workspaceId` guard is the second half of the rule, so an
 * unusable value here is a failure rather than a refund with nowhere to go.
 */
function requireWorkspaceId(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`job refund basis read returned no usable "${field}"`);
  }

  return value;
}

/**
 * The person the credits are credited back to. A nullable uuid column: the only
 * two usable answers are an explicit SQL NULL (`null`) and a string; an ABSENT
 * column is a failure, which is the whole point of reading the two apart. An
 * empty string is passed along rather than rejected, because the caller's own
 * `!createdBy` guard covers it exactly as it covered the displaced read's value.
 */
function optionalIdentity(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new Error(`job refund basis read returned no usable "${field}"`);
  }

  return value;
}
