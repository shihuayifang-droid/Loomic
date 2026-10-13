-- X-52 阶段1C（工单18 T1）：私有 Storage 的**最终目标状态**。
--
-- 这个文件只声明"目标长什么样"，不做任何数据搬迁：
--   1. `asset_objects.bucket` 的 CHECK 放开到 `canvases`（历史遗留截图桶要能被登记）；
--   2. 三个桶的 public 值定死：project-assets=false / canvases=false / home-seeds=true；
--   3. `canvases` 的遗留公开读策略与宽松写策略删除，换成"必须存在精确 asset_objects
--      行、且该行对调用者可见"的 authenticated 读策略。
--
-- 单事务：本文件是**一个语句批次**，PostgreSQL 对多语句批次按单个隐式事务执行 ——
-- 下面任何一步失败（包括开头的 RAISE）都会整批回滚，不会留下"改了一半"的桶状态。
--
-- 明确不做（本单禁止）：
--   * 不连真实库、不迁移任何对象、不读写 `storage.objects` 的数据行；
--   * 不按 name/path/URL 里的 UUID / canvasId / workspaceId 猜项目归属 ——
--     授权的唯一来源是 `public.asset_objects` 自己的 RLS；
--   * 不新增第二套签名服务 / RPC / metadata 表；
--   * 不改 `supabase/config.toml`（它与 migration 历史的 project-assets public 值漂移
--     是已知问题，本单不动；真实预检必须读实际数据库状态）。
--
-- 回滚：`supabase/rollbacks/20261013000002_hahart_storage_private_cutover_rollback.sql`
-- （**故意不放 migrations/**，放进去 fresh install 会自动把刚切好的状态回滚掉）。

-- ---------------------------------------------------------------------------
-- 0. 前置：三个桶必须都存在。少任何一个直接 RAISE。
--    "UPDATE 0 行然后假装成功"会把一次未生效的切换报成成功，这里不允许它发生。
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  select string_agg(want.id, ', ' order by want.id)
    into v_missing
    from (values ('project-assets'), ('canvases'), ('home-seeds')) as want(id)
   where not exists (select 1 from storage.buckets b where b.id = want.id);

  if v_missing is not null then
    raise exception 'X-52 storage cutover aborted: required bucket(s) missing: %', v_missing
      using errcode = '42704';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. asset_objects.bucket CHECK 放开到 canvases。
--    旧约束是 foundation_v1 里的内联列约束（自动名 asset_objects_bucket_check）。
--    这里按"实际存在的、约束 bucket 列的 CHECK"删除，再以**显式名**重建 ——
--    重放不会堆积约束，也不会误删 `asset_objects_bucket_object_path_key`（那是 unique）。
--    CHECK 不触碰数据：存量取值只有 project-assets / user-avatars，都在新集合内。
-- ---------------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
     where n.nspname = 'public'
       and r.relname = 'asset_objects'
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%bucket%'
  loop
    execute format('alter table public.asset_objects drop constraint %I', v_name);
  end loop;
end $$;

alter table public.asset_objects
  add constraint asset_objects_bucket_check
  check (bucket in ('project-assets', 'user-avatars', 'canvases'));

-- ---------------------------------------------------------------------------
-- 2. 目标 public 值。三条各自按 id 定位；第 0 步已保证三条都命中。
-- ---------------------------------------------------------------------------
update storage.buckets set public = false where id = 'project-assets';
update storage.buckets set public = false where id = 'canvases';
update storage.buckets set public = true  where id = 'home-seeds';

-- ---------------------------------------------------------------------------
-- 3. project-assets：保留工单13的 metadata reader 与三条写策略。
--    不复制、不放宽、不新增 public SELECT —— 这一节一行 policy 都不写，只做断言。
--    断言的理由：桶变 private 之后"缺少 reader 策略"= 全部项目素材不可读，
--    这是本迁移能造成的最坏状态，必须响亮地失败，而不是静默落地。
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'project_assets_select_metadata_reader'
       and cmd = 'SELECT'
  ) then
    raise exception 'X-52 storage cutover aborted: project_assets_select_metadata_reader is missing'
      using errcode = '42704';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. canvases：冻结遗留桶。
--    * 删 `canvases_select_public`   —— 当前对 public 全开，是本次私有化的对象；
--    * 删 `canvases_insert_authenticated` —— 冻结客户端写，遗留桶不再接受上传；
--    * 只留一条 authenticated 的 SELECT：唯一授权来源是 `public.asset_objects` 里
--      存在 (bucket='canvases', object_path = 本对象 name) 且**调用者自己看得见**的行。
--      子查询以调用者身份求值，所以 asset_objects 的 RLS（项目作者 / 团队 admin-owner /
--      无项目行按创建者）就是全部判定。
--    * 故意**不加** `owner = auth.uid()` 分支：`storage.objects.owner` 不是归属证明，
--      未登记 metadata 的对象对所有人（含上传者）一律拒绝，不按 path 放行。
--    * 不加 authenticated INSERT/UPDATE/DELETE。
-- ---------------------------------------------------------------------------
drop policy if exists "canvases_select_public" on storage.objects;
drop policy if exists "canvases_insert_authenticated" on storage.objects;
drop policy if exists "canvases_select_metadata_reader" on storage.objects;

create policy "canvases_select_metadata_reader"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'canvases'
    and exists (
      select 1
        from public.asset_objects a
       where a.bucket = storage.objects.bucket_id
         and a.object_path = storage.objects.name
    )
  );

-- ---------------------------------------------------------------------------
-- 5. home-seeds：保持"唯一一条 public SELECT、零客户端写策略"。
--    本迁移不写它的 policy，只断言现状 —— 免得将来有人开了写路径而没人发现。
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'home_seeds_select_public'
       and cmd = 'SELECT'
  ) then
    raise exception 'X-52 storage cutover aborted: home_seeds_select_public is missing'
      using errcode = '42704';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and cmd <> 'SELECT'
       and coalesce(qual, '') || coalesce(with_check, '') like '%home-seeds%'
  ) then
    raise exception 'X-52 storage cutover aborted: home-seeds has a client write policy'
      using errcode = '42704';
  end if;
end $$;
