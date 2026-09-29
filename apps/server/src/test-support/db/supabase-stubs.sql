-- Supabase platform pieces that PGlite does not ship.
-- Runs BEFORE supabase/migrations/*.sql (see pglite-db.ts).
-- Default privileges must be set here: migrations create tables, and default
-- privileges only apply to objects created afterwards.
-- ASCII only.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema extensions;
create schema auth;
create schema storage;
create schema pgmq;

grant usage on schema public, extensions, auth, storage
  to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create function extensions.gen_random_uuid() returns uuid language sql
  as 'select pg_catalog.gen_random_uuid()';

create function extensions.moddatetime() returns trigger language plpgsql as $$
begin
  NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], now()));
  return NEW;
end $$;

create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create function auth.role() returns text language sql stable
  as $$ select current_user::text $$;

grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key,
  name text,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;

grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)] $$;

grant execute on function storage.foldername(text) to anon, authenticated, service_role;

create function pgmq.create(queue_name text) returns void language sql as $$ select $$;
