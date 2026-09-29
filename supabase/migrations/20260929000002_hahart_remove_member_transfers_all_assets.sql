-- ============================================================================
-- P0-工单4 T0: remove_team_member 转移**全部**素材（补工单 3 的遗留缺口）
--
-- 工单 3 的 remove_team_member 只转移 `asset_objects where project_id is null`，
-- 于是挂在「被移出者项目」下的素材行 created_by 仍指向被移出者：
--   ① 被移出者已不是成员 → 写不了；
--   ② 接手了项目的新所有者虽然 can_write_project 为真，但策略还要求
--      created_by = auth.uid()，同样写不了。
-- 结果这些行变成谁都写不了的孤儿（工单 3 检查实测 affectedRows = 0）。
--
-- 本迁移唯一改动：去掉 `project_id is null` 条件 —— 团队工作区内该成员名下的
-- 全部素材都转给 actor。签名 / 返回结构 / 报错文案 / 权限一律不变。
-- ============================================================================

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

  -- 所有权转移：项目
  update public.projects set created_by = p_actor_user_id
  where workspace_id = v_id and created_by = p_user_id;
  get diagnostics v_p = row_count;

  -- 所有权转移：素材 —— 去掉 project_id is null，项目内与无项目的都转
  update public.asset_objects set created_by = p_actor_user_id
  where workspace_id = v_id and created_by = p_user_id;
  get diagnostics v_a = row_count;

  -- 所有权转移：团队前缀下的存储对象
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

-- 重新写一遍 revoke / grant，防止 create or replace 之外的意外。
-- create_project_with_canvas 之外只有本函数被替换，另外两个管理函数本迁移未碰，
-- 其授权不可能漂移，故这里只重写本函数的一对。
revoke all on function public.remove_team_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_team_member(uuid, uuid) to service_role;
