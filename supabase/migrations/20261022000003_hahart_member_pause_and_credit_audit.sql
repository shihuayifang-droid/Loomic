-- 工单39N · AD-01 / BL-21 第 1 步（数据库）：成员「暂停 / 恢复生成」与额度操作审计。
--
-- 出处：
--   AD-01  操作：暂停 / 恢复生成（BL-21）；验收：每个操作在审计日志有一条。
--   BL-21  被暂停成员，服务端拒绝提交（account_suspended）——服务端是下一张单，本单只做数据库。
--   AD 通用规则：每次写操作留审计日志（操作人、时间、对象、前后值）。
--
-- 设计：
--   1. admin_audit_log 的 action 白名单扩展：保留原 4 个值，追加 6 个新动作。
--   2. member_generation_pauses：谁在哪个工作区被暂停；只给 service role。
--   3. set_member_generation_paused / is_member_generation_paused。
--   4. 额度写操作补审计（与变更同一事务，失败一起回滚）：
--      - admin_adjust_topup、set_team_pool_limit：原函数体逐字保留，只在末尾追加审计。
--      - set_personal_cap / apply_cap_template 签名不变（服务端在用），
--        新建带操作人的包装 admin_set_personal_cap / admin_apply_cap_template。
--
-- 权限：本迁移所有函数只给 service role，anon / authenticated 一律拒绝（42501）。

-- ---------------------------------------------------------------------------
-- 1. 审计动作白名单：先换约束，才能写新动作。
-- ---------------------------------------------------------------------------
alter table public.admin_audit_log drop constraint if exists admin_audit_log_action_check;
alter table public.admin_audit_log
  add constraint admin_audit_log_action_check check (action in (
    'team.member.add',
    'team.member.role',
    'team.member.remove',
    'content.foreign_read',
    'credits.adjust_topup',
    'credits.set_cap',
    'credits.apply_template',
    'credits.set_pool_limit',
    'member.generation_pause',
    'member.generation_resume'
  ));

-- ---------------------------------------------------------------------------
-- 2. 暂停表：RLS 开、不建策略；只给 service role。
-- ---------------------------------------------------------------------------
create table if not exists public.member_generation_pauses (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  paused_by uuid not null references auth.users (id),
  reason text not null check (char_length(btrim(reason)) > 0),
  paused_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

alter table public.member_generation_pauses enable row level security;

revoke all on table public.member_generation_pauses from anon, authenticated;
grant all on table public.member_generation_pauses to service_role;

-- ---------------------------------------------------------------------------
-- 3. 暂停 / 恢复：状态真的变化才写审计，返回是否变化。
-- ---------------------------------------------------------------------------
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
-- 4a. admin_adjust_topup：与 20261021000009 逐字相同，只在写完流水后追加一条审计。
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

-- ---------------------------------------------------------------------------
-- 4b. set_team_pool_limit：与 20261021000011 逐字相同，额度变化时追加一条审计。
-- ---------------------------------------------------------------------------
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

  -- 本月池行不存在 -> 先按默认额度建行（同时写 cycle_grant 流水）。
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
-- 4c. 个人上限 / 套模板：原函数签名不动，新建带操作人的审计包装。
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

revoke all on function public.set_member_generation_paused(uuid, uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.is_member_generation_paused(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_adjust_topup(uuid, uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.set_team_pool_limit(uuid, integer, uuid) from public, anon, authenticated;
revoke all on function public.admin_set_personal_cap(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.admin_apply_cap_template(uuid, uuid, uuid[], uuid) from public, anon, authenticated;
