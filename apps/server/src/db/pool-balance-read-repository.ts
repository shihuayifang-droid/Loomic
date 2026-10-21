/**
 * Read-only three-pool balance repository (workorder 37P, BL-45 / BL-15 step 5).
 *
 * One statement answers the five numbers `@loomic/shared`'s `PoolBalances` is
 * built from, in exactly the reading `public.deduct_from_pools` (workorder 37N)
 * uses, so the credit a surface PREDICTS is the credit the deduction actually
 * takes:
 *
 * - `daily`               `user_credit_wallets.daily_balance`, but only while
 *                         `daily_date` is TODAY in Asia/Shanghai; an outdated
 *                         day reads as 0, because the balance expires at
 *                         00:00 Beijing time (BL-45) and the deduction would
 *                         never spend it.
 * - `team_remaining`      `greatest(0, pool_limit - pool_used)` of THIS month's
 *                         `team_credit_pools` row; no row means 0, and the
 *                         statement never creates one — a quota is granted by
 *                         `grant_team_cycle` (BL-44), not by a read.
 * - `personal_team_used`  this member's `member_team_usage.used` for this month;
 *                         no row means 0.
 * - `personal_cap`        that row's `personal_cap`; no row means
 *                         `public.member_personal_cap(ws, user)` — the
 *                         cross-month setting 37W added, 20000 when unset
 *                         (BL-45 / D-17).
 * - `topup`               `user_credit_wallets.topup_balance`; no wallet row
 *                         means 0.
 *
 * Rules this module keeps:
 *
 * - The month key and the day key are computed by SQL, not by this process:
 *   `date_trunc('month', now() at time zone 'Asia/Shanghai')::date` and
 *   `(now() at time zone 'Asia/Shanghai')::date`, the same two expressions
 *   `deduct_from_pools` and `grant_daily_credits` use. Computing them in Node
 *   would let the reader and the deduction disagree about which month or which
 *   day "now" is, which is the whole class of bug this read exists to avoid.
 * - Nothing is written: the statement is a single `select`, so a read opens a
 *   transaction, answers, and COMMITs with no row touched. A missing pool row,
 *   usage row or wallet row is a LEGAL answer (0 / 0 / the member's effective
 *   cap) rather than an error, because a member who has never spent or been
 *   granted anything has exactly that state.
 * - Both ids are bind parameters, `$1::uuid` and `$2::uuid`. A malformed one
 *   fails as a real SQL error inside the transaction — no value a caller passes
 *   becomes SQL text, and the shape of a uuid is therefore not pre-validated
 *   here: PostgreSQL's own cast is the authority and the transaction rolls back.
 * - The statement always answers EXACTLY one row (its `bounds` CTE has one row
 *   and every other relation is LEFT JOINed to it), so zero or two rows is a
 *   statement/mapper disagreement rather than a value.
 * - Every number is mapped through `Number()`. The row is read by column name,
 *   and a column that is ABSENT or not a finite number is drift rather than a
 *   value: folding it into 0 would publish a pool balance nobody measured.
 * - The read runs through the privileged transaction entry point of workorder
 *   19 with a NULL actor: it is a system read performed on behalf of a caller
 *   whose authorization was decided above, and the statement's own
 *   `workspace_id` / `user_id` predicates are the rule.
 * - A connect or SQL failure throws `PoolBalanceReadError`, whose message is
 *   fixed text: no SQL, no host, no connection string and no id. The driver's
 *   own error rides along as `cause`.
 */

import type { PoolBalances } from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export const READ_POOL_BALANCES = "readPoolBalances";

export type PoolBalanceReadOperation = typeof READ_POOL_BALANCES;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential or a workspace id must never reach a log line or an HTTP body
 * through us.
 */
export class PoolBalanceReadError extends Error {
  readonly operation: PoolBalanceReadOperation;

  constructor(operation: PoolBalanceReadOperation, cause: unknown) {
    super(
      `pool balance read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "PoolBalanceReadError";
    this.operation = operation;
  }
}

export type PoolBalanceReadRepository = {
  /** BL-45: the member's three pools as `deduct_from_pools` sees them right now. */
  readPoolBalances(input: {
    workspaceId: string;
    userId: string;
  }): Promise<PoolBalances>;
};

/** Fixed row-shape label: a refusal never carries SQL, a host or an id. */
const POOL_BALANCES_LABEL = "pool balance read";

/**
 * The one statement. `bounds` computes the Beijing month key and day key, so
 * the reader and `deduct_from_pools` cannot disagree about "this month" or
 * "today"; the three relations are LEFT JOINed to it, which is what makes "no
 * such row" an all-zero answer instead of zero rows.
 *
 * `coalesce(u.personal_cap, public.member_personal_cap($1::uuid, $2::uuid))`
 * and `coalesce(w.topup_balance, 0)` mirror `deduct_from_pools`' own not-found
 * branches. The cap fallback is the FUNCTION rather than a literal 20000: since
 * 37W a member's cap can live in `member_cap_settings` across months, so a
 * member given a 10000 "intern" template and not yet charged this month reads
 * the cap the deduction would actually enforce. `daily` keeps the wallet's
 * balance only while `daily_date` IS today (`is not distinct from`, so a NULL
 * day is "not today" rather than an unknown).
 *
 * `$1::uuid` and `$2::uuid` are the only row predicates, so nothing a caller
 * passes can widen the read.
 */
const READ_POOL_BALANCES_SQL = `
with bounds as (
  select
    date_trunc('month', now() at time zone 'Asia/Shanghai')::date as v_month,
    (now() at time zone 'Asia/Shanghai')::date as v_today
),
monthly_pool as (
  select p.pool_limit, p.pool_used
    from public.team_credit_pools p
    join bounds b on p.period_month = b.v_month
   where p.workspace_id = $1::uuid
),
member_usage as (
  select u.used, u.personal_cap
    from public.member_team_usage u
    join bounds b on u.period_month = b.v_month
   where u.workspace_id = $1::uuid
     and u.user_id = $2::uuid
),
wallet as (
  select w.daily_date, w.daily_balance, w.topup_balance
    from public.user_credit_wallets w
   where w.user_id = $2::uuid
)
select
  case
    when w.daily_date is not distinct from b.v_today then w.daily_balance
    else 0
  end as daily,
  greatest(0, coalesce(p.pool_limit, 0) - coalesce(p.pool_used, 0)) as team_remaining,
  coalesce(u.used, 0) as personal_team_used,
  coalesce(u.personal_cap, public.member_personal_cap($1::uuid, $2::uuid)) as personal_cap,
  coalesce(w.topup_balance, 0) as topup
from bounds b
left join monthly_pool p on true
left join member_usage u on true
left join wallet w on true
`;

/**
 * Build the PostgreSQL implementation over an already-created pool. Nothing
 * here connects: the pool is the caller's, and a failure only surfaces on an
 * actual read, as a `PoolBalanceReadError`.
 */
export function createPoolBalanceReadRepository(options: {
  pool: TransactionPool;
}): PoolBalanceReadRepository {
  return {
    async readPoolBalances(input) {
      // Arguments first: an unusable one must not open a connection, and it
      // must not be reported as a database failure either.
      const workspaceId = requireReadArgument(input.workspaceId, "workspaceId");
      const userId = requireReadArgument(input.userId, "userId");

      try {
        return await withPrivilegedTransaction(
          options.pool,
          // System read on behalf of an already-authorised caller: the two ids
          // are the statement's own predicates, so the context is explicitly
          // empty rather than borrowed from a caller.
          null,
          async (client) => {
            const result = await client.query(READ_POOL_BALANCES_SQL, [
              workspaceId,
              userId,
            ]);

            // Exactly one row for EVERY (workspace, user) pair — the known one
            // and an unknown one alike — because `bounds` answers one row and
            // everything else is LEFT JOINed to it. Anything else is a
            // disagreement between the statement and this module.
            if (result.rows.length !== 1) {
              throw new Error(
                "pool balance read returned " +
                  `${result.rows.length} rows instead of one`,
              );
            }

            return mapPoolBalancesRow(result.rows[0]);
          },
        );
      } catch (error) {
        throw new PoolBalanceReadError(READ_POOL_BALANCES, error);
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
function requireReadArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PoolBalanceReadError(
      READ_POOL_BALANCES,
      new Error(`pool balance read needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * The five numbers, renamed to the camelCase `PoolBalances` fields and mapped
 * through `Number()`.
 *
 * An ABSENT column and a value that is not a finite number are both drift: the
 * statement above coalesces every aggregate, so a NULL here means the
 * projection itself changed, and reporting it as 0 would publish a pool balance
 * nobody measured.
 */
function mapPoolBalancesRow(row: unknown): PoolBalances {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${POOL_BALANCES_LABEL} returned a row that is not an object`);
  }

  const record = row as Readonly<Record<string, unknown>>;

  return {
    daily: requireNumber(record, "daily"),
    teamRemaining: requireNumber(record, "team_remaining"),
    personalTeamUsed: requireNumber(record, "personal_team_used"),
    personalCap: requireNumber(record, "personal_cap"),
    topup: requireNumber(record, "topup"),
  };
}

function requireNumber(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${POOL_BALANCES_LABEL} returned no usable "${field}"`);
  }

  return Number(value);
}
