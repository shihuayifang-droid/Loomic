-- 工单37M · BL-44 / BL-02 / BL-45 第 2 步：三池账本表（只建表与读写约束）。
--
-- 为什么只增不改：
--   本迁移只新增三张表和 credit_transactions 的两个可空列，不改
--   deduct_credits / refund_credits / claim_daily_credits，也不改现有
--   credit_balances。现有扣费路径一字不动；扣费函数改造、发放 / 重置任务、
--   接口接入是后续子单。所有语句都是 if not exists，可重复执行。
--
-- 月份键：
--   period_month 一律是「北京时间自然月」的 1 日（如 2026-10-01），
--   由 check (extract(day from period_month) = 1) 保证。每自然月 1 日 00:00
--   （北京时间）重置 = 换一个新的 period_month 行，旧行留作历史。
--
-- 个人上限：
--   member_team_usage.personal_cap 默认 20000，出处 BL-45 / D-17，AD-01 可调。
--   个人月上限只约束团队池部分（不约束每日池与充值池）。
--
-- 与 37L shared 口径的对应关系：
--   teamRemaining      = pool_limit - pool_used   （团队周期池，已用与总额分开存）
--   personalTeamUsed   = member_team_usage.used   （成员本月从团队池用了多少）
--
-- RLS：三张新表都开启；只有 select 策略，没有 insert / update / delete 策略，
--   写入只经 service role 或后续 SECURITY DEFINER 函数。

-- 1. 团队周期池：一个工作区 = 一个团队池，每个自然月一行。
create table if not exists public.team_credit_pools (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  period_month date not null check (extract(day from period_month) = 1),
  pool_limit integer not null check (pool_limit >= 0),
  pool_used integer not null default 0 check (pool_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, period_month)
);

-- 2. 成员本月团队池用量。
create table if not exists public.member_team_usage (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  period_month date not null check (extract(day from period_month) = 1),
  used integer not null default 0 check (used >= 0),
  personal_cap integer not null default 20000 check (personal_cap >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id, period_month)
);

-- 3. 个人钱包：每日池与充值池分开存。
create table if not exists public.user_credit_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  daily_date date,
  daily_balance integer not null default 0 check (daily_balance >= 0),
  topup_balance integer not null default 0 check (topup_balance >= 0),
  updated_at timestamptz not null default now()
);

-- 4. 流水加池字段（可空：旧流水无池）。
alter table public.credit_transactions
  add column if not exists pool text check (pool in ('daily', 'team', 'topup'));
alter table public.credit_transactions
  add column if not exists pool_breakdown jsonb;

-- 5. RLS
alter table public.team_credit_pools enable row level security;
alter table public.member_team_usage enable row level security;
alter table public.user_credit_wallets enable row level security;

drop policy if exists team_credit_pools_select_member on public.team_credit_pools;
create policy team_credit_pools_select_member on public.team_credit_pools
  for select
  using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = team_credit_pools.workspace_id
        and m.user_id = auth.uid()
    )
  );

drop policy if exists member_team_usage_select_self_or_admin on public.member_team_usage;
create policy member_team_usage_select_self_or_admin on public.member_team_usage
  for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.workspace_members m
      where m.workspace_id = member_team_usage.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

drop policy if exists user_credit_wallets_select_self on public.user_credit_wallets;
create policy user_credit_wallets_select_self on public.user_credit_wallets
  for select
  using (user_id = auth.uid());
