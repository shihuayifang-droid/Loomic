-- HaHart migration 0009 (ticket 43U, ADR-0001, OP-04).
--
-- Credit administration on top of 0003 (workspaces, admin_audit_log), 0007
-- (credit_transactions) and 0008 (pools, wallets, caps): cycle grants, the cap
-- setters, top-up adjustment, the team pool limit and the member generation
-- pause switch. Ported from the final form of the retired `supabase/migrations`
-- chain (credit cycle grants, admin credit adjust, member cap settings, team pool
-- limit, member pause and credit audit).
-- Differences by design:
--   * `user_id` / `paused_by` columns point at `hahart_auth.users(id)`;
--   * no row level policies and no role privilege statements: the server is the
--     only client;
--   * only the final version of each function is kept: `set_personal_cap` is the
--     version that also writes the cross-month `member_cap_settings` row, and
--     `admin_adjust_topup` / `set_team_pool_limit` are the versions that append a
--     row to `admin_audit_log` in the same transaction;
--   * the `admin_audit_log.action` whitelist already lists the credit and pause
--     actions in 0003, so no constraint is replaced here;
--   * pausing is a state plus a lookup (`is_member_generation_paused`): the
--     server reads it before it charges; the pool functions do not check it;
--   * the compensation tables and `create_charged_job` belong to 0010.
--
-- Month key: first day of a Beijing-time calendar month. Day key: Beijing date.
--
-- Create-only migration, runs on an empty database after 0001 .. 0008.

-- ---------------------------------------------------------------------------
-- 1. Cycle grants
--    grant_team_cycle: the month row exists -> nothing happens, the existing
--    limit is returned. Otherwise the row is created and the previous month's
--    remainder is cleared by a cycle_reset row (the previous row is kept).
--    grant_daily_credits: the wallet's daily date is already today -> false.
-- ---------------------------------------------------------------------------
create or replace function public.grant_team_cycle(
  p_workspace_id uuid,
  p_month date default null,
  p_limit integer default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := coalesce(p_month, date_trunc('month', now() at time zone 'Asia/Shanghai')::date);
  v_prev_month date;
  v_existing integer;
  v_prev_limit integer;
  v_prev_used integer;
  v_remaining integer;
  v_limit integer;
  v_inserted integer;
begin
  if extract(day from v_month) <> 1 then
    raise exception 'grant_team_cycle: p_month must be the first day of a month, got %', v_month
      using errcode = '22023';
  end if;
  if p_limit is not null and p_limit < 0 then
    raise exception 'grant_team_cycle: p_limit must not be negative, got %', p_limit
      using errcode = '22023';
  end if;

  -- The month row already exists: idempotent return.
  select pool_limit into v_existing
  from public.team_credit_pools
  where workspace_id = p_workspace_id and period_month = v_month
  for update;
  if found then
    return v_existing;
  end if;

  v_limit := coalesce(
    p_limit,
    (select count(*)::int from public.workspace_members where workspace_id = p_workspace_id) * 20000
  );

  -- Claim the month row first; on a race only one caller inserts, the rest return.
  insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used)
  values (p_workspace_id, v_month, v_limit, 0)
  on conflict (workspace_id, period_month) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select pool_limit into v_existing
    from public.team_credit_pools
    where workspace_id = p_workspace_id and period_month = v_month;
    return v_existing;
  end if;

  -- Clear last month's remainder (ledger row only, the old row is not changed).
  v_prev_month := (v_month - interval '1 month')::date;
  select pool_limit, pool_used into v_prev_limit, v_prev_used
  from public.team_credit_pools
  where workspace_id = p_workspace_id and period_month = v_prev_month;
  if found then
    v_remaining := v_prev_limit - v_prev_used;
    if v_remaining > 0 then
      insert into public.credit_transactions
        (workspace_id, user_id, transaction_type, amount, balance_after, description, metadata, pool)
      values
        (p_workspace_id, null, 'cycle_reset', -v_remaining, 0, 'Monthly team pool reset',
         jsonb_build_object('period_month', v_prev_month), 'team');
    end if;
  end if;

  insert into public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, description, metadata, pool)
  values
    (p_workspace_id, null, 'cycle_grant', v_limit, v_limit, 'Monthly team pool grant',
     jsonb_build_object('period_month', v_month), 'team');

  return v_limit;
end;
$$;

create or replace function public.grant_daily_credits(
  p_user_id uuid,
  p_workspace_id uuid,
  p_amount integer default 100
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Shanghai')::date;
  v_wallet_date date;
  v_wallet_daily integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'grant_daily_credits: p_amount must be positive, got %', p_amount
      using errcode = '22023';
  end if;

  insert into public.user_credit_wallets (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select daily_date, daily_balance into v_wallet_date, v_wallet_daily
  from public.user_credit_wallets
  where user_id = p_user_id
  for update;

  if v_wallet_date is not distinct from v_today then
    return false;
  end if;

  -- Whatever is left from an earlier day expires.
  if v_wallet_date is not null and v_wallet_date < v_today and v_wallet_daily > 0 then
    insert into public.credit_transactions
      (workspace_id, user_id, transaction_type, amount, balance_after, description, metadata, pool)
    values
      (p_workspace_id, p_user_id, 'daily_expire', -v_wallet_daily, 0, 'Daily credits expired',
       jsonb_build_object('daily_date', v_wallet_date), 'daily');
  end if;

  update public.user_credit_wallets
  set daily_date = v_today,
      daily_balance = p_amount,
      updated_at = now()
  where user_id = p_user_id;

  insert into public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, description, pool)
  values
    (p_workspace_id, p_user_id, 'daily_grant', p_amount, p_amount, 'Daily credits', 'daily');

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Cap setters
--    set_personal_cap writes the cross-month setting first (source 'manual'),
--    then this month's usage row, so the inherit trigger sees the new value.
--    apply_cap_template skips members whose setting is 'manual' and returns the
--    number of members actually changed.
-- ---------------------------------------------------------------------------
create or replace function public.set_personal_cap(
  p_workspace_id uuid,
  p_user_id uuid,
  p_cap integer,
  p_month date default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := coalesce(p_month, date_trunc('month', now() at time zone 'Asia/Shanghai')::date);
begin
  if extract(day from v_month) <> 1 then
    raise exception 'INVALID_CAP_MONTH: month must be the first day' using errcode = '22023';
  end if;
  if p_cap is null or p_cap < 0 then
    raise exception 'INVALID_CAP: cap must be zero or more' using errcode = '22023';
  end if;

  insert into public.member_cap_settings (workspace_id, user_id, cap, source, template_id)
  values (p_workspace_id, p_user_id, p_cap, 'manual', null)
  on conflict (workspace_id, user_id)
  do update set cap = excluded.cap, source = 'manual', template_id = null, updated_at = now();

  insert into public.member_team_usage (workspace_id, user_id, period_month, personal_cap)
  values (p_workspace_id, p_user_id, v_month, p_cap)
  on conflict (workspace_id, user_id, period_month)
  do update set personal_cap = excluded.personal_cap, updated_at = now();

  return p_cap;
end;
$$;

create or replace function public.apply_cap_template(
  p_workspace_id uuid,
  p_template_id uuid,
  p_user_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'Asia/Shanghai')::date;
  v_cap integer;
  v_user uuid;
  v_applied integer := 0;
begin
  select t.cap into v_cap
  from public.credit_cap_templates t
  where t.id = p_template_id and t.workspace_id = p_workspace_id;
  if not found then
    raise exception 'TEMPLATE_NOT_FOUND: template does not belong to this workspace' using errcode = '22023';
  end if;

  foreach v_user in array coalesce(p_user_ids, '{}'::uuid[]) loop
    if exists (
      select 1 from public.member_cap_settings s
      where s.workspace_id = p_workspace_id and s.user_id = v_user and s.source = 'manual'
    ) then
      continue;
    end if;

    insert into public.member_cap_settings (workspace_id, user_id, cap, source, template_id)
    values (p_workspace_id, v_user, v_cap, 'template', p_template_id)
    on conflict (workspace_id, user_id)
    do update set cap = excluded.cap, source = 'template',
                  template_id = excluded.template_id, updated_at = now();

    insert into public.member_team_usage (workspace_id, user_id, period_month, personal_cap)
    values (p_workspace_id, v_user, v_month, v_cap)
    on conflict (workspace_id, user_id, period_month)
    do update set personal_cap = excluded.personal_cap, updated_at = now();

    v_applied := v_applied + 1;
  end loop;

  return v_applied;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Member generation pause: state table, switch and lookup
--    The switch only writes an audit row when the state really changes.
-- ---------------------------------------------------------------------------
create table public.member_generation_pauses (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references hahart_auth.users (id) on delete cascade,
  paused_by uuid not null references hahart_auth.users (id),
  reason text not null check (char_length(btrim(reason)) > 0),
  paused_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create or replace function public.set_member_generation_paused(
  p_workspace_id uuid,
  p_user_id uuid,
  p_operator_id uuid,
  p_paused boolean,
  p_reason text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_was_paused boolean;
  v_changed boolean := false;
begin
  if p_operator_id is null then
    raise exception 'INVALID_PAUSE: operator is required' using errcode = '22023';
  end if;
  if p_paused is null then
    raise exception 'INVALID_PAUSE: paused flag is required' using errcode = '22023';
  end if;
  if p_paused and v_reason = '' then
    raise exception 'INVALID_PAUSE: reason is required' using errcode = '22023';
  end if;

  select exists (
    select 1 from public.member_generation_pauses
    where workspace_id = p_workspace_id and user_id = p_user_id
  ) into v_was_paused;

  if p_paused then
    insert into public.member_generation_pauses (workspace_id, user_id, paused_by, reason)
    values (p_workspace_id, p_user_id, p_operator_id, v_reason)
    on conflict (workspace_id, user_id)
    do update set paused_by = excluded.paused_by, reason = excluded.reason, paused_at = now();
    v_changed := not v_was_paused;
  else
    delete from public.member_generation_pauses
    where workspace_id = p_workspace_id and user_id = p_user_id;
    v_changed := v_was_paused;
  end if;

  if v_changed then
    insert into public.admin_audit_log (actor_user_id, action, target_user_id, detail)
    values (
      p_operator_id,
      case when p_paused then 'member.generation_pause' else 'member.generation_resume' end,
      p_user_id,
      jsonb_build_object(
        'workspace_id', p_workspace_id,
        'reason', v_reason,
        'before', v_was_paused,
        'after', p_paused
      )
    );
  end if;

  return v_changed;
end;
$$;

create or replace function public.is_member_generation_paused(
  p_workspace_id uuid,
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.member_generation_pauses
    where workspace_id = p_workspace_id and user_id = p_user_id
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. Top-up adjustment and team pool limit (each appends one audit row)
-- ---------------------------------------------------------------------------
create or replace function public.admin_adjust_topup(
  p_workspace_id uuid,
  p_user_id uuid,
  p_operator_id uuid,
  p_delta integer,
  p_reason text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_before integer;
  v_after integer;
  v_tx_id uuid;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'INVALID_ADJUSTMENT: delta must be non-zero' using errcode = '22023';
  end if;
  if v_reason = '' then
    raise exception 'INVALID_ADJUSTMENT: reason is required' using errcode = '22023';
  end if;
  if p_operator_id is null then
    raise exception 'INVALID_ADJUSTMENT: operator is required' using errcode = '22023';
  end if;

  insert into public.user_credit_wallets (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select topup_balance into v_before
  from public.user_credit_wallets
  where user_id = p_user_id
  for update;

  if p_delta < 0 and v_before + p_delta < 0 then
    raise exception 'ADJUST_EXCEEDS_TOPUP: at most % can be deducted', v_before
      using errcode = 'P0405', detail = v_before::text;
  end if;

  v_after := v_before + p_delta;

  update public.user_credit_wallets
  set topup_balance = v_after,
      updated_at = now()
  where user_id = p_user_id;

  insert into public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, description, pool, metadata)
  values
    (p_workspace_id, p_user_id, 'admin_adjustment', p_delta, v_after, 'Admin adjustment', 'topup',
     jsonb_build_object(
       'operator_id', p_operator_id,
       'reason', v_reason,
       'balance_before', v_before,
       'balance_after', v_after
     ))
  returning id into v_tx_id;

  insert into public.admin_audit_log (actor_user_id, action, target_user_id, detail)
  values (
    p_operator_id,
    'credits.adjust_topup',
    p_user_id,
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'delta', p_delta,
      'reason', v_reason,
      'transaction_id', v_tx_id
    )
  );

  return v_tx_id;
end;
$$;

create or replace function public.set_team_pool_limit(
  p_workspace_id uuid,
  p_limit integer,
  p_operator_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'Asia/Shanghai')::date;
  v_before integer;
  v_used integer;
begin
  if p_limit is null or p_limit < 0 then
    raise exception 'INVALID_POOL_LIMIT: limit must be zero or more' using errcode = '22023';
  end if;
  if p_operator_id is null then
    raise exception 'INVALID_POOL_LIMIT: operator is required' using errcode = '22023';
  end if;

  -- No row for this month yet: create it at the default limit first.
  perform 1
  from public.team_credit_pools
  where workspace_id = p_workspace_id and period_month = v_month;
  if not found then
    perform public.grant_team_cycle(p_workspace_id);
  end if;

  select pool_limit, pool_used into v_before, v_used
  from public.team_credit_pools
  where workspace_id = p_workspace_id and period_month = v_month
  for update;

  update public.team_credit_pools
  set pool_limit = p_limit,
      updated_at = now()
  where workspace_id = p_workspace_id and period_month = v_month;

  if p_limit <> v_before then
    insert into public.credit_transactions
      (workspace_id, user_id, transaction_type, amount, balance_after, description, metadata, pool)
    values
      (p_workspace_id, null, 'admin_adjustment', p_limit - v_before, p_limit - v_used,
       'Team pool limit changed',
       jsonb_build_object(
         'operator_id', p_operator_id,
         'period_month', v_month,
         'limit_before', v_before,
         'limit_after', p_limit
       ),
       'team');

    insert into public.admin_audit_log (actor_user_id, action, target_user_id, detail)
    values (
      p_operator_id,
      'credits.set_pool_limit',
      null,
      jsonb_build_object(
        'workspace_id', p_workspace_id,
        'limit_before', v_before,
        'limit_after', p_limit
      )
    );
  end if;

  return p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Audited wrappers around the cap setters (the plain setters keep their
--    signatures; these add the operator and one audit row)
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_personal_cap(
  p_workspace_id uuid,
  p_user_id uuid,
  p_operator_id uuid,
  p_cap integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before integer;
  v_after integer;
begin
  if p_operator_id is null then
    raise exception 'INVALID_CAP: operator is required' using errcode = '22023';
  end if;

  v_before := public.member_personal_cap(p_workspace_id, p_user_id);
  v_after := public.set_personal_cap(p_workspace_id, p_user_id, p_cap);

  insert into public.admin_audit_log (actor_user_id, action, target_user_id, detail)
  values (
    p_operator_id,
    'credits.set_cap',
    p_user_id,
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'cap_before', v_before,
      'cap_after', v_after
    )
  );

  return v_after;
end;
$$;

create or replace function public.admin_apply_cap_template(
  p_workspace_id uuid,
  p_template_id uuid,
  p_user_ids uuid[],
  p_operator_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_applied integer;
begin
  if p_operator_id is null then
    raise exception 'INVALID_CAP: operator is required' using errcode = '22023';
  end if;

  v_applied := public.apply_cap_template(p_workspace_id, p_template_id, p_user_ids);

  insert into public.admin_audit_log (actor_user_id, action, detail)
  values (
    p_operator_id,
    'credits.apply_template',
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'template_id', p_template_id,
      'user_ids', to_jsonb(coalesce(p_user_ids, '{}'::uuid[])),
      'applied', v_applied
    )
  );

  return v_applied;
end;
$$;
