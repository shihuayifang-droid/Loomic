-- X-52 阶段1C（工单18 T1）：私有 Storage 的**最终目标状态**。
--
-- 这个文件只声明"目标长什么样"，不做任何数据搬迁：
--   1. `asset_objects.bucket` 的 CHECK 放开到 `canvases`（历史遗留截图桶要能被登记）；
--   2. 三个桶的 public 值定死：project-assets=false / canvases=false / home-seeds=true；
--   3. `canvases` 的遗留公开读策略与宽松写策略删除，换成"必须存在精确 asset_objects
--      行、且该行对调用者可见"的 authenticated 读策略。
--
-- 单事务：本文件是**一个语句批次**，PostgreSQL 对多语句批次按单个隐式事务执行 ——
-- 下面任何一步失败（包括开头的 preflight RAISE）都会整批回滚，不会留下"改了一半"的桶状态。
--   发布入口固定为**仓库根**的 `supabase db push`（Supabase migration runner 把**单文件**
--   当一个 migration 执行）；**禁止**在控制台逐条复制本文件的语句执行 —— 逐条执行时每条
--   各自提交，上面的原子性不再成立。
--   本文件故意**不**写显式 `begin/commit`：那会与 runner 自身的事务嵌套。
--   PGlite 测试用 `db.exec(本文件)`（无外层 transaction，与 migration harness 同形）证明
--   失败原子性，并给出"若逐条提交则前部状态会变化"的判别力反例。
--   真实预生产仍必须验证 runner 行为（`supabase_migrations.schema_migrations` 只新增该版本），
--   PGlite 不冒充真实 Supabase。
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
-- 0a. 前置：三个桶必须都存在。少任何一个直接 RAISE。
--     "UPDATE 0 行然后假装成功"会把一次未生效的切换报成成功，这里不允许它发生。
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
-- 0b. Storage policy 漂移门禁（fail-closed），在任何 bucket / CHECK / policy 修改之前。
--
--     为什么必须做：PostgreSQL 同表多个 permissive policy 按 OR 组合。真实库里只要多出
--     一条 `TO public USING (true)`（它的表达式里**没有** bucket 字面量，所以"搜索含 canvases
--     的表达式"这类检查看不见它），下面第 4 步建好的严格 reader 就会被 OR 绕过，
--     私有化在纸面上成功、实际全开。
--
--     判据分两层：
--       1) 名称白名单：`storage.objects` 上只允许仓库 40 条 migration 产生过的下列 16 个名字，
--          任何未知名字（含别名 public / write policy）立即 RAISE；
--       2) 名称对应的形状：cmd、roles、permissive 必须与创建它的 migration 一致，
--          且 qual/with_check 必须出现它所属 bucket 的**精确字面量**，禁止空表达式与
--          `USING(true)` / `WITH CHECK(true)`。
--     canvases 只允许两种合法状态：切换前的两条遗留 policy，或切换后的 metadata reader；
--     混搭 / 缺项 / 多项一律 RAISE。
-- ---------------------------------------------------------------------------
do $$
declare
  v_unknown text;
  v_legacy integer;
  v_target integer;
  e record;
  v_found integer;
  v_cmd text;
  v_roles text[];
  v_permissive text;
  v_qual text;
  v_with_check text;
begin
  select string_agg(p.policyname, ', ' order by p.policyname)
    into v_unknown
    from pg_policies p
   where p.schemaname = 'storage'
     and p.tablename = 'objects'
     and p.policyname not in (
       'brand_kit_assets_insert',
       'brand_kit_assets_select',
       'brand_kit_assets_update',
       'brand_kit_assets_delete',
       'user_avatars_select_owner',
       'user_avatars_insert_owner',
       'user_avatars_update_owner',
       'user_avatars_delete_owner',
       'project_assets_select_metadata_reader',
       'project_assets_insert_member',
       'project_assets_update_owner',
       'project_assets_delete_owner',
       'home_seeds_select_public',
       'canvases_select_public',
       'canvases_insert_authenticated',
       'canvases_select_metadata_reader'
     );

  if v_unknown is not null then
    raise exception 'X-52 storage cutover preflight aborted: unknown policy on storage.objects: %',
      v_unknown using errcode = '42704';
  end if;

  for e in
    select * from (values
      ('brand_kit_assets_insert',                'INSERT', 'authenticated', 'brand-kit-assets', true),
      ('brand_kit_assets_select',                'SELECT', 'authenticated', 'brand-kit-assets', true),
      ('brand_kit_assets_update',                'UPDATE', 'authenticated', 'brand-kit-assets', true),
      ('brand_kit_assets_delete',                'DELETE', 'authenticated', 'brand-kit-assets', true),
      ('user_avatars_select_owner',              'SELECT', 'authenticated', 'user-avatars', true),
      ('user_avatars_insert_owner',              'INSERT', 'authenticated', 'user-avatars', true),
      ('user_avatars_update_owner',              'UPDATE', 'authenticated', 'user-avatars', true),
      ('user_avatars_delete_owner',              'DELETE', 'authenticated', 'user-avatars', true),
      ('project_assets_select_metadata_reader',  'SELECT', 'authenticated', 'project-assets', true),
      ('project_assets_insert_member',           'INSERT', 'authenticated', 'project-assets', true),
      ('project_assets_update_owner',            'UPDATE', 'authenticated', 'project-assets', true),
      ('project_assets_delete_owner',            'DELETE', 'authenticated', 'project-assets', true),
      ('home_seeds_select_public',               'SELECT', 'public',        'home-seeds', true),
      ('canvases_select_public',                 'SELECT', 'public',        'canvases', false),
      ('canvases_insert_authenticated',          'INSERT', 'authenticated', 'canvases', false),
      ('canvases_select_metadata_reader',        'SELECT', 'authenticated', 'canvases', false)
    ) as t(name, cmd, role, bucket, required)
  loop
    select count(*) into v_found
      from pg_policies p
     where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = e.name;

    if v_found = 0 then
      if e.required then
        raise exception 'X-52 storage cutover preflight aborted: required policy % is missing', e.name
          using errcode = '42704';
      end if;
      continue;
    end if;

    if v_found > 1 then
      raise exception 'X-52 storage cutover preflight aborted: policy % appears % times', e.name, v_found
        using errcode = '42704';
    end if;

    select p.cmd, p.roles::text[], p.permissive, coalesce(p.qual, ''), coalesce(p.with_check, '')
      into v_cmd, v_roles, v_permissive, v_qual, v_with_check
      from pg_policies p
     where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = e.name;

    if v_cmd <> e.cmd then
      raise exception 'X-52 storage cutover preflight aborted: policy % has cmd % (expected %)',
        e.name, v_cmd, e.cmd using errcode = '42704';
    end if;

    if v_roles <> array[e.role] then
      raise exception 'X-52 storage cutover preflight aborted: policy % has roles % (expected %)',
        e.name, v_roles, e.role using errcode = '42704';
    end if;

    if v_permissive <> 'PERMISSIVE' then
      raise exception 'X-52 storage cutover preflight aborted: policy % is % (expected PERMISSIVE)',
        e.name, v_permissive using errcode = '42704';
    end if;

    if lower(btrim(v_qual)) = 'true' or lower(btrim(v_with_check)) = 'true' then
      raise exception 'X-52 storage cutover preflight aborted: policy % is unconditionally true', e.name
        using errcode = '42704';
    end if;

    if v_qual = '' and v_with_check = '' then
      raise exception 'X-52 storage cutover preflight aborted: policy % has no expression', e.name
        using errcode = '42704';
    end if;

    if position(e.bucket in v_qual) = 0 and position(e.bucket in v_with_check) = 0 then
      raise exception 'X-52 storage cutover preflight aborted: policy % does not reference bucket %',
        e.name, e.bucket using errcode = '42704';
    end if;
  end loop;

  select count(*) into v_legacy
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects'
     and p.policyname in ('canvases_select_public', 'canvases_insert_authenticated');

  select count(*) into v_target
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects'
     and p.policyname = 'canvases_select_metadata_reader';

  if not ((v_legacy = 2 and v_target = 0) or (v_legacy = 0 and v_target = 1)) then
    raise exception 'X-52 storage cutover preflight aborted: unexpected canvases policy state (legacy=%, metadata_reader=%)',
      v_legacy, v_target using errcode = '42704';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. asset_objects.bucket CHECK 放开到 canvases —— **只动这一个约束**。
--    旧约束是 foundation_v1 里的内联列约束（自动名 asset_objects_bucket_check）。
--    禁止按 `pg_get_constraintdef LIKE '%bucket%'` 批量删除：真实库若有别的 CHECK
--    只是"提及 bucket"（跨列、复合条件），批量删除会静默把它删掉、静默放宽数据约束。
--    这里逐项核实：
--      * 必须存在名为 asset_objects_bucket_check 的 CHECK；
--      * 它的 conkey 必须**只**绑定 asset_objects.bucket 列（smallint 数组精确相等）；
--      * 表上"只绑定 bucket 列"的 CHECK 只能有这一个（重复 = 漂移，RAISE）；
--      * 定义必须落在两种允许形态之一，且字面量集合精确：
--          旧集合 {project-assets, user-avatars}  -> drop/recreate 成新集合；
--          新集合 + canvases                      -> 视为重放，不动；
--        缺失 / 绑定其它列 / 出现意外取值 / 定义形态不是 `bucket = ANY (ARRAY[...])` 一律 RAISE。
--    其它任何 CHECK（含跨列且提及 bucket 的）**一律保留**。
--    CHECK 不触碰数据：存量取值只有 project-assets / user-avatars，都在新集合内。
-- ---------------------------------------------------------------------------
do $$
declare
  c_old constant text[] := array['project-assets', 'user-avatars'];
  c_new constant text[] := array['canvases', 'project-assets', 'user-avatars'];
  v_attnum smallint;
  v_named integer;
  v_bucket_only integer;
  v_key smallint[];
  v_def text;
  v_norm text;
  v_vals text[];
begin
  select a.attnum into v_attnum
    from pg_attribute a
    join pg_class r on r.oid = a.attrelid
    join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'public'
     and r.relname = 'asset_objects'
     and a.attname = 'bucket'
     and a.attnum > 0
     and not a.attisdropped;

  if v_attnum is null then
    raise exception 'X-52 storage cutover aborted: public.asset_objects.bucket column is missing'
      using errcode = '42704';
  end if;

  select count(*) into v_named
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'public'
     and r.relname = 'asset_objects'
     and c.contype = 'c'
     and c.conname = 'asset_objects_bucket_check';

  if v_named = 0 then
    raise exception 'X-52 storage cutover aborted: CHECK asset_objects_bucket_check is missing'
      using errcode = '42704';
  end if;

  select c.conkey, pg_get_constraintdef(c.oid) into v_key, v_def
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'public'
     and r.relname = 'asset_objects'
     and c.contype = 'c'
     and c.conname = 'asset_objects_bucket_check';

  if v_key is distinct from array[v_attnum] then
    raise exception 'X-52 storage cutover aborted: asset_objects_bucket_check is bound to columns % (expected only bucket = %)',
      v_key, v_attnum using errcode = '42704';
  end if;

  select count(*) into v_bucket_only
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'public'
     and r.relname = 'asset_objects'
     and c.contype = 'c'
     and c.conkey = array[v_attnum];

  if v_bucket_only > 1 then
    raise exception 'X-52 storage cutover aborted: % CHECK constraints on asset_objects are bound to the bucket column alone',
      v_bucket_only using errcode = '42704';
  end if;

  v_norm := upper(regexp_replace(v_def, '\s+', ' ', 'g'));
  if v_norm !~ '^CHECK \(\(BUCKET = ANY \(ARRAY\[.*\]\)\)\)( NOT VALID)?$' then
    raise exception 'X-52 storage cutover aborted: unexpected asset_objects_bucket_check definition: %',
      v_def using errcode = '42704';
  end if;

  select array_agg(m[1] order by m[1]) into v_vals
    from regexp_matches(v_def, '''([^'']*)''', 'g') as m;

  if v_vals = c_new then
    -- 重放：已经是目标集合。
    null;
  elsif v_vals = c_old then
    execute 'alter table public.asset_objects drop constraint asset_objects_bucket_check';
    execute 'alter table public.asset_objects add constraint asset_objects_bucket_check '
         || 'check (bucket in (''project-assets'', ''user-avatars'', ''canvases''))';
  else
    raise exception 'X-52 storage cutover aborted: unexpected asset_objects_bucket_check bucket set: %',
      v_def using errcode = '42704';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. 目标 public 值。三条各自按 id 定位；第 0a 步已保证三条都命中。
-- ---------------------------------------------------------------------------
update storage.buckets set public = false where id = 'project-assets';
update storage.buckets set public = false where id = 'canvases';
update storage.buckets set public = true  where id = 'home-seeds';

-- ---------------------------------------------------------------------------
-- 3. project-assets：保留工单13的 metadata reader 与三条写策略。
--    不复制、不放宽、不新增 public SELECT —— 这一节一行 policy 都不写，只做断言。
--    断言的理由：桶变 private 之后"缺少 reader 策略"= 全部项目素材不可读，
--    这是本迁移能造成的最坏状态，必须响亮地失败，而不是静默落地。
--    （第 0b 步已经检查过名字与形状，这里再确认落地后的后置条件。）
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
