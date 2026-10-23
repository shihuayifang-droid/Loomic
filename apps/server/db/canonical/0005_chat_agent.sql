-- HaHart migration 0005 (ticket 43Q, ADR-0001, OP-04).
--
-- Chat sessions, chat messages and agent runs on top of 0004 (canvases).
-- Ported from the final form of the retired `supabase/migrations` chain
-- (chat sessions + agent thread persistence + message content blocks).
-- Differences by design:
--   * `chat_sessions.created_by` points at `hahart_auth.users(id)`; the source
--     foreign key had no `on delete` action and that is kept (no action);
--   * no row level policies and no role grants: the server is the only client;
--   * the `updated_at` trigger uses `public.set_updated_at()` from 0003 instead of
--     the Supabase `moddatetime` extension function;
--   * the LangGraph checkpoint tables are NOT created here: the library creates
--     them itself in the `langgraph` schema (`PostgresSaver.setup()`).
--
-- Create-only migration, runs on an empty database after 0001 .. 0004.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  canvas_id uuid not null references public.canvases (id) on delete cascade,
  title text not null default 'New Chat',
  created_by uuid references hahart_auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Server-owned LangGraph thread identifier; legacy rows may stay null.
  thread_id text
);

comment on table public.chat_sessions is 'Chat conversation sessions linked to canvases.';
comment on column public.chat_sessions.thread_id is
  'Server-owned LangGraph thread identifier for new chat sessions.';

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  tool_activities jsonb,
  created_at timestamptz not null default now(),
  content_blocks jsonb
);

comment on table public.chat_messages is 'Individual chat messages within a session.';

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  thread_id text not null,
  status text not null check (status in ('accepted', 'running', 'completed', 'failed')),
  model text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  error_message text
);

comment on table public.agent_runs is
  'Server-only run bookkeeping for LangGraph thread execution.';

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
create index chat_sessions_canvas_id_idx on public.chat_sessions (canvas_id);

create unique index chat_sessions_thread_id_non_null_idx
  on public.chat_sessions (thread_id)
  where thread_id is not null;

create index chat_messages_session_id_idx on public.chat_messages (session_id);

create index agent_runs_session_id_created_at_idx
  on public.agent_runs (session_id, created_at desc);

create index agent_runs_thread_id_created_at_idx
  on public.agent_runs (thread_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. updated_at trigger (`public.set_updated_at` comes from 0003)
-- ---------------------------------------------------------------------------
create trigger chat_sessions_set_updated_at
  before update on public.chat_sessions
  for each row
  execute function public.set_updated_at();
