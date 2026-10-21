/**
 * The two pool grants (workorder 37R, BL-44 / BL-45).
 *
 * `public.grant_team_cycle` (37O) creates this month's `team_credit_pools` row,
 * writes the `cycle_reset` of the previous month's remainder and the
 * `cycle_grant` of the new limit. `public.grant_daily_credits` (37O) expires
 * yesterday's unspent daily credits and puts today's grant into the member's
 * wallet. Both are idempotent per month / per day, which is what lets this
 * module be called by a plain repeating timer and by an ordinary balance read
 * without either of them having to know whether "the grant already happened".
 *
 * Two rules this module keeps, both borrowed from the read beside it
 * (`pool-balance-read-repository.ts`):
 *
 * - The grants run through the privileged transaction entry point of workorder
 *   19 with a NULL actor. They are system writes performed on behalf of a
 *   caller whose authorization was decided above, and the two functions are
 *   service-role only (37O revokes them from anon and authenticated), so there
 *   is no user identity they could legitimately borrow.
 * - A connect or SQL failure throws `PoolGrantWriteError`, whose message is
 *   fixed text: no SQL, no host, no connection string and no id. The driver's
 *   own error rides along as `cause`, and the transaction rolls back, so a
 *   failed grant never leaves half a month behind.
 *
 * Which workspace is "the team" is decided by SQL, not by this process: the one
 * `workspaces` row with `type = 'team'`, ordered the way
 * `team-admin-read-repository.ts` orders it. There is at most one
 * (`workspaces_single_team_key`), so the ordering only has to be deterministic.
 * With no such row both statements answer nothing at all, and the caller is told
 * so — `null` for the cycle grant — rather than being handed a fake 0 limit.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export const GRANT_TEAM_CYCLE = "grantTeamCycle";
export const GRANT_DAILY_CREDITS = "grantDailyCredits";

export type PoolGrantWriteOperation =
  | typeof GRANT_TEAM_CYCLE
  | typeof GRANT_DAILY_CREDITS;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential or a user id must never reach a log line through us.
 */
export class PoolGrantWriteError extends Error {
  readonly operation: PoolGrantWriteOperation;

  constructor(operation: PoolGrantWriteOperation, cause: unknown) {
    super(
      `pool grant write failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "PoolGrantWriteError";
    this.operation = operation;
  }
}

export type PoolGrantWriteRepository = {
  /** BL-44: grant this month's team pool to the team workspace. Returns the pool limit, or null when there is no team workspace. Idempotent. */
  grantTeamCycle(): Promise<number | null>;
  /** BL-45: grant today's daily credits to this member. Returns true when granted now, false when already granted today. */
  grantDailyCredits(input: {
    userId: string;
    workspaceId: string;
  }): Promise<boolean>;
};

/** Fixed row-shape label: a refusal never carries SQL, a host or an id. */
const POOL_GRANT_LABEL = "pool grant write";

/**
 * The one statement of the monthly grant.
 *
 * The team workspace is found here rather than passed in, so "which workspace
 * receives the quota" is the schema's answer and not a caller's. `limit 1`
 * above the projection is what keeps a stray second `team` row (impossible
 * under `workspaces_single_team_key`, but not this module's assumption to
 * weaken) from granting twice; with no `team` row the statement answers ZERO
 * rows, which is the "nothing to grant" answer this module propagates as null.
 */
const GRANT_TEAM_CYCLE_SQL = `
select public.grant_team_cycle(w.id) as pool_limit
  from public.workspaces w
 where w.type = 'team'
 order by w.created_at asc
 limit 1
`;

/**
 * The one statement of the daily grant. Both ids are bind parameters,
 * `$1::uuid` and `$2::uuid`: a malformed one fails as a real SQL error inside
 * the transaction, and no value a caller passes becomes SQL text. The function
 * itself answers `true` when it granted and `false` when today was already
 * granted (37O).
 */
const GRANT_DAILY_CREDITS_SQL = `
select public.grant_daily_credits($1::uuid, $2::uuid) as granted
`;

/**
 * Build the PostgreSQL implementation over a pool getter. Nothing here
 * connects: the getter is called per grant, so a process that never grants (a
 * web process with no team workspace, a worker between months) never opens a
 * connection for this module, and a failure only surfaces on an actual grant.
 */
export function createPoolGrantWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): PoolGrantWriteRepository {
  return {
    async grantTeamCycle() {
      try {
        return await withPrivilegedTransaction(
          options.getTransactionPool(),
          // System write on behalf of an already-authorised caller: there is no
          // user identity to borrow, and the statement's own `type = 'team'`
          // predicate is the whole rule.
          null,
          async (client) => {
            const result = await client.query(GRANT_TEAM_CYCLE_SQL);

            // No team workspace is a LEGAL answer, and it is the only one that
            // is not a row: the statement is `limit 1`, so two rows would be a
            // statement this module no longer understands.
            if (result.rows.length === 0) return null;
            if (result.rows.length !== 1) {
              throw new Error(
                "pool grant write returned " +
                  `${result.rows.length} rows instead of one`,
              );
            }

            return mapPoolLimitRow(result.rows[0]);
          },
        );
      } catch (error) {
        throw new PoolGrantWriteError(GRANT_TEAM_CYCLE, error);
      }
    },

    async grantDailyCredits(input) {
      // Arguments first: an unusable one must not open a connection, and it
      // must not be reported as a database failure either.
      const userId = requireGrantArgument(input.userId, "userId");
      const workspaceId = requireGrantArgument(input.workspaceId, "workspaceId");

      try {
        return await withPrivilegedTransaction(
          options.getTransactionPool(),
          null,
          async (client) => {
            const result = await client.query(GRANT_DAILY_CREDITS_SQL, [
              userId,
              workspaceId,
            ]);

            if (result.rows.length !== 1) {
              throw new Error(
                "pool grant write returned " +
                  `${result.rows.length} rows instead of one`,
              );
            }

            return mapGrantedRow(result.rows[0]);
          },
        );
      } catch (error) {
        throw new PoolGrantWriteError(GRANT_DAILY_CREDITS, error);
      }
    },
  };
}

/**
 * A bound id is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction,
 * the transaction rolls back and the connection stays usable.
 */
function requireGrantArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PoolGrantWriteError(
      GRANT_DAILY_CREDITS,
      new Error(`pool grant write needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * The new month's limit, mapped through `Number()`.
 *
 * An ABSENT column and a value that is not a finite number are both drift: the
 * function's declared return type is `integer`, so a NULL here means the
 * projection changed, and reporting it as 0 would say "granted zero credits"
 * about a month nobody granted.
 */
function mapPoolLimitRow(row: unknown): number {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${POOL_GRANT_LABEL} returned a row that is not an object`);
  }

  const record = row as Readonly<Record<string, unknown>>;
  const value = record.pool_limit;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${POOL_GRANT_LABEL} returned no usable "pool_limit"`);
  }

  return Number(value);
}

/**
 * `grant_daily_credits` answers a BOOLEAN, and both answers are information:
 * `true` means this call granted, `false` means today was already granted. A
 * missing or non-boolean value is therefore drift, not "false".
 */
function mapGrantedRow(row: unknown): boolean {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${POOL_GRANT_LABEL} returned a row that is not an object`);
  }

  const value = (row as Readonly<Record<string, unknown>>).granted;
  if (typeof value !== "boolean") {
    throw new Error(`${POOL_GRANT_LABEL} returned no usable "granted"`);
  }

  return value;
}
