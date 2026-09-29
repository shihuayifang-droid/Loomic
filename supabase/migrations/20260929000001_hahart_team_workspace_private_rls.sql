-- ============================================================================
-- P0-工单3: 团队工作区 + 项目私有权限 RLS
--   AD-08 schema 半边 / PJ-07 / PJ-11 的数据库半边
--
-- 用户决策（2026-09-29「都按建议」）：
--   Q1 积分过渡期仍记在个人工作区（本迁移不动任何积分策略）
--   Q2 管理员对他人项目**只读**（admin/owner 对他人内容没有任何写权限）
--   Q3 新用户不自动入团队（本迁移只建管理函数，不建团队数据）
--
-- 本迁移只做：团队唯一性约束、内容表读写策略、storage 写策略、
--             create_project_with_canvas 判定放宽到成员、三个 service_role 管理函数。
-- 不做：公开项目（PJ-06）、准入状态（AD-00）、审计日志、
--       workspace_settings / brand_kits / workspace_skills / 积分表的任何策略。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 全库最多一个团队工作区
-- ---------------------------------------------------------------------------
create unique index if not exists workspaces_single_team_key
  on public.workspaces (type) where type = 'team';

-- ---------------------------------------------------------------------------
-- 2. 项目级读写判定
--    can_read  = (created_by 是我 且 我是该工作区成员) 或 我是该工作区 admin/owner
--    can_write = created_by 是我 且 我是该工作区成员
--    （admin/owner 不进 can_write —— Q2 只读）
-- ---------------------------------------------------------------------------
create or replace function private.can_read_project(p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.projects p
    where p.id = p_project_id
      and ((p.created_by = (select auth.uid()) and private.is_workspace_member(p.workspace_id))
           or private.is_workspace_admin_or_owner(p.workspace_id)));
$$;

create or replace function private.can_write_project(p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.projects p
    where p.id = p_project_id
      and p.created_by = (select auth.uid())
      and private.is_workspace_member(p.workspace_id));
$$;

revoke all on function private.can_read_project(uuid) from public, anon, authenticated;
revoke all on function private.can_write_project(uuid) from public, anon, authenticated;
grant execute on function private.can_read_project(uuid) to authenticated;
grant execute on function private.can_write_project(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. projects：读 = 自己的 或 admin/owner；写 = 只有 created_by 本人（且是成员）
-- ---------------------------------------------------------------------------
drop policy if exists "projects_select_member" on public.projects;
drop policy if exists "projects_insert_admin" on public.projects;
drop policy if exists "projects_update_admin" on public.projects;
drop policy if exists "projects_delete_admin" on public.projects;

create policy "projects_select_owner_or_admin" on public.projects for select to authenticated
  using ((created_by = (select auth.uid()) and (select private.is_workspace_member(workspace_id)))
         or (select private.is_workspace_admin_or_owner(workspace_id)));

create policy "projects_insert_self" on public.projects for insert to authenticated
  with check ((select private.is_workspace_member(workspace_id))
    and created_by = (select auth.uid()));

create policy "projects_update_owner" on public.projects for update to authenticated
  using (created_by = (select auth.uid()) and (select private.is_workspace_member(workspace_id)))
  with check (created_by = (select auth.uid()) and (select private.is_workspace_member(workspace_id)));

create policy "projects_delete_owner" on public.projects for delete to authenticated
  using (created_by = (select auth.uid()) and (select private.is_workspace_member(workspace_id)));

-- ---------------------------------------------------------------------------
-- 4. canvases：跟随所属项目的可读 / 可写
-- ---------------------------------------------------------------------------
drop policy if exists "canvases_select_member" on public.canvases;
drop policy if exists "canvases_insert_admin" on public.canvases;
drop policy if exists "canvases_update_admin" on public.canvases;
drop policy if exists "canvases_delete_admin" on public.canvases;

create policy "canvases_select_project_reader" on public.canvases for select to authenticated
  using ((select private.can_read_project(project_id)));

create policy "canvases_insert_project_owner" on public.canvases for insert to authenticated
  with check ((select private.can_write_project(project_id))
    and (created_by is null or created_by = (select auth.uid())));

create policy "canvases_update_project_owner" on public.canvases for update to authenticated
  using ((select private.can_write_project(project_id)))
  with check ((select private.can_write_project(project_id)));

create policy "canvases_delete_project_owner" on public.canvases for delete to authenticated
  using ((select private.can_write_project(project_id)));

-- ---------------------------------------------------------------------------
-- 5. asset_objects：有 project_id 时跟随项目；无 project_id 时按 created_by + 成员
--    update / delete 也带项目归属判定，避免存量数据里
--    「created_by 是我、但项目不是我的」那种行被改到。
-- ---------------------------------------------------------------------------
drop policy if exists "asset_objects_select_member" on public.asset_objects;
drop policy if exists "asset_objects_insert_admin" on public.asset_objects;
drop policy if exists "asset_objects_update_admin" on public.asset_objects;
drop policy if exists "asset_objects_delete_admin" on public.asset_objects;

create policy "asset_objects_select_reader" on public.asset_objects for select to authenticated
  using (case when project_id is null
    then (created_by = (select auth.uid()) and (select private.is_workspace_member(workspace_id)))
         or (select private.is_workspace_admin_or_owner(workspace_id))
    else (select private.can_read_project(project_id)) end);

create policy "asset_objects_insert_self" on public.asset_objects for insert to authenticated
  with check ((select private.is_workspace_member(workspace_id))
    and created_by = (select auth.uid())
    and (select private.asset_object_project_matches_workspace(project_id, workspace_id))
    and (project_id is null or (select private.can_write_project(project_id))));

create policy "asset_objects_update_self" on public.asset_objects for update to authenticated
  using (created_by = (select auth.uid())
    and (select private.is_workspace_member(workspace_id))
    and (project_id is null or (select private.can_write_project(project_id))))
  with check (created_by = (select auth.uid())
    and (select private.is_workspace_member(workspace_id))
    and (select private.asset_object_project_matches_workspace(project_id, workspace_id))
    and (project_id is null or (select private.can_write_project(project_id))));

create policy "asset_objects_delete_self" on public.asset_objects for delete to authenticated
  using (created_by = (select auth.uid())
    and (select private.is_workspace_member(workspace_id))
    and (project_id is null or (select private.can_write_project(project_id))));

-- ---------------------------------------------------------------------------
-- 6. chat：会话 / 消息都跟随所属项目的可读 / 可写
-- ---------------------------------------------------------------------------
create or replace function private.canvas_project_id(p_canvas_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select c.project_id from public.canvases c where c.id = p_canvas_id $$;

create or replace function private.session_project_id(p_session_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select c.project_id from public.chat_sessions s
  join public.canvases c on c.id = s.canvas_id
  where s.id = p_session_id $$;

revoke all on function private.canvas_project_id(uuid) from public, anon, authenticated;
revoke all on function private.session_project_id(uuid) from public, anon, authenticated;
grant execute on function private.canvas_project_id(uuid) to authenticated;
grant execute on function private.session_project_id(uuid) to authenticated;

drop policy if exists chat_sessions_select on public.chat_sessions;
drop policy if exists chat_sessions_insert on public.chat_sessions;
drop policy if exists chat_sessions_update on public.chat_sessions;
drop policy if exists chat_sessions_delete on public.chat_sessions;
drop policy if exists chat_messages_select on public.chat_messages;
drop policy if exists chat_messages_insert on public.chat_messages;
drop policy if exists chat_messages_delete on public.chat_messages;

create policy chat_sessions_select on public.chat_sessions for select to authenticated
  using ((select private.can_read_project(private.canvas_project_id(canvas_id))));

create policy chat_sessions_insert on public.chat_sessions for insert to authenticated
  with check ((select private.can_write_project(private.canvas_project_id(canvas_id))));

create policy chat_sessions_update on public.chat_sessions for update to authenticated
  using ((select private.can_write_project(private.canvas_project_id(canvas_id))));

create policy chat_sessions_delete on public.chat_sessions for delete to authenticated
  using ((select private.can_write_project(private.canvas_project_id(canvas_id))));

create policy chat_messages_select on public.chat_messages for select to authenticated
  using ((select private.can_read_project(private.session_project_id(session_id))));

create policy chat_messages_insert on public.chat_messages for insert to authenticated
  with check ((select private.can_write_project(private.session_project_id(session_id))));

create policy chat_messages_delete on public.chat_messages for delete to authenticated
  using ((select private.can_write_project(private.session_project_id(session_id))));

-- ---------------------------------------------------------------------------
-- 7. storage project-assets：写策略按「工作区成员 + 对象 owner」
--    select 策略不动（工单 7 会整体改成服务端签名）。
-- ---------------------------------------------------------------------------
drop policy if exists "project_assets_insert_admin" on storage.objects;
drop policy if exists "project_assets_update_admin" on storage.objects;
drop policy if exists "project_assets_delete_admin" on storage.objects;

create policy "project_assets_insert_member" on storage.objects for insert to authenticated
  with check (bucket_id = 'project-assets'
    and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1]))));

create policy "project_assets_update_owner" on storage.objects for update to authenticated
  using (bucket_id = 'project-assets'
    and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1])))
    and (owner = (select auth.uid())
         or (owner is null and (select private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1]))))))
  with check (bucket_id = 'project-assets'
    and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1]))));

create policy "project_assets_delete_owner" on storage.objects for delete to authenticated
  using (bucket_id = 'project-assets'
    and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1])))
    and (owner = (select auth.uid())
         or (owner is null and (select private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1]))))));

-- ---------------------------------------------------------------------------
-- 8. create_project_with_canvas：判定从「admin/owner」放宽到「成员」
--    签名必须保持 5 参数 —— atomic_rpc_functions.sql 的 revoke / grant 按 5 参数写，
--    签名一变就成了新函数、没有 grant，调用会报 permission denied。
-- ---------------------------------------------------------------------------
create or replace function public.create_project_with_canvas(
  p_workspace_id uuid,
  p_name text,
  p_slug text,
  p_description text default null,
  p_canvas_name text default 'Main Canvas'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_project_id uuid;
  v_canvas_id uuid;
  v_project record;
  v_canvas record;
begin
  v_user_id := (select auth.uid());

  if v_user_id is null then
    raise exception 'Not authenticated'
      using errcode = '42501';
  end if;

  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Not a member of this workspace'
      using errcode = '42501';
  end if;

  insert into public.projects (workspace_id, name, slug, description, created_by)
  values (p_workspace_id, p_name, p_slug, p_description, v_user_id)
  returning id into v_project_id;

  insert into public.canvases (project_id, name, is_primary, created_by)
  values (v_project_id, p_canvas_name, true, v_user_id)
  returning id into v_canvas_id;

  select id, name, slug, description, created_at, updated_at, workspace_id
  into v_project
  from public.projects
  where id = v_project_id;

  select id, name, is_primary
  into v_canvas
  from public.canvases
  where id = v_canvas_id;

  return jsonb_build_object(
    'project', jsonb_build_object(
      'id', v_project.id,
      'name', v_project.name,
      'slug', v_project.slug,
      'description', v_project.description,
      'created_at', v_project.created_at,
      'updated_at', v_project.updated_at,
      'workspace_id', v_project.workspace_id
    ),
    'canvas', jsonb_build_object(
      'id', v_canvas.id,
      'name', v_canvas.name,
      'is_primary', v_canvas.is_primary
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. 团队管理（只给服务端：service_role）
-- ---------------------------------------------------------------------------
create or replace function public.ensure_team_workspace(p_owner_user_id uuid, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select id into v_id from public.workspaces where type = 'team' limit 1;

  if v_id is null then
    insert into public.workspaces (type, name, owner_user_id)
    values ('team', p_name, p_owner_user_id)
    returning id into v_id;
  end if;

  -- 保证 owner 在成员表里是 owner；已存在则不改角色。
  insert into public.workspace_members (workspace_id, user_id, role)
  select v_id, w.owner_user_id, 'owner' from public.workspaces w where w.id = v_id
  on conflict (workspace_id, user_id) do nothing;

  return v_id;
end;
$$;

create or replace function public.add_team_member(p_user_id uuid, p_role public.workspace_member_role)
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

  -- 已是成员则不动角色（不用 on conflict do update，否则会把 admin 降成 member）
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_id, p_user_id, p_role)
  on conflict (workspace_id, user_id) do nothing;

  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

create or replace function public.remove_team_member(p_user_id uuid, p_actor_user_id uuid)
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

  -- 所有权转移：项目、无项目的素材、团队前缀下的存储对象
  update public.projects set created_by = p_actor_user_id
  where workspace_id = v_id and created_by = p_user_id;
  get diagnostics v_p = row_count;

  update public.asset_objects set created_by = p_actor_user_id
  where workspace_id = v_id and project_id is null and created_by = p_user_id;
  get diagnostics v_a = row_count;

  update storage.objects set owner = p_actor_user_id
  where bucket_id = 'project-assets'
    and owner = p_user_id
    and (storage.foldername(name))[1] = v_id::text;
  get diagnostics v_o = row_count;

  delete from public.workspace_members
  where workspace_id = v_id and user_id = p_user_id;
  get diagnostics v_m = row_count;

  return jsonb_build_object('projects', v_p, 'assets', v_a, 'objects', v_o, 'removed', v_m);
end;
$$;

revoke all on function public.ensure_team_workspace(uuid, text) from public, anon, authenticated;
revoke all on function public.add_team_member(uuid, public.workspace_member_role) from public, anon, authenticated;
revoke all on function public.remove_team_member(uuid, uuid) from public, anon, authenticated;

grant execute on function public.ensure_team_workspace(uuid, text) to service_role;
grant execute on function public.add_team_member(uuid, public.workspace_member_role) to service_role;
grant execute on function public.remove_team_member(uuid, uuid) to service_role;
