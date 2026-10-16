/**
 * Job concurrency counter repository (workorder 21J, ADR-0001 migration step 2).
 *
 * ONE number moves here: the count behind `TierGuard.checkConcurrency`, the plan
 * limit that decides whether a workspace already holds as many unfinished
 * generation jobs as its plan allows. It used to be an admin PostgREST `count:
 * "exact", head: true` over `background_jobs`; it is now the single `count(*)`
 * below, over the same table, the same workspace predicate and the same three
 * statuses.
 *
 * Rules this module keeps:
 *
 * - `countActiveJobs` is the entire interface. There is no access token, no
 *   table name, no status argument and no generic predicate object, so a caller
 *   cannot widen the read: the only rows this module can ever count are the ones
 *   the statement's own two predicates select.
 * - The status set is written INTO the statement as a literal list, never bound
 *   as a parameter. `status` is the enum `public.background_job_status`, and a
 *   JavaScript array binds as `text[]` — `text[]` and that enum have no common
 *   type, so the comparison would fail to plan instead of counting. The list is
 *   therefore part of the statement, and the unit test beside this file pins it
 *   against the three statuses the plan rule is about.
 * - The three statuses are `queued`, `running` and `retrying`. A retrying job
 *   still holds its slot — and its pre-charged credits — so it counts towards the
 *   limit exactly as it did through the admin read. `succeeded`, `failed`,
 *   `canceled` and the legacy terminal `dead_letter` are finished and do not.
 * - `count(*)` is `bigint`, which `pg` hands back as a STRING (and PGlite as a
 *   bigint), so the statement casts to `int` and this module then REFUSES
 *   anything that is not already a JavaScript non-negative integer. The old read
 *   compared a possibly-string count with `>=` and interpolated it into the 429
 *   message; a string that reached a caller would keep working by accident
 *   (`"3" >= 2` is true) while `(3/4)` in the message silently changed shape.
 * - The answer is exactly one row, always: `count(*)` over a table is one row
 *   even when it counts zero. Zero rows or more than one row is a
 *   statement/mapper disagreement rather than a value and fails loud. Zero as
 *   the COUNT is of course legal and means "nothing is running".
 * - The statement runs through workorder 19's transaction entry point in
 *   `privileged` mode with a NULL actor. This is a system read on behalf of a
 *   request that has not been authorised to read job rows: it exposes one
 *   integer and no row, and forging an actor would put a person's id on an audit
 *   trail they had nothing to do with.
 * - A connect, SQL (including the 22P02 a malformed uuid raises) or row-shape
 *   failure throws `JobConcurrencyError`, whose own message is fixed text: no
 *   SQL, no host, no connection string, no workspace id. The driver's own error
 *   rides along as `cause`, so a caller can classify it without the driver's
 *   message reaching a log line — which matters here, because `TierGuard` LOGS
 *   this failure and must log a fixed string instead (workorder 21J §6).
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a failure on the count, never a silent fallback: nothing in
 *   this module can reach PostgREST, and with no repository wired `TierGuard`
 *   fails open (logs and allows the request) rather than counting through the
 *   admin client it used to hold.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type JobConcurrencyRepository = {
  /**
   * How many of that workspace's jobs are still holding a concurrency slot:
   * `queued`, `running` or `retrying`. Zero is a legal answer.
   */
  countActiveJobs(input: { workspaceId: string }): Promise<number>;
};

export const COUNT_ACTIVE_JOBS = "countActiveJobs";

export type JobConcurrencyOperation = typeof COUNT_ACTIVE_JOBS;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential or the workspace id must never reach a log line through us.
 */
export class JobConcurrencyError extends Error {
  readonly operation: JobConcurrencyOperation;

  constructor(operation: JobConcurrencyOperation, cause: unknown) {
    super(
      `job concurrency count failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "JobConcurrencyError";
    this.operation = operation;
  }
}

/**
 * The one statement this module can issue.
 *
 * Exactly one table is reachable and there is no join, no subquery, no
 * `order by` and no `limit`: the answer is a single number and nothing else.
 * `where workspace_id = $1::uuid` is the only bind parameter, with an explicit
 * cast so a malformed id fails as a real SQL error (SQLSTATE 22P02) inside the
 * transaction instead of silently matching something else.
 *
 * `status in ('queued', 'running', 'retrying')` is statement TEXT, not a bind
 * parameter (see the header). `count(*)::int` is the cast that keeps the answer
 * a JavaScript number instead of the string `bigint` arrives as.
 */
const COUNT_ACTIVE_JOBS_SQL = `
select count(*)::int as active
from public.background_jobs
where workspace_id = $1::uuid
  and status in ('queued', 'running', 'retrying')
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `JobConcurrencyError` on an actual count.
 *
 * There is no fallback path. A caller that was handed this repository either
 * counts through it or fails.
 */
export function createJobConcurrencyRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobConcurrencyRepository {
  return {
    async countActiveJobs(input) {
      // Arguments first: an unusable one must not open a connection, and it
      // must not be reported as a database failure either.
      const workspaceId = requireCountArgument(
        input.workspaceId,
        "workspaceId",
      );

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // System read: there is no acting user, so the context is explicitly
          // empty rather than borrowed from a caller. It grants nothing — the
          // statement's own predicates are the rule.
          null,
          async (client) => {
            const result = await client.query(COUNT_ACTIVE_JOBS_SQL, [
              workspaceId,
            ]);

            // `count(*)` aggregates the whole table into exactly one row, so
            // any other row count is a statement/mapper disagreement.
            if (result.rows.length !== 1) {
              throw new Error(
                "job concurrency count returned an unexpected number of rows",
              );
            }

            return mapCountRow(result.rows[0]);
          },
        );
      } catch (error) {
        throw new JobConcurrencyError(COUNT_ACTIVE_JOBS, error);
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
function requireCountArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobConcurrencyError(
      COUNT_ACTIVE_JOBS,
      new Error(`job concurrency count needs a non-empty "${field}"`),
    );
  }

  return value;
}

function mapCountRow(row: unknown): number {
  const record = asCountRow(row);

  return requireActiveCount(record, "active");
}

function asCountRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job concurrency count returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/**
 * The column this statement always answers with a non-negative integer.
 *
 * The `::int` cast is what makes a JavaScript number possible at all: without
 * it `count(*)` is `bigint` and arrives as a string. A string, a float, a
 * negative value, `NaN`, an infinity or an absent column is therefore drift
 * rather than a count, and folding any of them into a number here would hand the
 * plan check a value the database never produced — a wrong count silently
 * disables the concurrency limit, or blocks a workspace that is under it.
 */
function requireActiveCount(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`job concurrency count returned no usable "${field}"`);
  }

  return value;
}
