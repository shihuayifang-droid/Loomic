-- HaHart migration 0006 (ticket 43R, ADR-0001, OP-04).
--
-- Background jobs on top of 0003 (workspaces), 0004 (projects, canvases, assets)
-- and 0005 (chat sessions). Ported from the final form of the retired
-- `supabase/migrations` chain (background_jobs + video / code / tool execution
-- job types + credits columns + `retrying` status + client request id).
-- Differences by design:
--   * `background_jobs.created_by` points at `hahart_auth.users(id)`; the source
--     foreign key had no `on delete` action and that is kept (no action);
--   * no row level policies and no role grants: the server is the only client;
--   * the `updated_at` trigger uses `public.set_updated_at()` from 0003;
--   * the source created a message queue for the jobs; that is NOT done here:
--     the fresh database uses the native queue schema from 0002;
--   * `credits_transaction_id` is a plain uuid column, exactly as in the source
--     (the source never put a foreign key on it);
--   * the foreign keys that OTHER tables hold on `background_jobs(id)`
--     (`credit_transactions.job_id`, `refund_compensations.job_id`) belong to the
--     migration that creates those credit tables (0007), not to this file;
--   * `create_charged_job` (credits + queue) is not part of this file; the
--     attempt counter is incremented by inline SQL in the server, so the
--     `increment_job_attempt` function is not ported either.
--
-- Create-only migration, runs on an empty database after 0001 .. 0005.

-- ---------------------------------------------------------------------------
-- 1. Enums (final value lists, in the final sort order)
-- ---------------------------------------------------------------------------
create type public.background_job_status as enum (
  'queued',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'canceled',
  'dead_letter'
);

create type public.background_job_type as enum (
  'image_generation',
  'video_generation',
  'code_execution',
  'tool_execution'
);

-- ---------------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------------
create table public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  project_id uuid references public.projects (id) on delete set null,
  canvas_id uuid references public.canvases (id) on delete set null,
  session_id uuid references public.chat_sessions (id) on delete set null,
  thread_id text,
  queue_name text not null,
  job_type public.background_job_type not null,
  status public.background_job_status not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error_code text,
  error_message text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  created_by uuid not null references hahart_auth.users (id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  canceled_at timestamptz,
  updated_at timestamptz not null default now(),
  -- Plain column, no foreign key (same as the source); the credit ledger is 0007.
  credits_transaction_id uuid,
  credits_cost integer,
  client_request_id text
    constraint background_jobs_client_request_id_check
    check (
      client_request_id is null
      or (char_length(client_request_id) >= 8 and char_length(client_request_id) <= 128)
    )
);

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------
create index idx_background_jobs_workspace on public.background_jobs (workspace_id);
create index idx_background_jobs_created_by on public.background_jobs (created_by);
create index idx_background_jobs_status on public.background_jobs (status);
create index idx_background_jobs_job_type_status
  on public.background_jobs (job_type, status);

-- One submission id means one job per owner.
create unique index background_jobs_owner_client_request_id_key
  on public.background_jobs (created_by, client_request_id)
  where client_request_id is not null;

-- ---------------------------------------------------------------------------
-- 4. updated_at trigger (`public.set_updated_at` comes from 0003)
-- ---------------------------------------------------------------------------
create trigger trg_background_jobs_updated_at
  before update on public.background_jobs
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Foreign key that 0004 left open: asset_objects.source_job_id
-- ---------------------------------------------------------------------------
alter table public.asset_objects
  add constraint asset_objects_source_job_fkey
  foreign key (source_job_id) references public.background_jobs (id)
  on delete set null;

create index asset_objects_source_job_id_idx on public.asset_objects (source_job_id);
