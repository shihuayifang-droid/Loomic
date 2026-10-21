-- 工单37W · BL-01 第 2 步：个人额度模板，与「单独改过的人不被模板覆盖」。
--
-- 问题：
--   个人上限现在只存在每月一行的 member_team_usage.personal_cap 里（默认 20000）。
--   deduct_from_pools 在本月用量行不存在时把上限当 20000，set_personal_cap（37U）也只写本月行。
--   所以「改过一次上限 / 套过模板」到下个月就丢了，也分不清上限是模板给的还是单独改的。
--
-- 为什么用跨月设定表 member_cap_settings：
--   成员上限是一个长期设定，不是月度用量。把它放在 (workspace, user) 一行里，
--   并记 source：'template' = 模板给的（可被再次套模板覆盖），'manual' = 单独改的（模板不覆盖）。
--   每月的 member_team_usage 行只是该设定在本月的快照，新月份行由触发器继承。
--
-- 为什么 deduct_from_pools 只改一行：
--   函数体与 37N 逐字相同，只把「本月用量行不存在时上限当 20000」改为读
--   member_personal_cap(...)（无设定时仍是 20000）。扣费算法一个字不动。
--
-- 触发器的作用范围：
--   member_team_usage 的 before insert 触发器，只在插入的 personal_cap 恰好等于列默认值 20000，
--   且该成员存在设定时，把它换成设定值。显式给了别的值的插入不受影响；
--   不碰 update，也不碰已有月份行。
--
-- 额度调整改配置不改架构：模板与设定都是数据行，调数不用改代码。
-- RLS：两张新表都开启，只有 select 策略，写入只经本迁移里的 service role 函数。
-- 权限：新函数与重定义的函数一律 revoke，anon / authenticated 调用得 42501。

-- 1. 额度模板
create table if not exists public.credit_cap_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  cap integer not null check (cap >= 0),
  created_at timestamptz default now(),
  unique (workspace_id, name)
);

-- 2. 成员上限设定（跨月持久）
create table if not exists public.member_cap_settings (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  cap integer not null check (cap >= 0),
  source text not null check (source in ('template', 'manual')),
  template_id uuid references public.credit_cap_templates(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

alter table public.credit_cap_templates enable row level security;
alter table public.member_cap_settings enable row level security;

drop policy if exists credit_cap_templates_select_admin on public.credit_cap_templates;
create policy credit_cap_templates_select_admin on public.credit_cap_templates
  for select
  using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = credit_cap_templates.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

drop policy if exists member_cap_settings_select_self_or_admin on public.member_cap_settings;
create policy member_cap_settings_select_self_or_admin on public.member_cap_settings
  for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.workspace_members m
      where m.workspace_id = member_cap_settings.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- 3. 有效上限：有设定用设定，没有就是默认 20000。
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

-- 4. 新月份行继承设定。
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

drop trigger if exists member_team_usage_inherit_cap on public.member_team_usage;
create trigger member_team_usage_inherit_cap
  before insert on public.member_team_usage
  for each row execute function public.member_team_usage_inherit_cap();

-- 5. deduct_from_pools：与 37N 逐字相同，只改「本月行不存在时的上限」一行。

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

  -- 锁定并读取：团队池 -> 成员用量 -> 钱包（固定顺序）。
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

  -- 扣到团队池时才建成员用量行（默认上限 20000），然后重新加锁读取。
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

revoke all on function public.deduct_from_pools(uuid, uuid, integer, uuid, text) from public, anon, authenticated;

-- 6. set_personal_cap：除了写本月行，再写跨月设定（source = 'manual'）。
--    先写设定、再写本月行，这样触发器看到的设定已经是新值，不会把显式值换掉。
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

-- 7. 套模板：单独改过（manual）的人跳过；返回实际套用的人数。
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

revoke all on function public.member_personal_cap(uuid, uuid) from public, anon, authenticated;
revoke all on function public.member_team_usage_inherit_cap() from public, anon, authenticated;
revoke all on function public.set_personal_cap(uuid, uuid, integer, date) from public, anon, authenticated;
revoke all on function public.apply_cap_template(uuid, uuid, uuid[]) from public, anon, authenticated;
