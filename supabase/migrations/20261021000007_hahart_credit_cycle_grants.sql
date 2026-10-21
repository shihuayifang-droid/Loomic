-- 工单37O · BL-44 / BL-45 / BL-09 第 4 步（2/2）：池额度发放函数（新建，只增不改）。
--
-- 出处：
--   BL-44  团队池额度 = 管理员设定的月度总额，默认 = 成员数 x 20000；每自然月 1 日 00:00
--          （北京时间）重置、不滚存；重置写两条流水：cycle_reset（清零上月剩余，金额 = 实际剩余）
--          + cycle_grant（发放新额度）。
--   BL-45  每日赠送池 100 / 天，当日过期（北京时间 00:00）。
--
-- 为什么只增不改：
--   本迁移只新增两个函数，不改 claim_daily_credits / grant_plan_credits 等现有函数，
--   也不接服务端和定时任务（后续子单）。create or replace 可重复执行。
--
-- 幂等设计：
--   grant_team_cycle   本月池行已存在 -> 什么都不做，返回现有 pool_limit，同月重复调用不重复发放。
--   grant_daily_credits 钱包 daily_date 已是今天 -> 返回 false，不重复发放。
--
-- 为什么上月池行不改：
--   不滚存靠「换新月份行」实现，上月行保留 pool_limit / pool_used 作为报表历史；
--   清零只体现在一条 cycle_reset 流水里（金额 = 上月实际剩余）。
--
-- 北京时间口径：
--   月键 = date_trunc('month', now() at time zone 'Asia/Shanghai')::date；
--   日键 = (now() at time zone 'Asia/Shanghai')::date。与 37N 的 deduct_from_pools 同写法。
--
-- 与 37N 的关系：
--   deduct_from_pools 只读「本月池行」与「今天的每日余额」。本迁移负责把这两样写出来：
--   grant_team_cycle 建本月池行，grant_daily_credits 置今天的每日余额。
--
-- 流水 balance_after：
--   cycle_reset 写 0、cycle_grant 写新额度（团队池口径的池余额）。
--
-- 权限：只给 service role 调用，anon / authenticated 一律拒绝（42501）。

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

  -- 本月池行已存在 -> 幂等返回。
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

  -- 先占位建本月池行；并发时只有一个调用者建成功，其余走幂等返回。
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

  -- 上月剩余清零（只写流水，上月行不改）。
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

  -- 更早日子的剩余过期。
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

revoke all on function public.grant_team_cycle(uuid, date, integer) from public, anon, authenticated;
revoke all on function public.grant_daily_credits(uuid, uuid, integer) from public, anon, authenticated;
