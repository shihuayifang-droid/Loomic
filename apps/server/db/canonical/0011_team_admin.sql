-- HaHart migration 0011 (ticket 43W, ADR-0001, OP-04).
--
-- Team member management on top of 0003 (workspaces, workspace_members,
-- admin_audit_log), 0004 (projects, asset_objects, canvases) and 0005
-- (chat_sessions). Ported from the final form of the retired
-- `supabase/migrations` chain (team workspace, member transfer, admin audit and
-- member role, personal-to-team migration).
-- Differences by design:
--   * no row level policies and no role privilege statements: the server is the
--     only client;
--   * `remove_team_member` no longer re-owns rows of the object store: this
--     database has no such schema. Ownership of files is expressed through the
--     `projects` and `asset_objects` transfers that stay in the function;
--   * no table is created here: `admin_audit_log` (with the action whitelist
--     that already lists the team member and foreign read actions) lives in 0003.
--
-- Create-only migration, runs on an empty database after 0001 .. 0010.

-- ---------------------------------------------------------------------------
-- 1. add_team_member: add a member to the single team workspace.
--    An existing member keeps the role (no upsert), so an admin is never
--    demoted by a repeated add. Returns true only when a row was inserted.
-- ---------------------------------------------------------------------------
create function public.add_team_member(p_user_id uuid, p_role public.workspace_member_role)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_n int;
begin
  if p_role = 'owner' then
    raise exception 'role owner is not assignable' using errcode = '22023';
  end if;

  select id into v_id from public.workspaces where type = 'team' limit 1;
  if v_id is null then
    raise exception 'team workspace does not exist' using errcode = 'P0002';
  end if;

  -- Already a member: leave the role alone.
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_id, p_user_id, p_role)
  on conflict (workspace_id, user_id) do nothing;

  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. remove_team_member: ownership of the member's projects and of ALL of the
--    member's assets in the team workspace moves to the acting admin, then the
--    membership row is deleted.
-- ---------------------------------------------------------------------------
create function public.remove_team_member(p_user_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_owner uuid;
  v_p int;
  v_a int;
  v_o int;
  v_m int;
begin
  select id, owner_user_id into v_id, v_owner
  from public.workspaces where type = 'team' limit 1;

  if v_id is null then
    raise exception 'team workspace does not exist' using errcode = 'P0002';
  end if;

  if p_user_id = v_owner then
    raise exception 'cannot remove the team owner' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.workspace_members
    where workspace_id = v_id and user_id = p_actor_user_id and role in ('owner', 'admin')
  ) then
    raise exception 'actor is not a team admin' using errcode = '42501';
  end if;

  -- Ownership transfer: projects.
  update public.projects set created_by = p_actor_user_id
  where workspace_id = v_id and created_by = p_user_id;
  get diagnostics v_p = row_count;

  -- Ownership transfer: assets, with or without a project.
  update public.asset_objects set created_by = p_actor_user_id
  where workspace_id = v_id and created_by = p_user_id;
  get diagnostics v_a = row_count;

  delete from public.workspace_members
  where workspace_id = v_id and user_id = p_user_id;
  get diagnostics v_m = row_count;

  return jsonb_build_object('projects', v_p, 'assets', v_a, 'objects', v_o, 'removed', v_m);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. set_team_member_role: change a role only; the audit row is written by the
--    admin_* wrapper below. Returns false when the role is already the same.
-- ---------------------------------------------------------------------------
create function public.set_team_member_role(
  p_user_id uuid,
  p_role public.workspace_member_role
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_owner uuid;
  v_old public.workspace_member_role;
begin
  if p_role = 'owner' then
    raise exception 'role owner is not assignable' using errcode = '22023';
  end if;

  select id, owner_user_id into v_id, v_owner
  from public.workspaces where type = 'team' limit 1;

  if v_id is null then
    raise exception 'team workspace does not exist' using errcode = 'P0002';
  end if;

  if p_user_id = v_owner then
    raise exception 'cannot change the team owner' using errcode = '22023';
  end if;

  select role into v_old
  from public.workspace_members
  where workspace_id = v_id and user_id = p_user_id;

  if v_old is null then
    raise exception 'user is not a team member' using errcode = 'P0002';
  end if;

  -- Same role already: change nothing, the caller writes no audit row.
  if v_old = p_role then
    return false;
  end if;

  update public.workspace_members set role = p_role
  where workspace_id = v_id and user_id = p_user_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. private.assert_team_admin: the actor must be an admin or owner of the team
--    workspace; returns the team workspace id. Helper for the wrappers below.
-- ---------------------------------------------------------------------------
create function private.assert_team_admin(p_actor uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select id into v_id from public.workspaces where type = 'team' limit 1;

  if v_id is null then
    raise exception 'team workspace does not exist' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.workspace_members
    where workspace_id = v_id and user_id = p_actor and role in ('owner', 'admin')
  ) then
    raise exception 'actor is not a team admin' using errcode = '42501';
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Three wrappers with audit: the change and its audit row share one
--    transaction. An audit row is written only when something really changed.
-- ---------------------------------------------------------------------------
create function public.admin_add_team_member(
  p_actor uuid,
  p_user_id uuid,
  p_role public.workspace_member_role
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_added boolean;
begin
  perform private.assert_team_admin(p_actor);

  v_added := public.add_team_member(p_user_id, p_role);

  if v_added then
    insert into public.admin_audit_log (actor_user_id, action, target_user_id, detail)
    values (p_actor, 'team.member.add', p_user_id, jsonb_build_object('role', p_role));
  end if;

  return v_added;
end;
$$;

create function public.admin_set_team_member_role(
  p_actor uuid,
  p_user_id uuid,
  p_role public.workspace_member_role
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid;
  v_before public.workspace_member_role;
  v_changed boolean;
begin
  v_team := private.assert_team_admin(p_actor);

  if p_actor = p_user_id then
    raise exception 'cannot change your own role' using errcode = '22023';
  end if;

  select role into v_before
  from public.workspace_members
  where workspace_id = v_team and user_id = p_user_id;

  v_changed := public.set_team_member_role(p_user_id, p_role);

  if v_changed then
    insert into public.admin_audit_log (actor_user_id, action, target_user_id, detail)
    values (p_actor, 'team.member.role', p_user_id,
      jsonb_build_object('before', v_before, 'after', p_role));
  end if;

  return v_changed;
end;
$$;

create function public.admin_remove_team_member(
  p_actor uuid,
  p_user_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_r jsonb;
begin
  perform private.assert_team_admin(p_actor);

  if p_actor = p_user_id then
    raise exception 'cannot remove yourself' using errcode = '22023';
  end if;

  v_r := public.remove_team_member(p_user_id, p_actor);

  if (v_r ->> 'removed')::int = 1 then
    insert into public.admin_audit_log (actor_user_id, action, target_user_id, detail)
    values (p_actor, 'team.member.remove', p_user_id, v_r);
  end if;

  return v_r;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. record_foreign_read: an admin read someone else's content. Exactly one of
--    the three ids is set; reading your own project returns false, no row.
-- ---------------------------------------------------------------------------
create function public.record_foreign_read(
  p_actor uuid,
  p_via text,
  p_project_id uuid default null,
  p_canvas_id uuid default null,
  p_session_id uuid default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_project uuid;
  v_owner uuid;
begin
  if num_nonnulls(p_project_id, p_canvas_id, p_session_id) <> 1 then
    raise exception 'exactly one of project, canvas, session is required' using errcode = '22023';
  end if;

  v_project := coalesce(
    p_project_id,
    (select c.project_id from public.canvases c where c.id = p_canvas_id),
    (select c.project_id from public.chat_sessions s
       join public.canvases c on c.id = s.canvas_id
      where s.id = p_session_id)
  );

  select created_by into v_owner from public.projects where id = v_project;

  if v_project is null or not found then
    raise exception 'project not found' using errcode = 'P0002';
  end if;

  -- Reading your own project is not a foreign read.
  if v_owner = p_actor then
    return false;
  end if;

  insert into public.admin_audit_log (
    actor_user_id, action, target_user_id, target_project_id, detail
  ) values (
    p_actor, 'content.foreign_read', v_owner, v_project, jsonb_build_object('via', p_via)
  );

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. record_foreign_asset_read: the same trail for one asset, addressed by its
--    own id. The owner is the project creator, or the asset creator when the
--    asset has no project.
-- ---------------------------------------------------------------------------
create function public.record_foreign_asset_read(p_actor uuid, p_asset_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_project uuid;
  v_owner uuid;
  v_found boolean;
begin
  select a.project_id, coalesce(p.created_by, a.created_by), true
    into v_project, v_owner, v_found
    from public.asset_objects a
    left join public.projects p on p.id = a.project_id
   where a.id = p_asset_id;

  if v_found is null then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  if v_owner = p_actor then
    return false;
  end if;

  insert into public.admin_audit_log (
    actor_user_id, action, target_user_id, target_project_id, detail
  ) values (
    p_actor, 'content.foreign_read', v_owner, v_project,
    jsonb_build_object('via', 'asset', 'asset_id', p_asset_id)
  );

  return true;
end;
$$;
