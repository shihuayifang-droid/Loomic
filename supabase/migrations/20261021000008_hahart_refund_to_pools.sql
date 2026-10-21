-- 工单37S · BL-41 ① ⑤ 第 1 步：按原路退款的数据库函数 refund_to_pools（新建，只增不改）。
--
-- 为什么只增不改：
--   本迁移只新增一个函数，不改 refund_credits / deduct_from_pools，也不接服务端
--   （服务端切换是下一张单，且带开关）。create or replace 可重复执行。
--
-- 与 BL-41 的对应：
--   ① 原路退回  按原扣费流水（同 job_id、generation_deduct、amount < 0、带 pool_breakdown，
--               即 deduct_from_pools 写的那一行）的 pool_breakdown 逐池退回：
--                 团队部分  扣费月的池行 pool_used 与成员当月 used 各减去该额（不低于 0）；
--                 充值部分  钱包 topup_balance 加回；
--                 每日部分  钱包 daily_date 仍是扣费日 -> daily_balance 加回；
--                           已跨日（原每日池已过期）-> 钱包不动，照退后立即过期：
--                           写一条同额 daily_expire（amount = -daily，pool = 'daily'），账平。
--   ② 流水      每笔退款一条流水，必带 job_id（p_job_id 为空 -> 22023），
--               metadata.original_transaction_id 指向原扣费流水。
--   ③ 退款额    = 该任务实扣 = daily + team + topup，不接受调用方传金额。
--   ⑤ 只退一次  同一 job 已有 generation_refund -> 直接返回该行 id，不改任何东西；
--               并发两次退款时，唯一索引冲突使整个语句回滚，由调用方重试后读到这条分支。
--
-- 为什么复用 generation_refund 与 36D 的唯一部分索引：
--   索引 credit_transactions_one_refund_per_job 建在
--   (job_id) where transaction_type = 'generation_refund' 上。新旧两条退款路径
--   （refund_credits 与本函数）共用同一个类型，同一 job 只能落一条退款，互斥由数据库保证。
--   refund_failed / refund_canceled 的拆分由 shared 层映射负责，不在本迁移。
--
-- 跨日过期的处理：
--   月键 / 日键取「扣费那一刻」的北京时间：
--     月键 = date_trunc('month', created_at at time zone 'Asia/Shanghai')::date
--     日键 = (created_at at time zone 'Asia/Shanghai')::date
--   任务跨过每日赠送过期时刻时，每日部分照退（退款流水金额含它），随后立即写 daily_expire，
--   流水时间顺序固定为：退款 -> 过期。
--
-- 池行 / 用量行不存在时跳过（不建行）；钱包不存在时为充值部分建行。
-- balance_after 写 0：三池口径的余额由读层给出，此处不重算。
--
-- 权限：只给 service role 调用，anon / authenticated 一律拒绝（42501）。

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

  -- 幂等：该 job 已经退过 -> 返回那一行，不改任何东西。
  select id into v_existing
  from public.credit_transactions
  where job_id = p_job_id and transaction_type = 'generation_refund'
  limit 1;
  if found then
    return v_existing;
  end if;

  -- 原扣费流水：deduct_from_pools 写的那一行。
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

  -- 团队部分：锁池行与成员用量行（固定顺序：池 -> 用量 -> 钱包），行不存在则跳过。
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

  -- 钱包：不存在则建行，然后加锁读取。
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

    -- 每日部分：仍是扣费当天 -> 加回；已跨日 -> 钱包不动，下面写 daily_expire。
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

  -- 唯一索引冲突（并发两次退款）-> 整个语句回滚，调用方重试读到上面的幂等分支。
  insert into public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description,
     pool, pool_breakdown, metadata)
  values
    (v_workspace_id, v_user_id, 'generation_refund', v_daily + v_team + v_topup, 0, p_job_id,
     coalesce(p_description, 'Refund'), v_pool, v_breakdown,
     jsonb_build_object('original_transaction_id', v_orig_id))
  returning id into v_tx_id;

  -- 原每日池已过期：照退之后立即过期，账平（排在退款流水之后写）。
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

revoke all on function public.refund_to_pools(uuid, text) from public, anon, authenticated;
