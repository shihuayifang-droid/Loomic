/**
 * Read-only member credit summary repository (workorder 37Z, AD-01 step 1).
 *
 * The existing `GET /api/admin/team/members` answers who a team's members are —
 * name, email, role — and nothing about their credits. This module answers the
 * credit half for EVERY member of the workspace in ONE statement, so the admin
 * member list can merge the two by `userId` instead of issuing one balance read
 * per member:
 *
 * - `personalCap`      this month's `member_team_usage.personal_cap`; no row
 *                      means `public.member_personal_cap(ws, user)` — the
 *                      cross-month setting 37W added (20000 when unset), which
 *                      is the same fallback `deduct_from_pools` uses.
 * - `teamUsed`         this month's `member_team_usage.used`; no row means 0.
 * - `topup`            `user_credit_wallets.topup_balance`; no wallet row means 0.
 * - `dailyRemaining`   `user_credit_wallets.daily_balance`, but only while
 *                      `daily_date` is TODAY in Asia/Shanghai; an outdated day
 *                      reads as 0, because the balance expires at 00:00 Beijing
 *                      time (BL-45) and the deduction would never spend it.
 *
 * The reading is deliberately the same one `pool-balance-read-repository.ts`
 * (37P) performs per member, and the month key and day key are computed by SQL
 * rather than by this process: `date_trunc('month', now() at time zone
 * 'Asia/Shanghai')::date` and `(now() at time zone 'Asia/Shanghai')::date`, the
 * two expressions `deduct_from_pools` and `grant_daily_credits` use. Computing
 * them in Node would let the reader and the deduction disagree about which
 * month or which day "now" is.
 *
 * Rules this module keeps:
 *
 * - Nothing is written: the statement is a single `select`, so a read opens a
 *   transaction, answers, and COMMITs with no row touched. A missing usage row
 *   or wallet row is a LEGAL answer (0 / 0 / the member's effective cap) rather
 *   than an error, because a member who has never spent reads exactly that.
 * - The workspace id is the statement's only bind parameter, `$1::uuid`, and
 *   the workspace is the row source (`workspace_members`), so nothing a caller
 *   passes can widen the read past one team.
 * - Ids are ordered by `workspace_members.created_at asc, user_id asc`, which
 *   is stable across reads of an unchanged workspace. `workspace_members` has
 *   carried `created_at` since the foundation migration
 *   (`20260323000001_loomic_supabase_foundation_v1.sql`).
 * - Every number is mapped through `Number()`. The row is read by column name,
 *   and a column that is ABSENT or not a finite number is drift rather than a
 *   value: folding it into 0 would publish a member's credits nobody measured.
 * - The read runs through the privileged transaction entry point of workorder
 *   19 with a NULL actor: it is a system read performed on behalf of a caller
 *   whose authorization was decided above, and the statement's own
 *   `workspace_id` predicate is the rule.
 * - A connect or SQL failure throws `MemberCreditReadError`, whose message is
 *   fixed text: no SQL, no host, no connection string and no id. The driver's
 *   own error rides along as `cause`.
 */

import type { MemberCreditSummary } from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export const LIST_MEMBER_CREDITS = "listMemberCredits";

export type MemberCreditReadOperation = typeof LIST_MEMBER_CREDITS;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential or a workspace id must never reach a log line or an HTTP body
 * through us.
 */
export class MemberCreditReadError extends Error {
  readonly operation: MemberCreditReadOperation;

  constructor(operation: MemberCreditReadOperation, cause: unknown) {
    super(
      `member credit read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "MemberCreditReadError";
    this.operation = operation;
  }
}

export type MemberCreditReadRepository = {
  /** AD-01: every member of one workspace with their credit numbers. */
  listMemberCredits(input: {
    workspaceId: string;
  }): Promise<MemberCreditSummary[]>;
};

/** Fixed row-shape label: a refusal never carries SQL, a host or an id. */
const MEMBER_CREDITS_LABEL = "member credit read";

/**
 * The one statement. `bounds` computes the Beijing month key and day key, so
 * the reader and `deduct_from_pools` cannot disagree about "this month" or
 * "today"; the usage and wallet relations are LEFT JOINed to the workspace's
 * membership rows, which is what makes "no such row" an all-zero answer instead
 * of a missing member.
 *
 * `coalesce(u.personal_cap, public.member_personal_cap($1::uuid, m.user_id))`
 * and `coalesce(w.topup_balance, 0)` mirror `deduct_from_pools`' own not-found
 * branches. The cap fallback is the FUNCTION rather than a literal 20000: since
 * 37W a member's cap can live in `member_cap_settings` across months, so a
 * member given a 10000 "intern" template and not yet charged this month reads
 * the cap the deduction would actually enforce. `dailyRemaining` keeps the
 * wallet's balance only while `daily_date` IS today (`is not distinct from`, so
 * a NULL day is "not today" rather than an unknown).
 *
 * `$1::uuid` is the only row predicate, so nothing a caller passes can widen the
 * read past one workspace.
 */
const LIST_MEMBER_CREDITS_SQL = `
with bounds as (
  select
    date_trunc('month', now() at time zone 'Asia/Shanghai')::date as v_month,
    (now() at time zone 'Asia/Shanghai')::date as v_today
)
select
  m.user_id::text as user_id,
  coalesce(u.personal_cap, public.member_personal_cap($1::uuid, m.user_id)) as personal_cap,
  coalesce(u.used, 0) as team_used,
  coalesce(w.topup_balance, 0) as topup,
  case
    when w.daily_date is not distinct from b.v_today
      then coalesce(w.daily_balance, 0)
    else 0
  end as daily_remaining
from public.workspace_members m
cross join bounds b
left join public.member_team_usage u
  on u.workspace_id = m.workspace_id
 and u.user_id = m.user_id
 and u.period_month = b.v_month
left join public.user_credit_wallets w
  on w.user_id = m.user_id
where m.workspace_id = $1::uuid
order by m.created_at asc, m.user_id asc
`;

/**
 * Build the PostgreSQL implementation over a pool GETTER. Nothing here
 * connects: the pool is the caller's, resolved per read, and a failure only
 * surfaces on an actual read, as a `MemberCreditReadError`.
 */
export function createMemberCreditReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): MemberCreditReadRepository {
  return {
    async listMemberCredits(input) {
      // Arguments first: an unusable one must not open a connection, and it
      // must not be reported as a database failure either.
      const workspaceId = requireReadArgument(input.workspaceId);

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // System read on behalf of an already-authorised caller: the
          // workspace id is the statement's own predicate, so the context is
          // explicitly empty rather than borrowed from a caller.
          null,
          async (client) => {
            const result = await client.query(LIST_MEMBER_CREDITS_SQL, [
              workspaceId,
            ]);

            // Zero rows is a LEGAL answer (a workspace with no members), so the
            // row count is not validated here: every returned row is mapped, and
            // a row that does not carry the projection is drift.
            return result.rows.map(mapMemberCreditRow);
          },
        );
      } catch (error) {
        throw new MemberCreditReadError(LIST_MEMBER_CREDITS, error);
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
function requireReadArgument(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MemberCreditReadError(
      LIST_MEMBER_CREDITS,
      new Error('member credit read needs a non-empty "workspaceId"'),
    );
  }

  return value;
}

/**
 * One member's row, renamed to the camelCase `MemberCreditSummary` fields.
 *
 * An ABSENT column and a value that is not a finite number are both drift: the
 * statement above coalesces every number, so a NULL here means the projection
 * itself changed, and reporting it as 0 would publish a member's credits nobody
 * measured. The member id is the key the admin list merges on, so an empty one
 * is drift too.
 */
function mapMemberCreditRow(row: unknown): MemberCreditSummary {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${MEMBER_CREDITS_LABEL} returned a row that is not an object`);
  }

  const record = row as Readonly<Record<string, unknown>>;
  const userId = record.user_id;

  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error(`${MEMBER_CREDITS_LABEL} returned no usable "user_id"`);
  }

  return {
    userId,
    personalCap: requireNumber(record, "personal_cap"),
    teamUsed: requireNumber(record, "team_used"),
    topup: requireNumber(record, "topup"),
    dailyRemaining: requireNumber(record, "daily_remaining"),
  };
}

function requireNumber(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${MEMBER_CREDITS_LABEL} returned no usable "${field}"`);
  }

  return Number(value);
}
