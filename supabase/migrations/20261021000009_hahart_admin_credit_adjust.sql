-- 工单37U · BL-12 / BL-01 / AD-01 第 1 步：后台加减积分与改个人上限的数据库函数（新建，只增不改）。
--
-- 为什么只增不改：
--   本迁移只新增两个函数，不改其它函数与表。接口与管理员身份校验是下一张单；
--   本单函数只给 service role，调用前由路由校验管理员身份。create or replace 可重复执行。
--
-- BL-12  管理员给指定成员加 / 减积分（数额可负，原因必填）：
--   admin_adjust_topup(workspace, user, operator, delta, reason) -> 流水 id
--   - 加分进充值池（不过期），不碰 member_team_usage，所以不计入个人月上限。
--   - 减分只能从充值池减，减到 0 为止；不足时拒绝，SQLSTATE = P0405（ADJUST_EXCEEDS_TOPUP）。
--     错误的 detail 字段带「最多可减」的数（充值池当前余额的十进制文本），
--     供服务端原样回给前端，提示「最多可减 N」。服务端认码不认文案。
--   - 每次调整写一条 admin_adjustment 流水（shared 层映射为 admin_adjust）：
--     amount = 带符号数额，pool = 'topup'，balance_after = 调整后充值池余额，
--     metadata 含 operator_id、reason（去首尾空白）、balance_before、balance_after。
--   - delta 为空或 0、reason 去空白后为空、operator 为空 -> 22023。
--
-- BL-01 / AD-01  管理员单独调整某人个人月上限：
--   set_personal_cap(workspace, user, cap, month default null) -> 新上限
--   - 月份缺省为北京时间当月 1 日；非 1 日 -> 22023；cap 为空或小于 0 -> 22023。
--   - 对 member_team_usage 做 upsert，只改 personal_cap，used 不变。
--   - 额度模板（BL-01 第 2 条）不在本迁移。
--
-- 权限：只给 service role 调用，anon / authenticated 一律拒绝（42501）。

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

  return v_tx_id;
end;
$$;

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

  insert into public.member_team_usage (workspace_id, user_id, period_month, personal_cap)
  values (p_workspace_id, p_user_id, v_month, p_cap)
  on conflict (workspace_id, user_id, period_month)
  do update set personal_cap = excluded.personal_cap, updated_at = now();

  return p_cap;
end;
$$;

revoke all on function public.admin_adjust_topup(uuid, uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.set_personal_cap(uuid, uuid, integer, date) from public, anon, authenticated;
