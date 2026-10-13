-- X-52 stage 1A (T-20): make the project-asset backfill compare-and-write atomic.
--
-- WHY THIS EXISTS
-- `hahart-project-asset-backfill.ts --apply` used to read `asset_objects`, plan,
-- and then call `record_project_asset`. Two operators (or one operator and a live
-- worker) could both read the same old row before either wrote, and the later
-- writer would then update from a snapshot it had already lost. A client-side
-- pre-read cannot close that window: the read and the write are separate round
-- trips, and the RPC itself took no lock.
--
-- This migration puts the lock, the comparison and the write inside one function.
-- The caller hands over the FULL metadata snapshot it planned against, including
-- `asset_id`, so deleting a row and rebuilding the same key with identical fields
-- is still a conflict (ABA).
--
-- Business conflicts are RETURN VALUES, not SQL exceptions: a plan that went stale
-- is an expected outcome of a retry, not an error. Illegal arguments, an unknown
-- target and a canvas/project mismatch still raise, exactly as before.

-- ---------------------------------------------------------------------------
-- 1. public.record_project_asset_if_matches：计划快照 → 锁定 / 比较 / 推导 / 写入
--    返回 {"status":"applied","asset_id":...,"workspace_id":...,"project_id":...}
--     或 {"status":"conflict","reason":"row_appeared|row_missing|state_changed|insert_raced"}
-- ---------------------------------------------------------------------------
create or replace function public.record_project_asset_if_matches(
  p_bucket text,
  p_object_path text,
  p_created_by uuid,
  p_fallback_workspace_id uuid,
  p_project_id uuid default null,
  p_canvas_id uuid default null,
  p_mime_type text default null,
  p_byte_size bigint default null,
  p_expected_asset_id uuid default null,
  p_expected_workspace_id uuid default null,
  p_expected_project_id uuid default null,
  p_expected_created_by uuid default null,
  p_expected_mime_type text default null,
  p_expected_byte_size bigint default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_target_project uuid;
  v_target_workspace uuid;
  v_project_workspace uuid;
  v_locked uuid;
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

  -- Lock the canvas the caller named BEFORE anything is derived from it, so its
  -- project association cannot be changed under us between derive and write.
  if p_canvas_id is not null then
    select c.id into v_locked
      from public.canvases c
     where c.id = p_canvas_id
       for share;
  end if;

  -- Same validation and same canvas/project source of truth as record_project_asset
  -- (reused, not copied): an unknown target still raises, a contradiction still
  -- raises, and the caller never gets to name the workspace of a project asset.
  select t.project_id, t.workspace_id
    into v_target_project, v_target_workspace
    from private.project_content_target(p_project_id, p_canvas_id) t;

  -- Lock the project the object is about to hang off, and re-read its workspace
  -- under that lock. A canvas-only caller names no project, so this is the only
  -- place that workspace can be pinned.
  if v_target_project is not null then
    select p.workspace_id into v_project_workspace
      from public.projects p
     where p.id = v_target_project
       for share;

    if v_project_workspace is not null then
      v_target_workspace := v_project_workspace;
    end if;
  end if;

  if v_target_workspace is null then
    -- Non-project asset: the caller must name the workspace explicitly.
    if p_fallback_workspace_id is null then
      raise exception 'fallback workspace is required for a non-project asset'
        using errcode = '22023';
    end if;

    v_target_workspace := p_fallback_workspace_id;
  end if;

  -- The row itself, locked until this call ends: nobody can change it between the
  -- comparison below and the write at the bottom.
  select * into v_existing
    from public.asset_objects
   where bucket = p_bucket and object_path = btrim(p_object_path)
     for update;

  if p_expected_asset_id is null then
    -- The plan was made when no row existed. Anything that exists now is somebody
    -- else's write: a stale plan must never adopt it.
    if v_existing.id is not null then
      return jsonb_build_object('status', 'conflict', 'reason', 'row_appeared');
    end if;

    insert into public.asset_objects (
      workspace_id, project_id, bucket, object_path, mime_type, byte_size, created_by
    )
    values (
      v_target_workspace, v_target_project, p_bucket, btrim(p_object_path),
      p_mime_type, p_byte_size, p_created_by
    )
    on conflict (bucket, object_path) do nothing
    returning id into v_asset_id;

    if v_asset_id is null then
      -- Somebody inserted the same key between the locked read and this insert.
      return jsonb_build_object('status', 'conflict', 'reason', 'insert_raced');
    end if;

    return jsonb_build_object(
      'status', 'applied',
      'asset_id', v_asset_id,
      'workspace_id', v_target_workspace,
      'project_id', v_target_project
    );
  end if;

  if v_existing.id is null then
    -- The planned row is gone. Rebuilding it here would resurrect a row a human
    -- (or a cleanup) deliberately removed, so this is a conflict, not a repair.
    return jsonb_build_object('status', 'conflict', 'reason', 'row_missing');
  end if;

  -- Every compared field, IS NOT DISTINCT FROM: a NULL the plan recorded and a
  -- NULL in the row are the same state, while a value that appeared is not.
  -- `id` is compared too — a rebuilt row has the same fields but a new id.
  if v_existing.id is distinct from p_expected_asset_id
     or v_existing.workspace_id is distinct from p_expected_workspace_id
     or v_existing.project_id is distinct from p_expected_project_id
     or v_existing.created_by is distinct from p_expected_created_by
     or v_existing.mime_type is distinct from p_expected_mime_type
     or v_existing.byte_size is distinct from p_expected_byte_size then
    return jsonb_build_object('status', 'conflict', 'reason', 'state_changed');
  end if;

  -- Snapshot matches: from here on this is record_project_asset's completion
  -- semantics, unchanged — fill a missing project, never replace a different one;
  -- coalesce metadata; ownership stays first-writer-wins.
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
     set project_id = coalesce(v_existing.project_id, v_target_project),
         workspace_id = case
           when v_existing.project_id is null then v_target_workspace
           else v_existing.workspace_id
         end,
         mime_type = coalesce(p_mime_type, mime_type),
         byte_size = coalesce(p_byte_size, byte_size),
         created_by = coalesce(created_by, p_created_by)
   where id = v_asset_id;

  return jsonb_build_object(
    'status', 'applied',
    'asset_id', v_asset_id,
    'workspace_id', (select workspace_id from public.asset_objects where id = v_asset_id),
    'project_id', (select project_id from public.asset_objects where id = v_asset_id)
  );
end;
$$;

revoke all on function public.record_project_asset_if_matches(
  text, text, uuid, uuid, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid, text, bigint
) from public, anon, authenticated;

grant execute on function public.record_project_asset_if_matches(
  text, text, uuid, uuid, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid, text, bigint
) to service_role;

-- ---------------------------------------------------------------------------
-- 2. public.record_project_asset：给普通 writer 的 asset_objects 读取加行锁。
--    这样正常 worker 写入与新回填 RPC 争的是同一把行锁 —— 没有这把锁，
--    「回填先锁行、worker 后写」仍然会让 worker 基于旧快照改行。
--    签名、返回结构、授权与语义全部不变，只多一个 FOR UPDATE。
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

revoke all on function public.record_project_asset(
  text, text, uuid, uuid, uuid, uuid, text, bigint
) from public, anon, authenticated;

grant execute on function public.record_project_asset(
  text, text, uuid, uuid, uuid, uuid, text, bigint
) to service_role;
