-- 工单38N · BL-44：管理员改团队池本月额度，当月立即生效（新建，只增不改）。
--
-- 出处：
--   BL-44  池额度 = 管理员设定的月度总额，默认 = 成员数 x 20000，可改；改后当月立即生效。
--   验收 3 管理员把池额度改为 50000 后当月立即生效，成员可用额度同步变化。
--
-- 设计：
--   set_team_pool_limit(workspace, limit, operator) -> 新额度
--   - 只改本月池行的 pool_limit，pool_used 不动：成员可用额度 = pool_limit - pool_used，
--     所以读取侧（readPoolBalances）立刻看到新数字，不需要别的同步。
--   - 本月还没有池行 -> 先调 grant_team_cycle 按默认额度建行并写 cycle_grant 流水，
--     再改额度，流水保持完整。
--   - 额度有变化才写一条 admin_adjustment 流水（amount = 新额度 - 旧额度，pool = team）；
--     没有变化不写。
--   - limit 为空或小于 0、operator 为空 -> 22023。
--
-- 权限：只给 service role 调用，anon / authenticated 一律拒绝（42501）。

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
  end if;

  return p_limit;
end;
$$;

revoke all on function public.set_team_pool_limit(uuid, integer, uuid) from public, anon, authenticated;
