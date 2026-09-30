-- ============================================================================
-- P0-工单5 T0: 审计日志表 + 改角色 + 带审计的管理函数
--   AD-08 §3（成员管理）、AD 通用规则「每次写操作留审计日志」、
--   PJ-07 验收 4（管理员读他人内容留痕）
--
-- 设计要点：变更与审计**写在同一个数据库函数里**（同一事务）。服务端只调函数，
-- 不直接碰 admin_audit_log —— 否则「先改后记」两步不在一个事务里，
-- 第二步失败时第一步已经提交，无法回滚。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 审计日志表
--    只给 service_role；RLS 开着但**不建任何策略**，所以即使有人拿到表权限也读不到。
-- ---------------------------------------------------------------------------
create table if not exists public.admin_audit_log (
  id uuid primary key default extensions.gen_random_uuid(),
  actor_user_id uuid not null references auth.users (id),
  action text not null check (action in (
    'team.member.add',
    'team.member.role',
    'team.member.remove',
    'content.foreign_read'
  )),
  target_user_id uuid references auth.users (id),
  target_project_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

-- 审计基本只按时间倒序读（「最近发生了什么」），加一个索引免得全表扫。
create index if not exists admin_audit_log_created_at_idx
  on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;

revoke all on table public.admin_audit_log from anon, authenticated;
grant all on table public.admin_audit_log to service_role;

-- ---------------------------------------------------------------------------
-- 2. set_team_member_role：只改角色，不写审计（审计在 admin_* 包装里）
-- ---------------------------------------------------------------------------
create or replace function public.set_team_member_role(
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

  -- 角色本来就一样：不改、由调用方决定不写审计
  if v_old = p_role then
    return false;
  end if;

  update public.workspace_members set role = p_role
  where workspace_id = v_id and user_id = p_user_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. private.assert_team_admin：actor 必须是团队 admin/owner，返回团队 id
--    私有辅助函数，只有本迁移里的 security definer 函数会调它，不对外授权。
-- ---------------------------------------------------------------------------
create or replace function private.assert_team_admin(p_actor uuid)
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

revoke all on function private.assert_team_admin(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. 三个带审计的管理包装：变更 + 审计行在同一事务里
--    只有**真的**加入 / 真的变了 / removed = 1 才写审计。
-- ---------------------------------------------------------------------------
create or replace function public.admin_add_team_member(
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

create or replace function public.admin_set_team_member_role(
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

create or replace function public.admin_remove_team_member(
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
-- 5. record_foreign_read：管理员读他人内容留痕
--    三个 id 恰好一个非空；项目 created_by = actor 时返回 false 且不写。
-- ---------------------------------------------------------------------------
create or replace function public.record_foreign_read(
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

  -- 读自己的项目不算「读取他人内容」
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
-- 6. 权限：2 ~ 5 全部只给 service_role
-- ---------------------------------------------------------------------------
revoke all on function public.set_team_member_role(uuid, public.workspace_member_role) from public, anon, authenticated;
revoke all on function public.admin_add_team_member(uuid, uuid, public.workspace_member_role) from public, anon, authenticated;
revoke all on function public.admin_set_team_member_role(uuid, uuid, public.workspace_member_role) from public, anon, authenticated;
revoke all on function public.admin_remove_team_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_foreign_read(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;

grant execute on function public.set_team_member_role(uuid, public.workspace_member_role) to service_role;
grant execute on function public.admin_add_team_member(uuid, uuid, public.workspace_member_role) to service_role;
grant execute on function public.admin_set_team_member_role(uuid, uuid, public.workspace_member_role) to service_role;
grant execute on function public.admin_remove_team_member(uuid, uuid) to service_role;
grant execute on function public.record_foreign_read(uuid, text, uuid, uuid, uuid) to service_role;
