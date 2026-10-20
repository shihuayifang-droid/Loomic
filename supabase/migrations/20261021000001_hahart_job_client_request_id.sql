-- ED-00m / GN-38: the browser names each submission; the same name from the
-- same user within 24 hours means the same job, so a double click or a
-- network resend cannot create (or charge for) a second one.
--
-- The unique index below is UNBOUNDED IN TIME: the 24 hour window is what the
-- read path filters on, not what the index enforces. The same request id reused
-- after the window therefore still collides (23505) instead of quietly creating
-- a second job; the write path added by the following workorder has to answer
-- that collision by reusing the existing job or by naming the next submission
-- differently. Keeping the window out of the constraint is deliberate: an index
-- cannot express "unique within a rolling window", and a constraint that only
-- held for 24 hours would let a slow resend create a second job the day after.
alter table public.background_jobs
  add column if not exists client_request_id text;

alter table public.background_jobs
  add constraint background_jobs_client_request_id_check
    check (client_request_id is null or char_length(client_request_id) between 8 and 128);

create unique index if not exists background_jobs_owner_client_request_id_key
  on public.background_jobs (created_by, client_request_id)
  where client_request_id is not null;
