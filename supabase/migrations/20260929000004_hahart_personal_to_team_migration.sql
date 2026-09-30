-- ============================================================================
-- P0-工单6 T1: 外键可跟随 + 个人工作区 → 团队工作区 的存量迁移 + 单个素材的留痕
--   AD-08 §1、§4 及验收 2
--
-- 背景（出单前实测）：asset_objects 的外键是 (project_id, workspace_id) →
-- projects (id, workspace_id)，只有 ON DELETE CASCADE，**没有 ON UPDATE CASCADE**。
-- 于是项目下只要有一个素材，就改不动这个项目的 workspace_id：
--   update or delete on table "projects" violates foreign key constraint
--   "asset_objects_project_workspace_fkey" on table "asset_objects"
-- 先改素材也不行 —— 外键指向的 (id, 团队) 还不存在。
--
-- 本迁移把外键**永久**改成 on update cascade（不是「先删后加」），
-- 之后项目一动，它的素材就跟着走。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 让 projects.workspace_id 可以带着素材一起移动
-- ---------------------------------------------------------------------------
alter table public.asset_objects drop constraint asset_objects_project_workspace_fkey;

alter table public.asset_objects add constraint asset_objects_project_workspace_fkey
  foreign key (project_id, workspace_id)
  references public.projects (id, workspace_id)
  on update cascade on delete cascade;

-- ---------------------------------------------------------------------------
-- 2. 存量迁移：只处理「所有者是团队成员」的个人工作区，幂等
--    非成员的项目原地不动，等他们入队后再跑一次即可。
--    不动：存储对象、积分 / 流水 / 每日领取、无项目素材。
-- ---------------------------------------------------------------------------
create or replace function public.migrate_personal_projects_to_team()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid;
  v_backfilled int;
  v_renamed int;
  v_moved int;
  v_assets int;
  v_skipped int;
begin
  select id into v_team from public.workspaces where type = 'team' limit 1;

  if v_team is null then
    raise exception 'team workspace does not exist' using errcode = 'P0002';
  end if;

  -- a. 个人工作区里 created_by 为空的旧项目，归该工作区的所有者
  --    （工单 3 已知坑：旧策略允许 created_by 为 null，改后谁都写不了）
  update public.projects p set created_by = w.owner_user_id
    from public.workspaces w
   where p.workspace_id = w.id
     and w.type = 'personal'
     and p.created_by is null
     and exists (
       select 1 from public.workspace_members m
       where m.workspace_id = v_team and m.user_id = w.owner_user_id
     );
  get diagnostics v_backfilled = row_count;

  -- b. 与团队里已有项目撞 slug 的，追加 id 前 6 位（团队内 (workspace_id, slug) 唯一）
  update public.projects p set slug = p.slug || '-' || left(replace(p.id::text, '-', ''), 6)
    from public.workspaces w
   where p.workspace_id = w.id
     and w.type = 'personal'
     and exists (
       select 1 from public.workspace_members m
       where m.workspace_id = v_team and m.user_id = w.owner_user_id
     )
     and exists (
       select 1 from public.projects t
       where t.workspace_id = v_team and t.slug = p.slug
     );
  get diagnostics v_renamed = row_count;

  -- c. 将要随项目迁移的素材数（带项目的才随外键级联；无项目素材不动）
  select count(*) into v_assets
    from public.asset_objects a
    join public.projects p on p.id = a.project_id
    join public.workspaces w on w.id = p.workspace_id
   where w.type = 'personal'
     and exists (
       select 1 from public.workspace_members m
       where m.workspace_id = v_team and m.user_id = w.owner_user_id
     );

  -- d. 迁移项目本体（画布 / 会话 / 消息随项目；素材随外键级联）
  update public.projects p set workspace_id = v_team
    from public.workspaces w
   where p.workspace_id = w.id
     and w.type = 'personal'
     and exists (
       select 1 from public.workspace_members m
       where m.workspace_id = v_team and m.user_id = w.owner_user_id
     );
  get diagnostics v_moved = row_count;

  -- e. 还剩多少个项目留在个人工作区（含非成员的）
  select count(*) into v_skipped
    from public.projects p
    join public.workspaces w on w.id = p.workspace_id
   where w.type = 'personal';

  return jsonb_build_object(
    'projects_moved', v_moved,
    'assets_moved', v_assets,
    'created_by_backfilled', v_backfilled,
    'slugs_renamed', v_renamed,
    'projects_left_in_personal', v_skipped
  );
end;
$$;

revoke all on function public.migrate_personal_projects_to_team() from public, anon, authenticated;
grant execute on function public.migrate_personal_projects_to_team() to service_role;

-- ---------------------------------------------------------------------------
-- 3. 单个素材的留痕（GET /api/uploads/:assetId/url）
--    素材所有者 = 所属项目的 created_by；没有项目时 = 素材自己的 created_by。
--    素材是按自己的 id 寻址的，无项目素材解析不出项目，所以单独一个函数。
-- ---------------------------------------------------------------------------
create or replace function public.record_foreign_asset_read(p_actor uuid, p_asset_id uuid)
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

revoke all on function public.record_foreign_asset_read(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_foreign_asset_read(uuid, uuid) to service_role;
