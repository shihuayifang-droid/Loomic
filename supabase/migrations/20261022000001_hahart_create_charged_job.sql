-- 39E (GN-33 step 1): create the job row, charge credits and enqueue the
-- message in ONE database transaction.
--
-- Why: today the server inserts the job, calls the deduct function and sends the
-- queue message over three separate connections and relies on compensation when
-- one of them fails. Here a failed charge leaves no queued job, and a failed
-- enqueue leaves the balance and the job table unchanged, because everything
-- rolls back together. No exception is caught inside this function; the
-- SQLSTATE of the inner function (P0402 / P0403 / P0404) reaches the caller as is.
--
-- This migration only adds the function. The server is switched over later.
-- Only the service role may call it (anon / authenticated get 42501).

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

  perform pgmq.send(
    p_queue_name,
    coalesce(p_message, '{}'::jsonb) || jsonb_build_object('job_id', v_job_id)
  );

  return query select v_job_id, v_tx;
end;
$$;

revoke all on function public.create_charged_job(
  uuid, uuid, uuid, uuid, uuid, text, text, public.background_job_type, jsonb, text,
  integer, text, boolean, uuid, jsonb
) from public, anon, authenticated;
