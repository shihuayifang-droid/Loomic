-- HaHart migration 0003 (ticket 43O, ADR-0001, OP-04).
--
-- Identity and workspace tables on top of 0001 (`hahart_auth.users`).
-- Ported from the final form of the retired `supabase/migrations` chain
-- (foundation v1 + hardening + atomic rpc + workspace_settings + team workspace
-- + admin audit log + the later audit action list). Differences by design:
--   * every user foreign key points at `hahart_auth.users(id)`;
--   * no row level policies and no role grants: the repositories inline their
--     own permission checks, and the server is the only database client;
--   * no sign-up trigger: the server calls `public.bootstrap_viewer` explicitly
--     once a user row exists;
--   * `profiles.email` is not locked: `hahart_auth.users` is the source of truth.
--
-- Create-only migration, runs on an empty database after 0001 and 0002.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
create type public.workspace_type as enum ('personal', 'team');
create type public.workspace_member_role as enum ('owner', 'admin', 'member');

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

create function private.try_parse_uuid(p_value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;

  return p_value::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references hahart_auth.users (id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  type public.workspace_type not null,
  name text not null check (char_length(btrim(name)) > 0),
  owner_user_id uuid not null references hahart_auth.users (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references hahart_auth.users (id) on delete cascade,
  role public.workspace_member_role not null default 'member',
  created_at timestamptz not null default timezone('utc', now()),
  primary key (workspace_id, user_id)
);

create table public.workspace_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  default_model text not null default 'gpt-5.4-mini',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.workspace_settings is 'Per-workspace configuration for agent defaults.';
comment on column public.workspace_settings.default_model is 'Default LLM model identifier for agent runs.';

create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references hahart_auth.users (id),
  action text not null,
  target_user_id uuid references hahart_auth.users (id),
  target_project_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint admin_audit_log_action_check check (action in (
    'team.member.add',
    'team.member.role',
    'team.member.remove',
    'content.foreign_read',
    'credits.adjust_topup',
    'credits.set_cap',
    'credits.apply_template',
    'credits.set_pool_limit',
    'member.generation_pause',
    'member.generation_resume'
  ))
);

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------
create index profiles_email_idx on public.profiles (email);
create index workspaces_owner_user_id_idx on public.workspaces (owner_user_id);
create unique index workspaces_personal_owner_user_id_key
  on public.workspaces (owner_user_id)
  where type = 'personal';
-- At most one team workspace in the whole database.
create unique index workspaces_single_team_key
  on public.workspaces (type)
  where type = 'team';
create index workspace_members_user_id_idx on public.workspace_members (user_id);
create index admin_audit_log_created_at_idx
  on public.admin_audit_log (created_at desc);

-- ---------------------------------------------------------------------------
-- 5. updated_at triggers
-- ---------------------------------------------------------------------------
create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create trigger workspaces_set_updated_at
before update on public.workspaces
for each row
execute function public.set_updated_at();

create trigger workspace_settings_updated_at
before update on public.workspace_settings
for each row
execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Functions
-- ---------------------------------------------------------------------------
create function private.bootstrap_user_foundation(
  p_user_id uuid,
  p_email text,
  p_user_meta jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_display_name text;
  v_workspace_name text;
begin
  v_display_name := nullif(
    btrim(
      coalesce(
        p_user_meta ->> 'display_name',
        p_user_meta ->> 'full_name',
        p_user_meta ->> 'name',
        split_part(coalesce(p_email, ''), '@', 1)
      )
    ),
    ''
  );

  insert into public.profiles as p (id, email, display_name, avatar_url)
  values (
    p_user_id,
    p_email,
    v_display_name,
    nullif(btrim(coalesce(p_user_meta ->> 'avatar_url', '')), '')
  )
  on conflict (id) do update
    set email = coalesce(excluded.email, p.email),
        display_name = coalesce(p.display_name, excluded.display_name),
        avatar_url = coalesce(p.avatar_url, excluded.avatar_url),
        updated_at = timezone('utc', now());

  select w.id
  into v_workspace_id
  from public.workspaces w
  where w.owner_user_id = p_user_id
    and w.type = 'personal'
  order by w.created_at
  limit 1;

  if v_workspace_id is null then
    v_workspace_name := coalesce(v_display_name, 'Personal') || ' Workspace';

    begin
      insert into public.workspaces (type, name, owner_user_id)
      values ('personal', v_workspace_name, p_user_id)
      returning id into v_workspace_id;
    exception
      when unique_violation then
        select w.id
        into v_workspace_id
        from public.workspaces w
        where w.owner_user_id = p_user_id
          and w.type = 'personal'
        order by w.created_at
        limit 1;
    end;
  end if;

  if v_workspace_id is null then
    raise exception 'bootstrap_user_foundation could not resolve personal workspace for user %', p_user_id;
  end if;

  insert into public.workspace_members as wm (workspace_id, user_id, role)
  values (v_workspace_id, p_user_id, 'owner')
  on conflict (workspace_id, user_id) do update
    set role = 'owner';

  return v_workspace_id;
end;
$$;

create function public.bootstrap_viewer(
  p_user_id uuid,
  p_email text,
  p_user_meta jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.bootstrap_user_foundation(p_user_id, p_email, p_user_meta);
end;
$$;

create function public.ensure_team_workspace(p_owner_user_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.workspaces where type = 'team' limit 1;

  if v_id is null then
    insert into public.workspaces (type, name, owner_user_id)
    values ('team', p_name, p_owner_user_id)
    returning id into v_id;
  end if;

  -- The owner is always an owner member; an existing row is left untouched.
  insert into public.workspace_members (workspace_id, user_id, role)
  select v_id, w.owner_user_id, 'owner' from public.workspaces w where w.id = v_id
  on conflict (workspace_id, user_id) do nothing;

  return v_id;
end;
$$;
