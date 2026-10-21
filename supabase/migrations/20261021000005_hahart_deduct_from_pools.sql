-- 工单37N · BL-04 / BL-45 第 3 步：按池扣费函数 deduct_from_pools（新建，只增不改）。
--
-- 为什么只增不改：
--   本迁移只新增一个函数，不改 deduct_credits / refund_credits / claim_daily_credits，
--   也不改服务端调用方；接入是后续子单。create or replace 可重复执行。
--
-- 与 37L shared 口径 planDeduction 的对应关系（逐条一致）：
--   顺序        先每日池 -> 再团队周期池（受个人月上限约束）-> 再充值池。
--   团队可用    team_allowance = greatest(0, least(pool_limit - pool_used, personal_cap - used))
--   个人月上限  只约束从团队池扣的部分，不约束每日池与充值池。
--   凑不够      整笔拒绝、不改任何行，按「上限先到 / 池先空 / 都没有」给码。
--   T-106（上限零头时是否整笔走充值）未决，本函数按 BL-04 顺序实现，和 37L 同口径。
--
-- 三个 SQLSTATE（服务端认码不认文案，BL-45）：
--   P0402  INSUFFICIENT_CREDITS   团队池与个人上限都没有余量，且每日 / 充值也不够
--                                 （沿用 33D 的 deduct_credits 的码）。
--   P0403  PERSONAL_CAP_REACHED   个人月上限先到（新增）。
--   P0404  TEAM_POOL_EXHAUSTED    团队池先空（新增）。
--
-- 北京时间：
--   月键 = date_trunc('month', now() at time zone 'Asia/Shanghai')::date（当月 1 日）。
--   每日池的「今天」 = (now() at time zone 'Asia/Shanghai')::date；钱包 daily_date 不等于
--   今天时每日池按 0 计（过期不扣、不报错，也不在本函数里发放）。
--
-- 为什么不自动建池行：
--   团队池额度由管理员 / 月初任务设定（BL-44）。没有池行 = 团队剩余 0，本函数不替人开额度。
--   member_team_usage 行则不同：只有真正扣到团队池时才按默认上限 20000 建行。
--
-- 权限：只给 service role 调用，anon / authenticated 一律拒绝（42501）。

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
    v_cap := 20000;
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
