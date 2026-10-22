-- 39J (BL-41 compensation queue, step 1): a durable queue for refunds that
-- failed, plus the three SQL functions that fill it, drain it and close its rows.
--
-- Why: today a failed refund is only logged, so the user's credits are lost for
-- good. A failed refund is now recorded here ONCE PER JOB, retried every five
-- minutes, and given up on (status 'exhausted', for an admin alert) after the
-- twelfth failed try. The refund itself stays idempotent per job through the
-- unique index on the ledger (36D), so a retry after an unknown outcome cannot
-- pay out twice.
--
-- This migration only adds the table and the functions. Recording a failure and
-- the periodic retry are wired in by later workorders (39K / 39L).
--
-- Access: the table has row level security on and NO policy, so only the
-- server's privileged connection can read or write it. The three functions are
-- not executable by anon / authenticated (42501).

create table if not exists public.refund_compensations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.background_jobs(id),
  workspace_id uuid not null,
  user_id uuid not null,
  amount integer not null check (amount > 0),
  description text not null,
  -- 21H2: a charge that was never linked to its job is refunded outside the
  -- normal path; after a successful retry the job must be marked
  -- credits_link_refunded.
  mark_link_refunded boolean not null default false,
  attempts integer not null default 0,
  max_attempts integer not null default 12,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  status text not null default 'pending'
    check (status in ('pending', 'done', 'exhausted')),
  refund_transaction_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists refund_compensations_due_idx
  on public.refund_compensations (next_attempt_at)
  where status = 'pending';

alter table public.refund_compensations enable row level security;

revoke all on table public.refund_compensations from anon, authenticated;

-- Record a failed refund. One row per job: a second failure for the same job
-- only refreshes last_error. A row that is already done or exhausted keeps its
-- status and its last_error.
create or replace function public.record_refund_compensation(
  p_job_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_description text,
  p_mark_link_refunded boolean,
  p_error text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT: amount must be a positive integer'
      using errcode = '22023';
  end if;

  insert into public.refund_compensations as rc (
    job_id, workspace_id, user_id, amount, description,
    mark_link_refunded, last_error, next_attempt_at
  ) values (
    p_job_id, p_workspace_id, p_user_id, p_amount, p_description,
    coalesce(p_mark_link_refunded, false), p_error,
    now() + interval '5 minutes'
  )
  on conflict (job_id) do update
    set last_error = case when rc.status = 'pending' then excluded.last_error else rc.last_error end,
        updated_at = now()
  returning rc.id into v_id;

  return v_id;
end;
$$;

-- Take up to p_limit due rows. Each taken row counts one attempt and is pushed
-- five minutes ahead, so a second worker (or the next pass) does not take it
-- again before this attempt has been finished.
create or replace function public.claim_refund_compensations(p_limit integer)
returns setof public.refund_compensations
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.refund_compensations rc
     set attempts = rc.attempts + 1,
         next_attempt_at = now() + interval '5 minutes',
         updated_at = now()
   where rc.id in (
     select c.id
       from public.refund_compensations c
      where c.status = 'pending'
        and c.next_attempt_at <= now()
      order by c.next_attempt_at
      limit p_limit
      for update skip locked
   )
  returning rc.*;
end;
$$;

-- Close one attempt. Success -> done. Failure -> exhausted once attempts has
-- reached max_attempts, otherwise the row stays pending with the new error.
-- Returns the resulting status. Only a pending row is changed.
create or replace function public.finish_refund_compensation(
  p_id uuid,
  p_ok boolean,
  p_refund_tx uuid,
  p_error text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if p_ok then
    update public.refund_compensations
       set status = 'done',
           refund_transaction_id = p_refund_tx,
           updated_at = now()
     where id = p_id and status = 'pending'
    returning status into v_status;
  else
    update public.refund_compensations
       set status = case when attempts >= max_attempts then 'exhausted' else status end,
           last_error = p_error,
           updated_at = now()
     where id = p_id and status = 'pending'
    returning status into v_status;
  end if;

  if v_status is null then
    select status into v_status from public.refund_compensations where id = p_id;
  end if;

  if v_status is null then
    raise exception 'NOT_FOUND: refund compensation does not exist'
      using errcode = 'P0002';
  end if;

  return v_status;
end;
$$;

revoke all on function public.record_refund_compensation(uuid, uuid, uuid, integer, text, boolean, text)
  from public, anon, authenticated;
revoke all on function public.claim_refund_compensations(integer)
  from public, anon, authenticated;
revoke all on function public.finish_refund_compensation(uuid, boolean, uuid, text)
  from public, anon, authenticated;
