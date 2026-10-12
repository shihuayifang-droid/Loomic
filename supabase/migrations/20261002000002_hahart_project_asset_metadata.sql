-- X-52 prep: project asset metadata.
--
-- WHY THIS EXISTS
-- Private storage means asking "who may read this object?" for every object, and
-- today `asset_objects` cannot answer it for generated media: the image/video
-- executors write `workspace_id` from the job (which, since Q1, is the PERSONAL
-- billing workspace) and never fill `project_id`. A private bucket would make
-- those objects unreadable by the project they were generated for.
--
-- The rule this migration encodes: BILLING stays personal, CONTENT OWNERSHIP is
-- derived from the canvas/project source of truth. Callers never hand over a
-- project's workspace — they hand over a canvas or project id and this code
-- derives the pair, so a forged workspace cannot attach an object to a project
-- it does not belong to.

-- ---------------------------------------------------------------------------
-- 1. private.project_content_target：由 canvas/project 真源推导 (project, workspace)
--    两个 id 都空 = 明确「非项目资产」；返回一行全 NULL 而不是零行，
--    让调用方能区分「没有项目」与「查询没命中」。
-- ---------------------------------------------------------------------------
create or replace function private.project_content_target(
  p_project_id uuid,
  p_canvas_id uuid
)
returns table (project_id uuid, workspace_id uuid)
language plpgsql stable security definer set search_path = '' as $$
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

revoke all on function private.project_content_target(uuid, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. public.record_project_asset：唯一的资产归属写入口，只给 service_role
--    - 项目/工作区由上面的 helper 推导，**不采信调用方给的项目 workspace**；
--    - 非项目资产必须显式给 fallback workspace（当前是个人计费 workspace），
--      不从 object path 猜 —— path 只带工作区、时间、任务，不足以定归属；
--    - 幂等：同 (bucket, object_path) 再记录不新建行，且**不夺走已有 created_by**。
-- ---------------------------------------------------------------------------
create or replace function public.record_project_asset(
  p_bucket text,
  p_object_path text,
  p_created_by uuid,
  p_fallback_workspace_id uuid,
  p_project_id uuid default null,
  p_canvas_id uuid default null,
  p_mime_type text default null,
  p_byte_size bigint default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
   where bucket = p_bucket and object_path = btrim(p_object_path);

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

revoke all on function public.record_project_asset(
  text, text, uuid, uuid, uuid, uuid, text, bigint
) from public, anon, authenticated;

grant execute on function public.record_project_asset(
  text, text, uuid, uuid, uuid, uuid, text, bigint
) to service_role;
