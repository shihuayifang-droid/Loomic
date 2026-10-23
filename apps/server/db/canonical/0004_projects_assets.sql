-- HaHart migration 0004 (ticket 43P, ADR-0001, OP-04).
--
-- Projects, canvases and asset objects on top of 0003 (workspaces).
-- Ported from the final form of the retired `supabase/migrations` chain
-- (foundation v1 + canvas content + project thumbnail + canvas optimistic version
-- + brand kit column + team workspace pinning + storage cutover bucket list
-- + asset provenance + asset display name + `record_project_asset` final).
-- Differences by design:
--   * every user foreign key points at `hahart_auth.users(id)`;
--   * no row level policies and no role grants: the server is the only client;
--   * `asset_objects.source_job_id` is a plain uuid column here: the foreign key
--     to `background_jobs` is added by the migration that creates that table
--     (0006), together with its index;
--   * `projects.brand_kit_id` is a plain uuid column here: the foreign key to
--     `brand_kits` is added by the migration that creates that table (0011).
--
-- Create-only migration, runs on an empty database after 0001, 0002 and 0003.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  slug text not null check (char_length(btrim(slug)) > 0),
  description text,
  created_by uuid references hahart_auth.users (id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  thumbnail_path text,
  -- No foreign key yet: `brand_kits` is created by a later migration (0011).
  brand_kit_id uuid,
  constraint projects_workspace_slug_key unique (workspace_id, slug),
  -- Target of the composite foreign key from `asset_objects`.
  constraint projects_id_workspace_id_key unique (id, workspace_id)
);

create table public.canvases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  is_primary boolean not null default false,
  created_by uuid references hahart_auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  content jsonb not null default '{}'::jsonb,
  -- Optimistic concurrency counter for canvas saves.
  version integer not null default 0
);

create table public.asset_objects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid,
  bucket text not null,
  object_path text not null check (char_length(btrim(object_path)) > 0),
  mime_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  created_by uuid references hahart_auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  -- Provenance (who or what produced the object).
  source text,
  operation text,
  model_id text,
  prompt text,
  credits_charged integer,
  action_id text,
  -- No foreign key yet: `background_jobs` is created by a later migration (0006).
  source_job_id uuid,
  parent_artifact_id uuid,
  -- The name a person gave the file; the object path stays the storage key.
  display_name text,
  constraint asset_objects_bucket_check
    check (bucket in ('project-assets', 'user-avatars', 'canvases')),
  constraint asset_objects_bucket_object_path_key unique (bucket, object_path),
  -- The project must belong to the same workspace as the asset. `on update
  -- cascade` lets a project move workspace together with its assets.
  constraint asset_objects_project_workspace_fkey
    foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id)
    on update cascade on delete cascade,
  constraint asset_objects_parent_artifact_fkey
    foreign key (parent_artifact_id) references public.asset_objects (id) on delete set null,
  constraint asset_objects_source_check check (
    source is null
    or source in ('agent', 'generator', 'user_upload', 'sketch', 'agent:sandbox')
    or source ~ '^tool:[a-z0-9_]+$'
  ),
  constraint asset_objects_credits_charged_check
    check (credits_charged is null or credits_charged >= 0),
  constraint asset_objects_display_name_check check (
    display_name is null
    or (char_length(btrim(display_name)) >= 1 and char_length(btrim(display_name)) <= 255)
  )
);

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
create index projects_workspace_id_idx on public.projects (workspace_id);
create index projects_created_by_idx on public.projects (created_by);

create index canvases_project_id_idx on public.canvases (project_id);
create unique index canvases_one_primary_per_project_key
  on public.canvases (project_id)
  where is_primary;

create index asset_objects_workspace_id_idx on public.asset_objects (workspace_id);
create index asset_objects_project_id_idx on public.asset_objects (project_id);
create index asset_objects_created_by_idx on public.asset_objects (created_by);

-- ---------------------------------------------------------------------------
-- 3. updated_at triggers (`public.set_updated_at` comes from 0003)
-- ---------------------------------------------------------------------------
create trigger projects_set_updated_at
before update on public.projects
for each row
execute function public.set_updated_at();

create trigger canvases_set_updated_at
before update on public.canvases
for each row
execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Functions
-- ---------------------------------------------------------------------------
-- Resolve the (project, workspace) a piece of content belongs to.
-- A canvas id wins and pins its own project; a project id alone is looked up;
-- neither id yields (null, null), which means "a non-project asset".
create function private.project_content_target(p_project_id uuid, p_canvas_id uuid)
returns table (project_id uuid, workspace_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_workspace uuid;
begin
  if p_canvas_id is not null then
    select c.project_id, p.workspace_id
      into v_project, v_workspace
      from public.canvases c
      join public.projects p on p.id = c.project_id
     where c.id = p_canvas_id;

    if v_project is null then
      raise exception 'content target not found' using errcode = 'P0002';
    end if;

    -- A canvas belongs to exactly one project; a caller that names a different
    -- one is confused or hostile, and either way silently picking a winner here
    -- would put the object under the wrong project's permissions.
    if p_project_id is not null and p_project_id <> v_project then
      raise exception 'canvas and project do not match' using errcode = '22023';
    end if;

    return query select v_project, v_workspace;
    return;
  end if;

  if p_project_id is not null then
    select p.id, p.workspace_id
      into v_project, v_workspace
      from public.projects p
     where p.id = p_project_id;

    if v_project is null then
      raise exception 'content target not found' using errcode = 'P0002';
    end if;

    return query select v_project, v_workspace;
    return;
  end if;

  -- Neither id: an explicitly non-project asset (see p_fallback_workspace_id).
  return query select null::uuid, null::uuid;
end;
$$;

-- Record one stored object, idempotently. Returns {asset_id, workspace_id, project_id}.
create function public.record_project_asset(
  p_bucket text,
  p_object_path text,
  p_created_by uuid,
  p_fallback_workspace_id uuid,
  p_project_id uuid default null,
  p_canvas_id uuid default null,
  p_mime_type text default null,
  p_byte_size bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_project uuid;
  v_target_workspace uuid;
  v_existing public.asset_objects%rowtype;
  v_asset_id uuid;
begin
  if p_bucket is null or btrim(p_bucket) = '' then
    raise exception 'bucket is required' using errcode = '22023';
  end if;

  if p_object_path is null or btrim(p_object_path) = '' then
    raise exception 'object path is required' using errcode = '22023';
  end if;

  if p_created_by is null then
    raise exception 'created_by is required' using errcode = '22023';
  end if;

  select t.project_id, t.workspace_id
    into v_target_project, v_target_workspace
    from private.project_content_target(p_project_id, p_canvas_id) t;

  if v_target_workspace is null then
    -- Non-project asset: the caller must name the workspace explicitly.
    if p_fallback_workspace_id is null then
      raise exception 'fallback workspace is required for a non-project asset'
        using errcode = '22023';
    end if;

    v_target_workspace := p_fallback_workspace_id;
  end if;

  select * into v_existing
    from public.asset_objects
   where bucket = p_bucket and object_path = btrim(p_object_path)
     for update;

  if v_existing.id is null then
    insert into public.asset_objects (
      workspace_id, project_id, bucket, object_path, mime_type, byte_size, created_by
    )
    values (
      v_target_workspace, v_target_project, p_bucket, btrim(p_object_path),
      p_mime_type, p_byte_size, p_created_by
    )
    returning id into v_asset_id;
  else
    -- Already recorded. Re-running the same job must be a no-op, and a *different*
    -- caller must not be able to take the row over or move it to another project.
    if v_existing.project_id is not null
       and v_target_project is not null
       and v_existing.project_id <> v_target_project then
      raise exception 'asset object already belongs to another project'
        using errcode = '23505';
    end if;

    if v_existing.project_id is null
       and v_target_project is null
       and v_existing.workspace_id <> v_target_workspace then
      raise exception 'asset object already belongs to another workspace'
        using errcode = '23505';
    end if;

    v_asset_id := v_existing.id;

    update public.asset_objects
       set -- Fill a missing project, never replace a different one (guarded above).
           project_id = coalesce(v_existing.project_id, v_target_project),
           workspace_id = case
             when v_existing.project_id is null then v_target_workspace
             else v_existing.workspace_id
           end,
           mime_type = coalesce(p_mime_type, mime_type),
           byte_size = coalesce(p_byte_size, byte_size),
           -- Ownership is first-writer-wins: a retry by another actor (an admin
           -- re-running a job, a backfill) must not rewrite who created it.
           created_by = coalesce(created_by, p_created_by)
     where id = v_asset_id;
  end if;

  return jsonb_build_object(
    'asset_id', v_asset_id,
    'workspace_id', (select workspace_id from public.asset_objects where id = v_asset_id),
    'project_id', (select project_id from public.asset_objects where id = v_asset_id)
  );
end;
$$;
