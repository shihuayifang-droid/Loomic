-- HaHart migration 0010 (ticket 43V, ADR-0001, OP-04).
--
-- Refund compensation queue and the charged-job creator, on top of 0006
-- (background_jobs), 0007 (deduct_credits), 0008 (deduct_from_pools) and 0002
-- (the native message queue). Ported from the final form of the retired
-- `supabase/migrations` chain (refund compensations, create_charged_job).
-- Differences by design:
--   * no row level policies and no role privilege statements: the server is the
--     only client;
--   * `create_charged_job` enqueues with a plain insert into
--     `hahart_queue.messages` (the native queue of 0002). The message content,
--     including the `job_id` key, is built exactly as in the source;
--   * `refund_compensations.user_id` is a plain uuid column, as in the source.
--
-- Create-only migration, runs on an empty database after 0001 .. 0009.

-- ---------------------------------------------------------------------------
-- 1. Refund compensation queue
--    One row per job. A refund that failed is recorded here, retried every five
--    minutes, and given up on (status 'exhausted') after max_attempts tries.
-- ---------------------------------------------------------------------------
create table public.refund_compensations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.background_jobs(id),
  workspace_id uuid not null,
  user_id uuid not null,
  amount integer not null check (amount > 0),
  description text not null,
  -- A charge that was never linked to its job is refunded outside the normal
  -- path; after a successful retry the job must be marked credits_link_refunded.
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

create index refund_compensations_due_idx
  on public.refund_compensations (next_attempt_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- 2. Record a failed refund. One row per job: a second failure for the same job
--    only refreshes last_error. A row that is already done or exhausted keeps
--    its status and its last_error.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3. Take up to p_limit due rows. Each taken row counts one attempt and is
--    pushed five minutes ahead, so a second worker (or the next pass) does not
--    take it again before this attempt has been finished.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4. Close one attempt. Success -> done. Failure -> exhausted once attempts has
--    reached max_attempts, otherwise the row stays pending with the new error.
--    Returns the resulting status. Only a pending row is changed.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5. Create the job row, charge credits and enqueue the message in ONE database
--    transaction. A failed charge leaves no queued job, and a failed enqueue
--    leaves the balance and the job table unchanged, because everything rolls
--    back together. No exception is caught inside this function; the SQLSTATE
--    of the inner function (P0402 / P0403 / P0404) reaches the caller as is.
-- ---------------------------------------------------------------------------
create or replace function public.create_charged_job(
  p_workspace_id uuid,
  p_user_id uuid,
  p_project_id uuid,
  p_canvas_id uuid,
  p_session_id uuid,
  p_thread_id text,
  p_queue_name text,
  p_job_type public.background_job_type,
  p_payload jsonb,
  p_client_request_id text,
  p_amount integer,
  p_description text,
  p_use_pools boolean,
  p_charge_workspace_id uuid,
  p_message jsonb
) returns table (job_id uuid, transaction_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_tx uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT: amount must be a positive integer'
      using errcode = '22023';
  end if;

  if p_user_id is null or p_workspace_id is null or p_queue_name is null then
    raise exception 'INVALID_ARGUMENT: user, workspace and queue are required'
      using errcode = '22023';
  end if;

  insert into public.background_jobs (
    workspace_id, project_id, canvas_id, session_id, thread_id,
    queue_name, job_type, payload, created_by, client_request_id
  ) values (
    p_workspace_id, p_project_id, p_canvas_id, p_session_id, p_thread_id,
    p_queue_name, p_job_type, coalesce(p_payload, '{}'::jsonb), p_user_id, p_client_request_id
  )
  returning id into v_job_id;

  if p_use_pools then
    v_tx := public.deduct_from_pools(p_charge_workspace_id, p_user_id, p_amount, v_job_id, p_description);
  else
    v_tx := public.deduct_credits(p_charge_workspace_id, p_user_id, p_amount, v_job_id, p_description);
  end if;

  update public.background_jobs
  set credits_cost = p_amount,
      credits_transaction_id = v_tx
  where id = v_job_id;

  insert into hahart_queue.messages (queue_name, message)
  values (
    p_queue_name,
    coalesce(p_message, '{}'::jsonb) || jsonb_build_object('job_id', v_job_id)
  );

  return query select v_job_id, v_tx;
end;
$$;
