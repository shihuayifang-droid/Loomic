-- HaHart migration 0008 (ticket 43T, ADR-0001, OP-04).
--
-- Team credit pools and member quotas on top of 0003 (workspaces, hahart_auth
-- users) and 0007 (credit_transactions). Ported from the final form of the
-- retired `supabase/migrations` chain (credit pools + deduct_from_pools +
-- refund_to_pools + member cap settings).
-- Differences by design:
--   * `user_id` columns point at `hahart_auth.users(id)` (same `on delete cascade`);
--   * no row level policies and no role grants or revokes: the server is the
--     only client;
--   * only the final version of each function is kept: `deduct_from_pools` is the
--     version that reads the cross-month cap through `member_personal_cap`;
--   * `credit_transactions.pool` / `pool_breakdown` already exist (0007) as plain
--     columns, and no foreign key from `credit_transactions` points at the pool
--     tables in the source, so none is added here;
--   * the admin side lives in 0009: cap setters and template application,
--     cycle grants, team pool limit, pause switches and compensation tables.
--
-- Month key: always the first day of a Beijing-time calendar month.
-- Personal cap: default 20000; it only limits the part drawn from the team pool.
--
-- Create-only migration, runs on an empty database after 0001 .. 0007.

-- ---------------------------------------------------------------------------
-- 1. Team period pool: one row per workspace and calendar month
-- ---------------------------------------------------------------------------
create table public.team_credit_pools (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  period_month date not null check (extract(day from period_month) = 1),
  pool_limit integer not null check (pool_limit >= 0),
  pool_used integer not null default 0 check (pool_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, period_month)
);

-- ---------------------------------------------------------------------------
-- 2. Member usage of the team pool in one month
-- ---------------------------------------------------------------------------
create table public.member_team_usage (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references hahart_auth.users (id) on delete cascade,
  period_month date not null check (extract(day from period_month) = 1),
  used integer not null default 0 check (used >= 0),
  personal_cap integer not null default 20000 check (personal_cap >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id, period_month)
);

-- ---------------------------------------------------------------------------
-- 3. Personal wallet: the daily pool and the top-up pool are stored apart
-- ---------------------------------------------------------------------------
create table public.user_credit_wallets (
  user_id uuid primary key references hahart_auth.users (id) on delete cascade,
  daily_date date,
  daily_balance integer not null default 0 check (daily_balance >= 0),
  topup_balance integer not null default 0 check (topup_balance >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. Cap templates and the cross-month member cap setting
-- ---------------------------------------------------------------------------
create table public.credit_cap_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  cap integer not null check (cap >= 0),
  created_at timestamptz default now(),
  unique (workspace_id, name)
);

create table public.member_cap_settings (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references hahart_auth.users (id) on delete cascade,
  cap integer not null check (cap >= 0),
  source text not null check (source in ('template', 'manual')),
  template_id uuid references public.credit_cap_templates (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 5. Effective personal cap and the month-row inheritance trigger
-- ---------------------------------------------------------------------------
-- A stored setting wins; without one the cap is the default 20000.
create or replace function public.member_personal_cap(
  p_workspace_id uuid,
  p_user_id uuid
) returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select s.cap from public.member_cap_settings s
     where s.workspace_id = p_workspace_id and s.user_id = p_user_id),
    20000
  );
$$;

-- A new month row inherits the member's stored setting. Only an insert whose
-- personal_cap equals the column default (20000) is replaced; an explicit other
-- value is kept, and updates and existing rows are not touched.
create or replace function public.member_team_usage_inherit_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap integer;
begin
  if new.personal_cap = 20000 then
    select s.cap into v_cap
    from public.member_cap_settings s
    where s.workspace_id = new.workspace_id and s.user_id = new.user_id;
    if found then
      new.personal_cap := v_cap;
    end if;
  end if;
  return new;
end;
$$;

create trigger member_team_usage_inherit_cap
  before insert on public.member_team_usage
  for each row execute function public.member_team_usage_inherit_cap();

-- ---------------------------------------------------------------------------
-- 6. deduct_from_pools (final version)
--    Order: daily pool, then team pool (bounded by the personal cap), then top-up.
--    Not enough in total: the whole charge is refused and no row changes.
--    SQLSTATE: P0402 insufficient credits, P0403 personal cap reached,
--    P0404 team pool exhausted. Month and day keys use Asia/Shanghai.
--    No pool row means a team remainder of 0; a usage row is only created when
--    the team pool is actually drawn.
-- ---------------------------------------------------------------------------
create or replace function public.deduct_from_pools(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_job_id uuid default null,
  p_description text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'Asia/Shanghai')::date;
  v_today date := (now() at time zone 'Asia/Shanghai')::date;
  v_pool_limit integer := 0;
  v_pool_used integer := 0;
  v_used integer := 0;
  v_cap integer := 20000;
  v_daily integer := 0;
  v_topup integer := 0;
  v_wallet_daily_date date;
  v_wallet_daily integer;
  v_team_allowance integer;
  v_team_allowance_after integer;
  v_remaining integer;
  v_from_daily integer := 0;
  v_from_team integer := 0;
  v_from_topup integer := 0;
  v_cap_left integer;
  v_team_left integer;
  v_pool text;
  v_pool_count integer;
  v_balance_after integer;
  v_tx_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    return null;
  end if;

  -- Lock and read in a fixed order: team pool, member usage, wallet.
  select pool_limit, pool_used into v_pool_limit, v_pool_used
  from public.team_credit_pools
  where workspace_id = p_workspace_id and period_month = v_month
  for update;
  if not found then
    v_pool_limit := 0;
    v_pool_used := 0;
  end if;

  select used, personal_cap into v_used, v_cap
  from public.member_team_usage
  where workspace_id = p_workspace_id and user_id = p_user_id and period_month = v_month
  for update;
  if not found then
    v_used := 0;
    v_cap := public.member_personal_cap(p_workspace_id, p_user_id);
  end if;

  select daily_date, daily_balance, topup_balance
    into v_wallet_daily_date, v_wallet_daily, v_topup
  from public.user_credit_wallets
  where user_id = p_user_id
  for update;
  if not found then
    v_wallet_daily := 0;
    v_topup := 0;
    v_daily := 0;
  elsif v_wallet_daily_date is not distinct from v_today then
    v_daily := v_wallet_daily;
  else
    v_daily := 0;
  end if;

  v_team_allowance := greatest(0, least(v_pool_limit - v_pool_used, v_cap - v_used));

  v_remaining := p_amount;
  v_from_daily := least(v_remaining, v_daily);
  v_remaining := v_remaining - v_from_daily;
  v_from_team := least(v_remaining, v_team_allowance);
  v_remaining := v_remaining - v_from_team;
  v_from_topup := least(v_remaining, v_topup);
  v_remaining := v_remaining - v_from_topup;

  if v_remaining > 0 then
    v_cap_left := v_cap - v_used;
    v_team_left := v_pool_limit - v_pool_used;

    if v_team_left <= 0 and v_cap_left <= 0 then
      raise exception 'INSUFFICIENT_CREDITS: need %, short by %', p_amount, v_remaining
        using errcode = 'P0402';
    elsif v_cap_left <= v_team_left then
      raise exception 'PERSONAL_CAP_REACHED: need %, personal cap left %', p_amount, greatest(0, v_cap_left)
        using errcode = 'P0403';
    else
      raise exception 'TEAM_POOL_EXHAUSTED: need %, team pool left %', p_amount, greatest(0, v_team_left)
        using errcode = 'P0404';
    end if;
  end if;

  -- Create the member usage row only when the team pool is drawn, then lock it.
  if v_from_team > 0 then
    insert into public.member_team_usage (workspace_id, user_id, period_month)
    values (p_workspace_id, p_user_id, v_month)
    on conflict do nothing;

    select used, personal_cap into v_used, v_cap
    from public.member_team_usage
    where workspace_id = p_workspace_id and user_id = p_user_id and period_month = v_month
    for update;

    update public.team_credit_pools
    set pool_used = pool_used + v_from_team,
        updated_at = now()
    where workspace_id = p_workspace_id and period_month = v_month;

    update public.member_team_usage
    set used = used + v_from_team,
        updated_at = now()
    where workspace_id = p_workspace_id and user_id = p_user_id and period_month = v_month;

    v_pool_used := v_pool_used + v_from_team;
    v_used := v_used + v_from_team;
  end if;

  if v_from_daily > 0 or v_from_topup > 0 then
    update public.user_credit_wallets
    set daily_balance = daily_balance - v_from_daily,
        topup_balance = topup_balance - v_from_topup,
        updated_at = now()
    where user_id = p_user_id;
  end if;

  v_team_allowance_after := greatest(0, least(v_pool_limit - v_pool_used, v_cap - v_used));
  v_balance_after := (v_daily - v_from_daily) + v_team_allowance_after + (v_topup - v_from_topup);

  v_pool_count := (v_from_daily > 0)::int + (v_from_team > 0)::int + (v_from_topup > 0)::int;
  if v_pool_count = 1 then
    v_pool := case
      when v_from_daily > 0 then 'daily'
      when v_from_team > 0 then 'team'
      else 'topup'
    end;
  else
    v_pool := null;
  end if;

  insert into public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description, pool, pool_breakdown)
  values
    (p_workspace_id, p_user_id, 'generation_deduct', -p_amount, v_balance_after, p_job_id, p_description,
     v_pool,
     jsonb_build_object('daily', v_from_daily, 'team', v_from_team, 'topup', v_from_topup))
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. refund_to_pools (final version)
--    Refunds a job along its original path, using the pool_breakdown of the
--    deduct row: team part back to the pool row and the member usage, top-up
--    part back to the wallet, daily part back to the wallet only while the
--    wallet's daily date is still the deduct day (otherwise a same-amount
--    daily_expire row follows the refund). One refund per job: a repeat returns
--    the first refund row. A null job id raises 22023. Missing pool or usage
--    rows are skipped; a missing wallet is created for the top-up part.
--    balance_after is written as 0: the pool view is computed by the read layer.
-- ---------------------------------------------------------------------------
create or replace function public.refund_to_pools(
  p_job_id uuid,
  p_description text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_orig_id uuid;
  v_workspace_id uuid;
  v_user_id uuid;
  v_breakdown jsonb;
  v_created_at timestamptz;
  v_daily integer;
  v_team integer;
  v_topup integer;
  v_month date;
  v_day date;
  v_wallet_daily_date date;
  v_pool text;
  v_pool_count integer;
  v_tx_id uuid;
begin
  if p_job_id is null then
    raise exception 'refund_to_pools: job_id is required'
      using errcode = '22023';
  end if;

  -- Idempotent: a job that was already refunded returns that row, nothing changes.
  select id into v_existing
  from public.credit_transactions
  where job_id = p_job_id and transaction_type = 'generation_refund'
  limit 1;
  if found then
    return v_existing;
  end if;

  -- The original deduct row, as written by deduct_from_pools.
  select id, workspace_id, user_id, pool_breakdown, created_at
    into v_orig_id, v_workspace_id, v_user_id, v_breakdown, v_created_at
  from public.credit_transactions
  where job_id = p_job_id
    and transaction_type = 'generation_deduct'
    and amount < 0
    and pool_breakdown is not null
  order by created_at, id
  limit 1;
  if not found then
    return null;
  end if;

  v_daily := coalesce((v_breakdown ->> 'daily')::integer, 0);
  v_team := coalesce((v_breakdown ->> 'team')::integer, 0);
  v_topup := coalesce((v_breakdown ->> 'topup')::integer, 0);
  v_month := date_trunc('month', v_created_at at time zone 'Asia/Shanghai')::date;
  v_day := (v_created_at at time zone 'Asia/Shanghai')::date;

  -- Team part: lock the pool row and the member usage row (fixed order), skip if absent.
  if v_team > 0 then
    perform 1
    from public.team_credit_pools
    where workspace_id = v_workspace_id and period_month = v_month
    for update;
    if found then
      update public.team_credit_pools
      set pool_used = greatest(0, pool_used - v_team),
          updated_at = now()
      where workspace_id = v_workspace_id and period_month = v_month;
    end if;

    perform 1
    from public.member_team_usage
    where workspace_id = v_workspace_id and user_id = v_user_id and period_month = v_month
    for update;
    if found then
      update public.member_team_usage
      set used = greatest(0, used - v_team),
          updated_at = now()
      where workspace_id = v_workspace_id and user_id = v_user_id and period_month = v_month;
    end if;
  end if;

  -- Wallet: create the row if missing, then lock and read it.
  if v_topup > 0 or v_daily > 0 then
    insert into public.user_credit_wallets (user_id)
    values (v_user_id)
    on conflict (user_id) do nothing;

    select daily_date into v_wallet_daily_date
    from public.user_credit_wallets
    where user_id = v_user_id
    for update;

    if v_topup > 0 then
      update public.user_credit_wallets
      set topup_balance = topup_balance + v_topup,
          updated_at = now()
      where user_id = v_user_id;
    end if;

    if v_daily > 0 and v_wallet_daily_date is not distinct from v_day then
      update public.user_credit_wallets
      set daily_balance = daily_balance + v_daily,
          updated_at = now()
      where user_id = v_user_id;
    end if;
  end if;

  v_pool_count := (v_daily > 0)::int + (v_team > 0)::int + (v_topup > 0)::int;
  if v_pool_count = 1 then
    v_pool := case
      when v_daily > 0 then 'daily'
      when v_team > 0 then 'team'
      else 'topup'
    end;
  else
    v_pool := null;
  end if;

  -- A unique index conflict (two concurrent refunds) rolls the whole statement back.
  insert into public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description,
     pool, pool_breakdown, metadata)
  values
    (v_workspace_id, v_user_id, 'generation_refund', v_daily + v_team + v_topup, 0, p_job_id,
     coalesce(p_description, 'Refund'), v_pool, v_breakdown,
     jsonb_build_object('original_transaction_id', v_orig_id))
  returning id into v_tx_id;

  -- The original daily pool has already expired: refund, then expire it at once.
  if v_daily > 0 and v_wallet_daily_date is distinct from v_day then
    insert into public.credit_transactions
      (workspace_id, user_id, transaction_type, amount, balance_after, description,
       metadata, pool)
    values
      (v_workspace_id, v_user_id, 'daily_expire', -v_daily, 0, 'Refunded daily credits expired',
       jsonb_build_object('daily_date', v_day, 'job_id', p_job_id), 'daily');
  end if;

  return v_tx_id;
end;
$$;
