-- ============================================================================
-- P0-工单9 T1: 生成任务状态机 —— 新增 `retrying`（GN-30 / GN-34）
--
-- 背景：worker 把「可重试的失败」也写成 `failed`，而前端把 `failed` 当终态 ——
-- 用户第一次失败就看到「生成失败」、钱没退、后台还在重试；此时手动重投等于付两次钱。
--
-- 本迁移只做两件事，且**只用 `add value` + `comment`**：
-- Postgres 规定「同一事务里新加的枚举值不能马上使用」，所以这里**不写**任何
-- 用 `'retrying'` 的语句（表结构、默认值、数据回填一律不碰）。
--
-- `dead_letter` 保留在枚举里给历史行用；服务端从此不再写它，读出时映射成 `failed`。
-- ============================================================================

alter type public.background_job_status add value if not exists 'retrying' after 'running';

comment on type public.background_job_status is
  'queued|running|retrying|succeeded|failed|canceled. dead_letter is legacy: never written, read as failed.';
