-- HaHart migration 0007 (ticket 43S, ADR-0001, OP-04).
--
-- Credits core and pricing on top of 0003 (workspaces, hahart_auth users) and
-- 0006 (background_jobs). Ported from the final form of the retired
-- `supabase/migrations` chain (credits system + payment columns + pricing rules
-- + deduct sqlstate + refund once per job + credit pool columns + cycle types).
-- Differences by design:
--   * `credit_transactions.user_id` points at `hahart_auth.users(id)`; the source
--     foreign key had no `on delete` action and that is kept (no action);
--   * no row level policies and no role grants: the server is the only client;
--   * no `payment_events` table: payments are offline. The payment columns that
--     the source added to `subscriptions` stay, they are part of its final form;
--   * `credit_transactions.pool` / `pool_breakdown` are plain columns here. The
--     team pool tables (`team_credit_pools`, member wallets, `deduct_from_pools`)
--     belong to 0008; no foreign key points at them from this file;
--   * `price_change_log.operator_id` has no foreign key, exactly as in the source;
--   * `background_jobs.credits_transaction_id` has no foreign key in the source,
--     so none is added; `credit_transactions.job_id` references background_jobs.
--
-- Create-only migration, runs on an empty database after 0001 .. 0006.

-- ---------------------------------------------------------------------------
-- 1. Enums (final value lists, in the final sort order)
-- ---------------------------------------------------------------------------
create type public.subscription_plan as enum ('free', 'starter', 'pro', 'ultra', 'business');

create type public.billing_period as enum ('monthly', 'yearly');

create type public.credit_transaction_type as enum (
  'subscription_grant',
  'daily_grant',
  'purchase',
  'generation_deduct',
  'generation_refund',
  'admin_adjustment',
  'bonus',
  'cycle_grant',
  'cycle_reset',
  'daily_expire'
);

-- ---------------------------------------------------------------------------
-- 2. Subscriptions, balances, ledger, daily claims
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces (id) on delete cascade,
  plan public.subscription_plan not null default 'free',
  billing_period public.billing_period,
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  lemon_squeezy_subscription_id text,
  lemon_squeezy_customer_id text,
  lemon_squeezy_variant_id text,
  lemon_squeezy_order_id text
);

create index idx_subscriptions_ls_customer
  on public.subscriptions (lemon_squeezy_customer_id)
  where lemon_squeezy_customer_id is not null;
create index idx_subscriptions_ls_subscription
  on public.subscriptions (lemon_squeezy_subscription_id)
  where lemon_squeezy_subscription_id is not null;

create table public.credit_balances (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces (id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

create table public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid references hahart_auth.users (id),
  transaction_type public.credit_transaction_type not null,
  amount integer not null,
  balance_after integer not null,
  job_id uuid references public.background_jobs (id),
  description text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Plain columns: the pool tables they describe are created in 0008.
  pool text check (pool in ('daily', 'team', 'topup')),
  pool_breakdown jsonb
);

create index idx_credit_transactions_workspace
  on public.credit_transactions (workspace_id, created_at desc);
create index idx_credit_transactions_job
  on public.credit_transactions (job_id)
  where job_id is not null;
-- One refund per job: a second refund for the same job cannot be written.
create unique index credit_transactions_one_refund_per_job
  on public.credit_transactions (job_id)
  where transaction_type = 'generation_refund' and job_id is not null;

create table public.daily_credit_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  claim_date date not null default current_date,
  amount integer not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, claim_date)
);

-- ---------------------------------------------------------------------------
-- 3. Pricing: rules and change log (server-side repository only)
-- ---------------------------------------------------------------------------
create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  model_id text not null,
  entry_point text not null default '*'
    check (entry_point in ('*', 'agent', 'agent_generator', 'canvas_generator', 'tool')),
  search_key text not null,
  time_period text not null default 'normal' check (time_period in ('*', 'normal')),
  unit_name text not null default '次',
  unit_size integer check (unit_size is null or unit_size > 0),
  price integer,
  price_status text not null check (price_status in ('pending', 'active')),
  effective_at timestamptz not null default now(),
  extras jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  check (
    (price_status = 'pending' and price is null)
    or (price_status = 'active' and price is not null and price >= 0)
  ),
  unique (model_id, entry_point, search_key, time_period, effective_at)
);

create index pricing_rules_model_effective_idx
  on public.pricing_rules (model_id, effective_at desc);

create table public.price_change_log (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.pricing_rules (id) on delete cascade,
  operator_id uuid not null,
  old_price integer,
  new_price integer,
  old_status text not null,
  new_status text not null,
  effective_at timestamptz not null,
  reason text not null check (length(reason) > 0),
  changed_at timestamptz not null default now()
);

create index price_change_log_rule_changed_idx
  on public.price_change_log (rule_id, changed_at desc);

-- Seed rows (same 123 rows as the source): every row is pending with no price.
-- A model without a row is rejected as unregistered, so the rows must exist.
-- 18 tools (tool:<id>, with the upscale / edit_text tiers).
insert into public.pricing_rules (model_id, entry_point, search_key, unit_name, price_status)
select t.model_id, '*', t.search_key, '次', 'pending'
from (values
  ('tool:quick_edit', '*'), ('tool:remove_background', '*'),
  ('tool:upscale', '*'), ('tool:upscale', '2k'), ('tool:upscale', '4k'), ('tool:upscale', '8k'),
  ('tool:layer_split_auto', '*'), ('tool:layer_split_custom', '*'),
  ('tool:edit_text', '*'), ('tool:edit_text', '1k'), ('tool:edit_text', '2k'), ('tool:edit_text', '4k'),
  ('tool:multi_angle', '*'), ('tool:erase', '*'), ('tool:expand', '*'),
  ('tool:move_object', '*'), ('tool:vectorize', '*'), ('tool:motion', '*')
) as t (model_id, search_key);

-- 20 image models x (default row + standard / hd / ultra) = 80 rows.
insert into public.pricing_rules (model_id, entry_point, search_key, unit_name, price_status)
select m.model_id, '*', k.search_key, '次', 'pending'
from unnest(array[
  'black-forest-labs/flux-kontext-max', 'black-forest-labs/flux-kontext-pro',
  'bytedance/seedream-4', 'bytedance/seedream-4.5', 'bytedance/seedream-5-lite',
  'google-official/gemini-2.5-flash-image', 'google-official/gemini-3-pro-image-preview',
  'google-official/gemini-3.1-flash-image-preview',
  'google-vertex/gemini-2.5-flash-image', 'google-vertex/gemini-3-pro-image-preview',
  'google-vertex/gemini-3.1-flash-image-preview',
  'google/imagen-4', 'google/nano-banana', 'google/nano-banana-2', 'google/nano-banana-pro',
  'kwjm/gpt-image-1.5', 'kwjm/gpt-image-2', 'kwjm/gpt-image-2-inpaint',
  'openai/gpt-image-1.5', 'recraft-ai/recraft-v3'
]) as m (model_id)
cross join unnest(array['*', 'standard', 'hd', 'ultra']) as k (search_key);

-- 25 video models, one default row each; the unit is the second.
insert into public.pricing_rules (model_id, entry_point, search_key, unit_name, price_status)
select m.model_id, '*', '*', '秒', 'pending'
from unnest(array[
  'bytedance/seedance-1.5-pro',
  'google-official/veo-2.0-generate-001', 'google-official/veo-3.0-fast-generate-001',
  'google-official/veo-3.0-generate-001', 'google-official/veo-3.1-fast-generate-preview',
  'google-official/veo-3.1-generate-preview', 'google-official/veo-3.1-lite-generate-preview',
  'google-vertex/veo-2.0-generate-001', 'google-vertex/veo-3.0-fast-generate-001',
  'google-vertex/veo-3.0-generate-001', 'google-vertex/veo-3.1-fast-generate-001',
  'google-vertex/veo-3.1-generate-001', 'google-vertex/veo-3.1-lite-generate-001',
  'google/veo-3', 'google/veo-3.1', 'google/veo-3.1-fast',
  'kwaivgi/kling-o1', 'kwaivgi/kling-v2.6', 'kwaivgi/kling-v3-omni-video', 'kwaivgi/kling-v3-video',
  'metaso/minimax-h3', 'minimax/hailuo-2.3', 'openai/sora-2', 'openai/sora-2-pro', 'wan-video/wan-2.6'
]) as m (model_id);

-- ---------------------------------------------------------------------------
-- 4. Functions (final versions; all take explicit workspace / user ids)
-- ---------------------------------------------------------------------------
create or replace function public.init_workspace_credits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.subscriptions (workspace_id, plan)
  values (new.id, 'free')
  on conflict (workspace_id) do nothing;

  insert into public.credit_balances (workspace_id, balance)
  values (new.id, 0)
  on conflict (workspace_id) do nothing;

  return new;
end;
$$;

create trigger trg_init_workspace_credits
  after insert on public.workspaces
  for each row
  execute function public.init_workspace_credits();

create or replace function public.deduct_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_job_id uuid default null,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
  v_new_balance integer;
  v_version integer;
  v_tx_id uuid;
begin
  select balance, version into v_balance, v_version
  from public.credit_balances
  where workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'NO_BALANCE: No credit balance found for workspace %', p_workspace_id;
  end if;

  v_new_balance := v_balance - p_amount;

  if v_new_balance < 0 then
    raise exception 'INSUFFICIENT_CREDITS: have %, need %', v_balance, p_amount
      using errcode = 'P0402';
  end if;

  update public.credit_balances
  set balance = v_new_balance,
      version = v_version + 1,
      updated_at = now()
  where workspace_id = p_workspace_id and version = v_version;

  if not found then
    raise exception 'CONCURRENT_MODIFICATION: credit balance was modified concurrently';
  end if;

  insert into public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description)
  values
    (p_workspace_id, p_user_id, 'generation_deduct', -p_amount, v_new_balance, p_job_id, p_description)
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

create or replace function public.refund_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_job_id uuid,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
  v_version integer;
  v_new_balance integer;
  v_tx_id uuid;
begin
  -- One refund per job: a repeated call returns the first refund and adds nothing.
  if p_job_id is not null then
    select id into v_tx_id
    from public.credit_transactions
    where job_id = p_job_id
      and transaction_type = 'generation_refund'
    limit 1;

    if found then
      return v_tx_id;
    end if;
  end if;

  select balance, version into v_balance, v_version
  from public.credit_balances
  where workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'NO_BALANCE: No credit balance found for workspace %', p_workspace_id;
  end if;

  v_new_balance := v_balance + p_amount;

  update public.credit_balances
  set balance = v_new_balance,
      version = v_version + 1,
      updated_at = now()
  where workspace_id = p_workspace_id and version = v_version;

  if not found then
    raise exception 'CONCURRENT_MODIFICATION: credit balance was modified concurrently';
  end if;

  insert into public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description)
  values
    (p_workspace_id, p_user_id, 'generation_refund', p_amount, v_new_balance, p_job_id, p_description)
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

create or replace function public.claim_daily_credits(
  p_workspace_id uuid,
  p_amount integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version integer;
  v_balance integer;
  v_new_balance integer;
begin
  if exists (
    select 1 from public.daily_credit_claims
    where workspace_id = p_workspace_id and claim_date = current_date
  ) then
    return false;
  end if;

  select balance, version into v_balance, v_version
  from public.credit_balances
  where workspace_id = p_workspace_id
  for update;

  if not found then
    insert into public.credit_balances (workspace_id, balance, version)
    values (p_workspace_id, 0, 0)
    on conflict (workspace_id) do nothing;

    select balance, version into v_balance, v_version
    from public.credit_balances
    where workspace_id = p_workspace_id
    for update;
  end if;

  v_new_balance := v_balance + p_amount;

  update public.credit_balances
  set balance = v_new_balance,
      version = v_version + 1,
      updated_at = now()
  where workspace_id = p_workspace_id and version = v_version;

  insert into public.daily_credit_claims (workspace_id, claim_date, amount)
  values (p_workspace_id, current_date, p_amount);

  insert into public.credit_transactions
    (workspace_id, transaction_type, amount, balance_after, description)
  values
    (p_workspace_id, 'daily_grant', p_amount, v_new_balance, 'Daily free credits');

  return true;
end;
$$;

create or replace function public.grant_plan_credits(
  p_workspace_id uuid,
  p_plan public.subscription_plan,
  p_credits integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
  v_new_balance integer;
  v_version integer;
begin
  -- 1. Update the subscription plan
  update public.subscriptions
  set plan = p_plan,
      updated_at = now()
  where workspace_id = p_workspace_id;

  if not found then
    raise exception 'NO_SUBSCRIPTION: No subscription found for workspace %', p_workspace_id;
  end if;

  -- 2. If no credits to add, just return the current balance
  if p_credits <= 0 then
    select coalesce(balance, 0) into v_new_balance
    from public.credit_balances
    where workspace_id = p_workspace_id;

    return coalesce(v_new_balance, 0);
  end if;

  -- 3. Lock the balance row and atomically increment
  select balance, version into v_balance, v_version
  from public.credit_balances
  where workspace_id = p_workspace_id
  for update;

  if not found then
    -- Auto-init if missing (defensive: the trigger should have created it)
    insert into public.credit_balances (workspace_id, balance, version)
    values (p_workspace_id, 0, 0)
    on conflict (workspace_id) do nothing;

    select balance, version into v_balance, v_version
    from public.credit_balances
    where workspace_id = p_workspace_id
    for update;
  end if;

  v_new_balance := v_balance + p_credits;

  update public.credit_balances
  set balance = v_new_balance,
      version = v_version + 1,
      updated_at = now()
  where workspace_id = p_workspace_id and version = v_version;

  if not found then
    raise exception 'CONCURRENT_MODIFICATION: credit balance was modified concurrently';
  end if;

  -- 4. Record the transaction
  insert into public.credit_transactions
    (workspace_id, transaction_type, amount, balance_after, description)
  values
    (p_workspace_id, 'subscription_grant', p_credits, v_new_balance,
     'Plan upgraded to ' || p_plan::text || ' — monthly credits granted');

  return v_new_balance;
end;
$$;
