-- BL-41 (5) / T-40: one refund per job, enforced by the database itself.
--
-- `refund_credits` in 20260331200000_credits_system.sql adds the amount and
-- inserts a `generation_refund` row unconditionally, so calling it twice for the
-- same job row refunds twice. The server already claims the job before refunding,
-- but nothing below the server stops a retry, a duplicate delivery or a manual
-- call from paying out a second time.
--
-- Two layers, because they cover different failures:
--
--   1. The function looks for an existing `generation_refund` row for the job
--      BEFORE touching the balance and returns that row's id when it finds one.
--      Returning the existing id (instead of raising) lets the caller treat a
--      second call as the same successful refund it already recorded - a retry
--      stays a success, and the ledger keeps exactly one row.
--   2. The partial unique index is the backstop for the case a lookup cannot
--      cover: two callers entering at the same time, both find nothing, both try
--      to insert. The second insert raises SQLSTATE 23505, the whole statement
--      (and its transaction) rolls back, so the balance it had just increased is
--      rolled back with it and the ledger keeps one row.
--
-- Refunds without a job (`p_job_id is null`) are NOT de-duplicated: the index is
-- partial on `job_id is not null`, and the lookup is skipped for a null job, so
-- non-job refunds keep working exactly as they did before.
--
-- Pre-launch check (ADR-0003: a fresh database is built from the migrations and
-- old data is not migrated). A database that already carries MORE THAN ONE
-- `generation_refund` row for the same job_id will fail to build this index. Run
-- this against any database that predates this migration before deploying, and
-- reconcile the rows by hand first:
--
--   select job_id, count(*)
--     from public.credit_transactions
--    where transaction_type = 'generation_refund'
--      and job_id is not null
--    group by job_id
--   having count(*) > 1;

create unique index if not exists credit_transactions_one_refund_per_job
  on public.credit_transactions (job_id)
  where transaction_type = 'generation_refund' and job_id is not null;

-- Signature, return type, SECURITY DEFINER and search_path are unchanged from the
-- original definition; only the idempotency block at the top of the body is new.
CREATE OR REPLACE FUNCTION public.refund_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_job_id uuid,
  p_description text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_version integer;
  v_new_balance integer;
  v_tx_id uuid;
BEGIN
  IF p_job_id IS NOT NULL THEN
    SELECT id INTO v_tx_id
    FROM public.credit_transactions
    WHERE job_id = p_job_id
      AND transaction_type = 'generation_refund'
    LIMIT 1;

    IF FOUND THEN
      RETURN v_tx_id;
    END IF;
  END IF;

  SELECT balance, version INTO v_balance, v_version
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_BALANCE: No credit balance found for workspace %', p_workspace_id;
  END IF;

  v_new_balance := v_balance + p_amount;

  UPDATE public.credit_balances
  SET balance = v_new_balance,
      version = v_version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND version = v_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION: credit balance was modified concurrently';
  END IF;

  INSERT INTO public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description)
  VALUES
    (p_workspace_id, p_user_id, 'generation_refund', p_amount, v_new_balance, p_job_id, p_description)
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;
