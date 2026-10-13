-- X-52 阶段1C（工单18 T3）：把 storage 目标状态放回私有化切换之前。
--
-- 位置很重要：这个文件在 `supabase/rollbacks/`，**不能**放进 `supabase/migrations/` ——
-- 放进 migrations 目录，fresh install 会在最后一个 migration 之后自动把刚切好的
-- private 状态又回滚成 public，等于本次私有化从未发生。
--
-- 执行方式：在**目标数据库**上作为一个整体执行（`psql -f` / SQL editor 一次提交）。
-- 本文件自带 `BEGIN..COMMIT`，是**灾难恢复脚本**，不走 migration runner。
-- 若中途 RAISE 导致事务中止，连接会停在 "current transaction is aborted" 状态，
-- 执行方必须显式 `ROLLBACK;` 收尾，再按 §7 逐项核对（此时数据库应仍等于失败前状态）。
--
-- fail-loud：三条桶缺任何一条立即 RAISE 并整体回滚。
--   历史实现会 "UPDATE 0 行然后 COMMIT 成功"，把一次**根本没生效**的回滚报成成功；
--   灾难恢复场景下这种静默成功最危险 —— 运维以为已经回到 public，实际没有。
--
-- 幂等：BEGIN..COMMIT 单事务；重复执行结果一致。
-- 有损性：本回滚**只**回滚"桶公开性 + canvases 策略"。
--   * 不删除、不移动任何 object；
--   * 不删除任何 metadata（asset_objects 一行不动）；
--   * 不收窄 asset_objects.bucket 的 CHECK，也不动其它任何 schema。
--   因此回滚前后 storage.objects 与 asset_objects 的行数必须逐项相等。
--
-- 已知边界：把 project-assets 重新设回 public 会重新暴露"知道 URL 就能读"的读法。
-- 这是切换前的真实状态，回滚的目的就是回到它；只有在私有化造成不可接受的破坏时才用它。

begin;

-- ---------------------------------------------------------------------------
-- 1. 前置：三个桶必须都存在。少任何一个 RAISE，整个事务回滚。
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
    raise exception 'X-52 storage rollback aborted: required bucket(s) missing: %', v_missing
      using errcode = '42704';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. 三个桶恢复 public=true（切换前三个桶都是 public）。
-- ---------------------------------------------------------------------------
update storage.buckets set public = true where id = 'project-assets';
update storage.buckets set public = true where id = 'canvases';
update storage.buckets set public = true where id = 'home-seeds';

-- ---------------------------------------------------------------------------
-- 3. 撤掉 canvases metadata reader。
-- ---------------------------------------------------------------------------
drop policy if exists "canvases_select_metadata_reader" on storage.objects;

-- ---------------------------------------------------------------------------
-- 4. 精确恢复切换前那两条 canvases 策略（与 20260327000001 的定义逐字一致）。
-- ---------------------------------------------------------------------------
drop policy if exists "canvases_select_public" on storage.objects;
create policy "canvases_select_public"
  on storage.objects for select
  to public
  using (bucket_id = 'canvases');

drop policy if exists "canvases_insert_authenticated" on storage.objects;
create policy "canvases_insert_authenticated"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'canvases');

-- ---------------------------------------------------------------------------
-- 5. `project_assets_select_metadata_reader` 保持不动：切换前后都在，不属回滚范围。
--    `home_seeds_select_public` 同理（本单从未改过它）。
-- ---------------------------------------------------------------------------

commit;
