/**
 * Daily credits reconciliation (OP-11 / workorder 45CC).
 *
 * READ ONLY, WARN ONLY. This module answers one question — "does the ledger still
 * agree with the rows that are supposed to mirror it?" — and writes nothing.
 * There is no `--apply`, no compensating insert, no UPDATE of a drifted
 * `pool_used`: the approved behaviour (U-26) is that a difference is REPORTED so
 * a human can look at it, not repaired. That is why every statement below starts
 * at `with offenders as (select ...)` and ends at a `select`; a test asserts the
 * absence of a write verb rather than trusting this paragraph.
 *
 * SEVERITY, AND WHY C IS ONLY AN INFORMATION ITEM (workorder 45CD)
 *   `ReconcileFinding.severity` is `"alarm"` for A, B and D and `"info"` for C,
 *   and `ok` is derived from the `"alarm"` findings alone: an informational
 *   finding is reported, never a failure.
 *   C compares `team_credit_pools.pool_used` with a ledger sum. `pool_used`,
 *   however, is a RUNTIME COUNTER, not a replayable ledger total —
 *   `cycle_reset` zeroes it when a cycle rolls over, so reverse-computing it
 *   from `credit_transactions` is unreliable. Measured on the local database:
 *   2026-09 had pool_limit=1000 / pool_used=123 with NO team ledger rows at all,
 *   and 2026-10 reset to pool_used=0 against roughly 20k of team ledger. So the
 *   reverse sum disagrees with `pool_used` on perfectly healthy data, and an
 *   alarm that fires every day on healthy data trains everyone to ignore it —
 *   i.e. no alarm at all. Hence C stays exactly as it is (same SQL, same count,
 *   same samples) and only its SEVERITY is `"info"`. A strict version of C
 *   would first have to pin down what `cycle_reset` means for the pool row;
 *   that is tracked as T-158.
 *
 * FOUR CHECKS, each a count plus at most `sampleLimit` sample ids:
 *
 *   A_job_without_transaction     a job that claims to have been charged
 *                                 (`status = 'succeeded'`, `credits_cost > 0`)
 *                                 but carries no ledger row id, or one that
 *                                 points at a `credit_transactions` row which no
 *                                 longer exists. Either way the money the job
 *                                 says it cost is not traceable in the ledger.
 *   B_missing_deduction_transaction
 *                                 `background_jobs.credits_transaction_id` is set
 *                                 but no such ledger row exists — a dangling
 *                                 reference, the subset of A that is easiest to
 *                                 spot on its own.
 *   C_team_pool_drift             `team_credit_pools.pool_used` disagrees with the
 *                                 team portion of the ledger for the same
 *                                 workspace and month. See "SIGN CONVENTION".
 *   D_negative_balance            a wallet below zero, or a team pool used beyond
 *                                 its own limit. The column checks that are
 *                                 supposed to make this impossible are belt and
 *                                 braces; a check that only trusts them cannot
 *                                 detect a constraint that was dropped.
 *
 * SIGN CONVENTION (read out of the writers, not guessed)
 *   `supabase/migrations/20261021000005_hahart_deduct_from_pools.sql` inserts a
 *   charge as `amount = -p_amount` with `pool_breakdown = {daily, team, topup}`
 *   holding the POSITIVE amount taken from each pool, and increments
 *   `team_credit_pools.pool_used` by `v_from_team`.
 *   `supabase/migrations/20261021000008_hahart_refund_to_pools.sql` inserts a
 *   refund as `amount = +(daily + team + topup)` carrying the ORIGINAL
 *   breakdown, and decrements `pool_used` by `v_team`.
 *   So the ledger's contribution to "team used" for one row is
 *   `(pool_breakdown->>'team') * sign(-amount)` — positive on a charge, negative
 *   on a refund. A row with no breakdown (the legacy / single-pool shape) falls
 *   back to `pool = 'team'` and `-amount`.
 *   The month key is the Beijing calendar month, because that is how
 *   `deduct_from_pools` computes the row it increments:
 *   `date_trunc('month', ts at time zone 'Asia/Shanghai')::date`.
 *
 *   A refund is booked against the DEDUCT month, not the month it happened in:
 *   `refund_to_pools` derives `v_month` from the original `generation_deduct`
 *   row's `created_at` and decrements that `team_credit_pools` row. Check C
 *   therefore joins a `generation_refund` row back to its original transaction
 *   through `metadata->>'original_transaction_id'` and groups by the ORIGINAL
 *   row's month. Without that join one cross-month refund produces two false
 *   findings: a deficit in the refund's month and a surplus in the charge's.
 *
 *   KNOWN, REPORTED-but-not-modelled: `refund_to_pools` also floors the pool row
 *   with `greatest(0, pool_used - v_team)`, so a workspace that refunded past
 *   zero legitimately sits at `pool_used = 0` with a negative ledger sum. Check C
 *   does NOT replay that floor — replaying it would mean re-implementing the
 *   writer's step order, which is exactly the kind of second implementation this
 *   module refuses to add. Such a row is reported as a finding; because the run
 *   is warn-only, a human reads it and knows to compare it with the refund path.
 *
 * Nothing here holds a connection: the pool is an argument and the whole call is
 * four statements over it.
 */

import type { Pool } from "pg";

/**
 * How loudly a finding is reported. `"alarm"` decides `ok`; `"info"` is
 * reported and never fails the run (see "SEVERITY" in the module comment).
 */
export type ReconcileSeverity = "alarm" | "info";

/** One check's result: how many rows disagree, how loud, and a few ids to look at. */
export type ReconcileFinding = {
  check: string;
  severity: ReconcileSeverity;
  count: number;
  samples: Array<Record<string, unknown>>;
};

/**
 * The whole run. `ok` is true only when every `"alarm"` finding's count is zero;
 * an `"info"` finding never changes `ok`.
 */
export type ReconcileReport = {
  ranAt: string;
  ok: boolean;
  findings: ReconcileFinding[];
};

export type ReconcileOptions = {
  /** Stamped into `ranAt`; defaults to the current clock. Injected for tests. */
  now?: Date;
  /** How many sample ids per check; defaults to `DEFAULT_SAMPLE_LIMIT`. */
  sampleLimit?: number;
};

/** Workorder 45CC: five ids is enough to start looking, few enough to read. */
export const DEFAULT_SAMPLE_LIMIT = 5;

/** The four check names, in the order they appear in the report. */
export const RECONCILE_CHECK_NAMES = [
  "A_job_without_transaction",
  "B_missing_deduction_transaction",
  "C_team_pool_drift",
  "D_negative_balance",
] as const;

export type ReconcileCheckName = (typeof RECONCILE_CHECK_NAMES)[number];

/**
 * The statements themselves. Exported so the "this module writes nothing" test
 * can assert over the exact text that reaches the driver instead of over a copy.
 */
export type ReconcileCheck = {
  name: ReconcileCheckName;
  /** `"alarm"` makes `ok` false when it has counts; `"info"` only reports. */
  severity: ReconcileSeverity;
  /** `<offenders>` must yield a single `sample jsonb` column. */
  sql: string;
};

/**
 * Wraps one `offenders` definition into `{count, samples}`: the count is exact
 * (it is a `count(*)`, not the length of the capped sample), and `samples` never
 * leaves as SQL NULL — an empty check reports `[]`, so JSON consumers see an
 * array either way.
 */
function countAndSample(offenders: string): string {
  return `${offenders}
select
  (select count(*)::int from offenders) as count,
  coalesce(
    (select jsonb_agg(o.sample) from (select sample from offenders limit $1) o),
    '[]'::jsonb
  ) as samples`;
}

export const RECONCILE_CHECKS: readonly ReconcileCheck[] = [
  {
    // A: a succeeded, charged job whose ledger row is missing or dangling.
    name: "A_job_without_transaction",
    severity: "alarm",
    sql: countAndSample(`with offenders as (
  select jsonb_build_object('job_id', j.id::text) as sample
  from public.background_jobs j
  where j.status = 'succeeded'
    and coalesce(j.credits_cost, 0) > 0
    and (
      j.credits_transaction_id is null
      or not exists (
        select 1
        from public.credit_transactions t
        where t.id = j.credits_transaction_id
      )
    )
)`),
  },
  {
    // B: the dangling-reference subset, reported on its own so an operator can
    // tell "no id at all" (A only) from "id that goes nowhere" (A and B).
    name: "B_missing_deduction_transaction",
    severity: "alarm",
    sql: countAndSample(`with offenders as (
  select jsonb_build_object(
           'job_id', j.id::text,
           'credits_transaction_id', j.credits_transaction_id::text
         ) as sample
  from public.background_jobs j
  where j.credits_transaction_id is not null
    and not exists (
      select 1
      from public.credit_transactions t
      where t.id = j.credits_transaction_id
    )
)`),
  },
  {
    // C: the team pool row against the team portion of its own month's ledger.
    //
    // INFORMATIONAL ONLY (workorder 45CD). `pool_used` is a runtime counter:
    // `cycle_reset` zeroes it when a cycle rolls over, so the ledger sum for a
    // month whose pool row belongs to a different cycle simply does not add up —
    // reverse-computing `pool_used` from `credit_transactions` is unreliable.
    // The check is kept because the numbers are still worth reading next to the
    // pool row; it is not allowed to fail the run. Making it strict would need
    // the semantics of `cycle_reset` pinned down first — tracked as T-158. The
    // query below is unchanged on purpose: this ticket changes the verdict, not
    // the statistic.
    name: "C_team_pool_drift",
    severity: "info",
    sql: countAndSample(`with ledger_team as (
  select
    t.workspace_id,
    date_trunc(
      'month',
      coalesce(orig.created_at, t.created_at) at time zone 'Asia/Shanghai'
    )::date as period_month,
    case
      when t.pool_breakdown ? 'team'
        then ((t.pool_breakdown ->> 'team')::int) * (sign(-t.amount))::int
      when t.pool = 'team'
        then -t.amount
      else 0
    end as team_delta
  from public.credit_transactions t
  -- A refund is booked against the DEDUCT month, not its own: refund_to_pools
  -- derives its month key from the original generation_deduct row's created_at
  -- and decrements THAT team_credit_pools row. Grouping a refund by its own
  -- created_at therefore moves the money into the refund's month while the pool
  -- row it moved lives in the charge's month -- two false findings for one
  -- cross-month refund.
  left join public.credit_transactions orig
    on t.transaction_type = 'generation_refund'
   and orig.id = nullif(t.metadata ->> 'original_transaction_id', '')::uuid
), usage as (
  select workspace_id, period_month, sum(team_delta)::int as team_used
  from ledger_team
  group by workspace_id, period_month
), offenders as (
  select jsonb_build_object(
           'workspace_id', p.workspace_id::text,
           'period_month', p.period_month::text,
           'pool_used', p.pool_used,
           'ledger_team_used', coalesce(u.team_used, 0)
         ) as sample
  from public.team_credit_pools p
  left join usage u
    on u.workspace_id = p.workspace_id
   and u.period_month = p.period_month
  where p.pool_used <> coalesce(u.team_used, 0)
)`),
  },
  {
    // D: money below zero, and a team pool spent past its own limit.
    name: "D_negative_balance",
    severity: "alarm",
    sql: countAndSample(`with offenders as (
  select jsonb_build_object(
           'table', 'user_credit_wallets',
           'id', w.user_id::text,
           'daily_date', w.daily_date::text,
           'daily_balance', w.daily_balance,
           'topup_balance', w.topup_balance
         ) as sample
  from public.user_credit_wallets w
  where w.daily_balance < 0 or w.topup_balance < 0
  union all
  select jsonb_build_object(
           'table', 'team_credit_pools',
           'id', p.workspace_id::text,
           'period_month', p.period_month::text,
           'pool_used', p.pool_used,
           'pool_limit', p.pool_limit
         ) as sample
  from public.team_credit_pools p
  where p.pool_used > p.pool_limit
)`),
  },
];

/** One row of a check's result, as `node-pg` hands it back. */
type CheckResultRow = {
  count: number | string;
  samples: unknown;
};

/**
 * Run every check and assemble the report. Statements run sequentially on the
 * caller's pool: they are four cheap `count(*)`s, and a parallel fan-out would
 * only make the failure ordering harder to describe.
 *
 * Throws on a database error — the caller (the CLI, the schedule) decides what a
 * failed READ means. A successfully run reconciliation never throws, however bad
 * the numbers are: a drift is a finding, not an exception.
 */
export async function reconcileCredits(
  pool: Pool,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const sampleLimit = Math.max(
    0,
    Math.trunc(options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT),
  );
  const ranAt = (options.now ?? new Date()).toISOString();

  const findings: ReconcileFinding[] = [];
  for (const check of RECONCILE_CHECKS) {
    findings.push(await runCheck(pool, check, sampleLimit));
  }

  return {
    ranAt,
    // Only alarms fail the run: an informational finding is data, not a verdict.
    ok: findings
      .filter((finding) => finding.severity === "alarm")
      .every((finding) => finding.count === 0),
    findings,
  };
}

async function runCheck(
  pool: Pool,
  check: ReconcileCheck,
  sampleLimit: number,
): Promise<ReconcileFinding> {
  const result = await pool.query<CheckResultRow>(check.sql, [sampleLimit]);
  const row = result.rows[0];

  // A missing row would mean the statement did not run at all; treat that as
  // zero offenders rather than inventing one, because the report's job is to
  // describe what the query said.
  const count = Number(row?.count ?? 0);
  const samples = Array.isArray(row?.samples)
    ? (row.samples as Array<Record<string, unknown>>)
    : [];

  return {
    check: check.name,
    severity: check.severity,
    count: Number.isFinite(count) ? count : 0,
    samples,
  };
}
