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
--     判据分三层：
--       1) 名称白名单：`storage.objects` 上只允许仓库 migration 产生过的下列 16 个名字，
--          任何未知名字（含别名 public / write policy）立即 RAISE；
--       2) 形状：cmd、roles、permissive 必须与创建它的 migration 一致；
--       3) **表达式等价（fixup2 E1）**：qual 与 with_check 必须与"把仓库里创建它的那条
--          create policy 原样重放一遍"得到的表达式**逐字相同** —— 不是子串、不是前缀、
--          不是"含某个 bucket 字面量"，而是 `pg_get_expr` 归一化后的完整文本相等，
--          NULL（该命令没有这一侧表达式）也必须精确落在同一侧。
--
--     为什么必须到表达式级：PostgreSQL 同表多条 permissive policy 按 OR 组合，所以
--       * `bucket_id='project-assets'` 单独一条（删掉授权子句）仍然"包含 bucket 字面量"；
--       * `bucket_id='project-assets' OR auth.uid() IS NOT NULL` 同样包含它；
--       * `canvases-archive` 这类**后缀子串**会让 `position('canvases' in ...) > 0` 假命中。
--     已知名字 + 子串检查挡不住上面三种，只有完整表达式相等才挡得住。
--
--     实现方式（不追加 position/LIKE 子串）：先把归一化后的**期望表达式**声明为常量，
--     再用 `pg_get_expr` 取实际表达式；实际的取值用**只读探测**产生 —— 在同一个
--     `storage.objects` 上按仓库原文建一个临时探针 policy（名字 zz_wo18_probe_*，
--     一定不在白名单里），取其 `pg_get_expr`（与解引用、别名、类型 cast 的渲染完全同源），
--     然后**无条件 drop**。探针在同一个 DO 块内创建并删除，块结束时不存在任何残留。
--     之所以不写死字面量文本：`pg_get_expr` 会把 `(select auth.uid())` 渲染成
--     `( SELECT auth.uid() AS uid)`、把 `public.asset_objects` 渲染成 `asset_objects`
--     —— 手抄这些文本等于把实现绑在 deparser 的排版细节上；重放原文则永远与仓库同步。
--
--     canvases 只允许两种合法状态：切换前的两条遗留 policy，或切换后的 metadata reader；
--     混搭 / 缺项 / 多项一律 RAISE。两种状态下被检查的集合不同（遗留态不检查尚未存在的
--     reader，目标态不检查已被删除的两条），期望值由探针实时产生后再合并。
-- ---------------------------------------------------------------------------
-- Two composite types rather than `text[][]`: a 2-D array row slice (`arr[i]`) loses its bounds
-- in PL/pgSQL and reads back NULL, and `record[]` is a pseudo-type that cannot be declared.
-- Both types are created and dropped inside this migration, which is a single transaction, so
-- neither survives a successful run nor a rolled-back one.
drop type if exists zz_wo18_expect;
drop type if exists zz_wo18_policy;
create type zz_wo18_policy
  as (p_name text, p_tail text, p_bucket text, p_cmd text);
create type zz_wo18_expect
  as (p_name text, p_bucket text, p_cmd text, p_expect_qual text, p_expect_wc text);

do $$
declare
  -- (1) Every allowed policy: its name, the repository `create policy` tail, the bucket it
  --     belongs to, and the command it is created FOR.
  c_reference constant zz_wo18_policy[] := array[
    row(
      'brand_kit_assets_insert',
      ' for insert to authenticated with check (bucket_id = ''brand-kit-assets'' and (storage.foldername(name))[1] = auth.uid()::text)',
      'brand-kit-assets',
      'INSERT'
    )::zz_wo18_policy,
    row(
      'brand_kit_assets_select',
      ' for select to authenticated using (bucket_id = ''brand-kit-assets'' and (storage.foldername(name))[1] = auth.uid()::text)',
      'brand-kit-assets',
      'SELECT'
    )::zz_wo18_policy,
    row(
      'brand_kit_assets_update',
      ' for update to authenticated using (bucket_id = ''brand-kit-assets'' and (storage.foldername(name))[1] = auth.uid()::text) with check (bucket_id = ''brand-kit-assets'' and (storage.foldername(name))[1] = auth.uid()::text)',
      'brand-kit-assets',
      'UPDATE'
    )::zz_wo18_policy,
    row(
      'brand_kit_assets_delete',
      ' for delete to authenticated using (bucket_id = ''brand-kit-assets'' and (storage.foldername(name))[1] = auth.uid()::text)',
      'brand-kit-assets',
      'DELETE'
    )::zz_wo18_policy,
    row(
      'user_avatars_select_owner',
      ' for select to authenticated using (bucket_id = ''user-avatars'' and private.try_parse_uuid((storage.foldername(name))[1]) = (select auth.uid()))',
      'user-avatars',
      'SELECT'
    )::zz_wo18_policy,
    row(
      'user_avatars_insert_owner',
      ' for insert to authenticated with check (bucket_id = ''user-avatars'' and private.try_parse_uuid((storage.foldername(name))[1]) = (select auth.uid()))',
      'user-avatars',
      'INSERT'
    )::zz_wo18_policy,
    row(
      'user_avatars_update_owner',
      ' for update to authenticated using (bucket_id = ''user-avatars'' and private.try_parse_uuid((storage.foldername(name))[1]) = (select auth.uid())) with check (bucket_id = ''user-avatars'' and private.try_parse_uuid((storage.foldername(name))[1]) = (select auth.uid()))',
      'user-avatars',
      'UPDATE'
    )::zz_wo18_policy,
    row(
      'user_avatars_delete_owner',
      ' for delete to authenticated using (bucket_id = ''user-avatars'' and private.try_parse_uuid((storage.foldername(name))[1]) = (select auth.uid()))',
      'user-avatars',
      'DELETE'
    )::zz_wo18_policy,
    row(
      'project_assets_select_metadata_reader',
      ' for select to authenticated using (bucket_id = ''project-assets'' and (owner = (select auth.uid()) or exists (select 1 from public.asset_objects a where a.bucket = storage.objects.bucket_id and a.object_path = storage.objects.name) or (owner is null and (select private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1]))))))',
      'project-assets',
      'SELECT'
    )::zz_wo18_policy,
    row(
      'project_assets_insert_member',
      ' for insert to authenticated with check (bucket_id = ''project-assets'' and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1]))))',
      'project-assets',
      'INSERT'
    )::zz_wo18_policy,
    row(
      'project_assets_update_owner',
      ' for update to authenticated using (bucket_id = ''project-assets'' and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1]))) and (owner = (select auth.uid()) or (owner is null and (select private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1])))))) with check (bucket_id = ''project-assets'' and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1]))))',
      'project-assets',
      'UPDATE'
    )::zz_wo18_policy,
    row(
      'project_assets_delete_owner',
      ' for delete to authenticated using (bucket_id = ''project-assets'' and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1]))) and (owner = (select auth.uid()) or (owner is null and (select private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1]))))))',
      'project-assets',
      'DELETE'
    )::zz_wo18_policy,
    row(
      'home_seeds_select_public',
      ' for select to public using (bucket_id = ''home-seeds'')',
      'home-seeds',
      'SELECT'
    )::zz_wo18_policy,
    row(
      'canvases_select_public',
      ' for select to public using (bucket_id = ''canvases'')',
      'canvases',
      'SELECT'
    )::zz_wo18_policy,
    row(
      'canvases_insert_authenticated',
      ' for insert to authenticated with check (bucket_id = ''canvases'')',
      'canvases',
      'INSERT'
    )::zz_wo18_policy
  ];

  -- The canvases metadata reader is the step-4 product, so it is probed separately (it only
  -- exists in the target state) rather than listed above.
  c_canvases_tail constant text :=
       ' for select to authenticated using (bucket_id = ''canvases'' and exists (select 1 from '
    || ' public.asset_objects a where a.bucket = storage.objects.bucket_id '
    || 'and a.object_path = storage.objects.name))';
  c_legacy_names constant text[] :=
    array['canvases_select_public', 'canvases_insert_authenticated'];
  c_target_name constant text := 'canvases_select_metadata_reader';

  v_unknown text;
  v_legacy integer;
  v_target integer;
  v_mode text;
  v_probe zz_wo18_policy;
  v_probe_name text;
  v_expect zz_wo18_expect[] := array[]::zz_wo18_expect[];
  i integer;
  r zz_wo18_expect;
  v_found integer;
  v_cmd text;
  v_roles text[];
  v_permissive boolean;
  v_qual text;
  v_wc text;
  v_pqual text;
  v_pwc text;
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

  -- canvases must be exactly one of the two allowed states, never a mixture of them.
  select count(*) into v_legacy
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects'
     and p.policyname = any (c_legacy_names);

  select count(*) into v_target
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = c_target_name;

  if v_legacy = 2 and v_target = 0 then
    v_mode := 'legacy';
  elsif v_legacy = 0 and v_target = 1 then
    v_mode := 'target';
  else
    raise exception 'X-52 storage cutover preflight aborted: unexpected canvases policy state (legacy=%, metadata_reader=%)',
      v_legacy, v_target using errcode = '42704';
  end if;

  -- Build the expected side by REPLAYING the repository DDL as a throwaway probe policy on
  -- the very same table, so the deparser renders it exactly as it rendered the real one. The
  -- probe carries a zz_wo18_probe_ prefix so it can never collide with a real policy, and it
  -- is dropped again inside this block: nothing survives it, whether the block succeeds or
  -- raises (a raise rolls the whole batch back).
  for i in 1 .. array_length(c_reference, 1) loop
    v_probe := c_reference[i];
    v_probe_name := 'zz_wo18_probe_' || v_probe.p_name;

    execute 'create policy "' || v_probe_name || '" on storage.objects' || v_probe.p_tail;
    select pg_get_expr(pp.polqual, pp.polrelid), pg_get_expr(pp.polwithcheck, pp.polrelid)
      into v_pqual, v_pwc
      from pg_policy pp
     where pp.polname = v_probe_name
       and pp.polrelid = 'storage.objects'::regclass;
    execute 'drop policy "' || v_probe_name || '" on storage.objects';

    if v_pqual is null and v_pwc is null then
      raise exception 'X-52 storage cutover preflight aborted: repository reference for policy % produced no expression',
        v_probe.p_name using errcode = '42704';
    end if;

    -- The legacy canvases pair is only a legal state while the bucket is still legacy; in the
    -- target state those two names must be absent, and their absence is asserted by the
    -- `canvases` state check above plus the step-4 drops below.
    if v_mode = 'target' and v_probe.p_name = any (c_legacy_names) then
      continue;
    end if;

    v_expect := v_expect
      || array[row(v_probe.p_name, v_probe.p_bucket, v_probe.p_cmd, v_pqual, v_pwc)::zz_wo18_expect];
  end loop;

  if v_mode = 'target' then
    v_probe_name := 'zz_wo18_probe_' || c_target_name;
    execute 'create policy "' || v_probe_name || '" on storage.objects' || c_canvases_tail;
    select pg_get_expr(pp.polqual, pp.polrelid), pg_get_expr(pp.polwithcheck, pp.polrelid)
      into v_pqual, v_pwc
      from pg_policy pp
     where pp.polname = v_probe_name
       and pp.polrelid = 'storage.objects'::regclass;
    execute 'drop policy "' || v_probe_name || '" on storage.objects';

    if v_pqual is null then
      raise exception 'X-52 storage cutover preflight aborted: repository reference for policy % produced no expression',
        c_target_name using errcode = '42704';
    end if;

    v_expect := v_expect
      || array[row(c_target_name, 'canvases', 'SELECT', v_pqual, v_pwc)::zz_wo18_expect];
  end if;

  for r in
    select * from unnest(v_expect) as t order by t.p_name
  loop
    select count(*) into v_found
      from pg_policies p
     where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = r.p_name;

    if v_found = 0 then
      raise exception 'X-52 storage cutover preflight aborted: required policy % is missing', r.p_name
        using errcode = '42704';
    end if;

    if v_found > 1 then
      raise exception 'X-52 storage cutover preflight aborted: policy % appears % times', r.p_name, v_found
        using errcode = '42704';
    end if;

    select case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
                         when 'd' then 'DELETE' else '*' end,
           array(select case when u = 0 then 'public' else u::regrole::text end
                   from unnest(p.polroles) as u),
           p.polpermissive,
           pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)
      into v_cmd, v_roles, v_permissive, v_qual, v_wc
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'storage' and c.relname = 'objects' and p.polname = r.p_name;

    if v_cmd <> r.p_cmd then
      raise exception 'X-52 storage cutover preflight aborted: policy % has cmd % (expected %)',
        r.p_name, v_cmd, r.p_cmd using errcode = '42704';
    end if;

    if r.p_name in ('home_seeds_select_public', 'canvases_select_public') then
      if not ('public' = any (v_roles)) or array_length(v_roles, 1) <> 1 then
        raise exception 'X-52 storage cutover preflight aborted: policy % has roles % (expected {public})',
          r.p_name, v_roles using errcode = '42704';
      end if;
    else
      if not ('authenticated' = any (v_roles)) or array_length(v_roles, 1) <> 1 then
        raise exception 'X-52 storage cutover preflight aborted: policy % has roles % (expected {authenticated})',
          r.p_name, v_roles using errcode = '42704';
      end if;
    end if;

    if v_permissive is distinct from true then
      raise exception 'X-52 storage cutover preflight aborted: policy % is RESTRICTIVE (expected PERMISSIVE)',
        r.p_name using errcode = '42704';
    end if;

    if (v_qual is null) <> (r.p_expect_qual is null) then
      raise exception 'X-52 storage cutover preflight aborted: policy % USING side presence drifted from the repository definition (actual null=%, expected null=%)',
        r.p_name, v_qual is null, r.p_expect_qual is null using errcode = '42704';
    end if;

    if (v_wc is null) <> (r.p_expect_wc is null) then
      raise exception 'X-52 storage cutover preflight aborted: policy % WITH CHECK side presence drifted from the repository definition (actual null=%, expected null=%)',
        r.p_name, v_wc is null, r.p_expect_wc is null using errcode = '42704';
    end if;

    if v_qual is distinct from r.p_expect_qual then
      raise exception 'X-52 storage cutover preflight aborted: policy % USING expression drifted from the repository definition. actual=[%] expected=[%]',
        r.p_name, v_qual, r.p_expect_qual using errcode = '42704';
    end if;

    if v_wc is distinct from r.p_expect_wc then
      raise exception 'X-52 storage cutover preflight aborted: policy % WITH CHECK expression drifted from the repository definition. actual=[%] expected=[%]',
        r.p_name, v_wc, r.p_expect_wc using errcode = '42704';
    end if;
  end loop;
end $$;

drop type zz_wo18_policy;
drop type zz_wo18_expect;

-- 1. asset_objects.bucket CHECK 放开到 canvases —— **只动这一个约束**。
--    旧约束是 foundation_v1 里的内联列约束（自动名 asset_objects_bucket_check）。
--    禁止按 `pg_get_constraintdef LIKE '%bucket%'` 批量删除：真实库若有别的 CHECK
--    只是"提及 bucket"（跨列、复合条件），批量删除会静默把它删掉、静默放宽数据约束。
--    这里逐项核实：
--      * 必须存在名为 asset_objects_bucket_check 的 CHECK；
--      * 它的 conkey 必须**只**绑定 asset_objects.bucket 列（smallint 数组精确相等）；
--      * 表上"只绑定 bucket 列"的 CHECK 只能有这一个（重复 = 漂移，RAISE）；
--      * 定义必须**逐字等于**两种允许形态之一，且必须 `convalidated = true`：
--          旧集合 {project-assets, user-avatars}  -> drop/recreate 成新集合；
--          新集合 + canvases                      -> 视为重放，不动（也已 validated）；
--        缺失 / 绑定其它列 / `NOT VALID` / 定义不是精确静态三值或两值一律 RAISE。
--        fixup2 E2：不再用"抽出 ARRAY 里的字符串字面量再比集合"的写法 ——
--        `ARRAY['canvases','project-assets','user-avatars',bucket]` 会抽出三个正确
--        字面量却让**任意值**通过；`NOT VALID` 也不是门禁（PostgreSQL 跳过存量行）。
--        旧态同样必须以真实 baseline 为准（真实 baseline 是 validated 的）。
--    其它任何 CHECK（含跨列且提及 bucket 的）**一律保留**。
--    CHECK 不触碰数据：存量取值只有 project-assets / user-avatars，都在新集合内。
-- ---------------------------------------------------------------------------
do $$
declare
  -- The two allowed definitions, written out in FULL and compared character for character
  -- (after the same whitespace flattening the actual definition gets below). These are the
  -- deparser's own renderings, measured in PGlite: `bucket in (...)` comes back as
  -- `bucket = ANY (ARRAY[...])`, and the literal order is the one the recreated constraint
  -- carries (foundation_v1's original order, not a re-sorted one). The cutover rewrites the
  -- old form with `= c_def_new`, so the recreated text is exactly the new form below.
  c_def_old constant text :=
    'CHECK ((bucket = ANY (ARRAY[''project-assets''::text, ''user-avatars''::text])))';
  c_def_new constant text :=
    'CHECK ((bucket = ANY (ARRAY[''project-assets''::text, ''user-avatars''::text, ''canvases''::text])))';
  v_attnum smallint;
  v_named integer;
  v_bucket_only integer;
  v_key smallint[];
  v_def text;
  v_norm text;
  v_form text;
  v_convalidated boolean;
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

  select c.conkey, pg_get_constraintdef(c.oid), c.convalidated
    into v_key, v_def, v_convalidated
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

  v_norm := replace(v_def, E'\n', ' ');
  v_norm := replace(v_norm, E'\r', ' ');
  v_norm := regexp_replace(v_norm, '\s+', ' ', 'g');
  v_norm := btrim(v_norm);

  -- `pg_get_constraintdef` appends ` NOT VALID` to an unvalidated constraint. That suffix is
  -- stripped here so the two allowed definitions stay exactly the two allowed definitions and
  -- the validity question is answered by `convalidated` below, not by string mismatch.
  v_norm := regexp_replace(v_norm, ' NOT VALID$', '');

  -- fixup2 E2: the definition must be the COMPLETE static expression, character for
  -- character. A regex that merely extracts the string literals inside `ARRAY[...]`
  -- accepts `ARRAY['canvases','project-assets','user-avatars',bucket]` (three correct
  -- literals plus a DYNAMIC element, which lets any value through) and accepts any
  -- function call, concatenation or subquery that happens to contain those literals.
  -- Both allowed forms are written out here in full instead.
  if v_norm = c_def_old then
    v_form := 'old';
  elsif v_norm = c_def_new then
    v_form := 'new';
  else
    raise exception 'X-52 storage cutover aborted: asset_objects_bucket_check is neither the exact static old set nor the exact static new set. actual=[%]',
      v_def using errcode = '42704';
  end if;

  -- A NOT VALID constraint is not a gate: PostgreSQL skips it for existing rows, and a
  -- migration that reports this as "safe" would be reporting a check that may already be
  -- violated. The target form in particular must be validated before the cutover claims
  -- the bucket set is enforced.
  if not v_convalidated then
    raise exception 'X-52 storage cutover aborted: asset_objects_bucket_check (form=%) is NOT VALID; the cutover requires a validated constraint',
      v_form using errcode = '42704';
  end if;

  if v_form = 'new' then
    -- 重放：已经是目标集合，且已 validated。
    null;
  elsif v_form = 'old' then
    execute 'alter table public.asset_objects drop constraint asset_objects_bucket_check';
    execute 'alter table public.asset_objects add constraint asset_objects_bucket_check '
         || 'check (bucket in (''project-assets'', ''user-avatars'', ''canvases''))';
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
