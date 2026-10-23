-- Canonical fresh schema, part 2: native PostgreSQL message queue (ticket 43K).
-- Self-contained: needs no extension and no other schema. Semantics follow the
-- classic visibility-timeout queue: a read bumps read_ct and pushes vt into the
-- future; once vt passes, the message is visible again (at-least-once delivery).

create schema if not exists hahart_queue;

create table hahart_queue.messages (
  msg_id bigserial primary key,
  queue_name text not null,
  message jsonb not null,
  read_ct integer not null default 0,
  enqueued_at timestamptz not null default now(),
  vt timestamptz not null default now()
);

create index messages_queue_vt_idx on hahart_queue.messages (queue_name, vt, msg_id);

create table hahart_queue.archive (
  msg_id bigint primary key,
  queue_name text not null,
  message jsonb not null,
  read_ct integer not null,
  enqueued_at timestamptz not null,
  archived_at timestamptz not null default now()
);
