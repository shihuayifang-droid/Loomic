-- ============================================================================
-- 工单31A · BL-14 价目表 + GN-07 计价规则（**只建能力，不切扣费路径**）
--
-- 背景：价格目前散落在 `packages/shared/src/model-catalog.ts` 的 `cost` 与
-- `credits.ts` 的 `DEFAULT_*_COST` 里，前端/后端/文档各写一份（BL-14 第 1 条
-- 明确要求「价格只存在于价目表」）。本迁移只把**表**和**种子行**建出来：
--
--   1. 两张表：`pricing_rules`（规则）/ `price_change_log`（改价留痕）。
--   2. 种子行全部 `price_status = 'pending'`、`price` 为 null —— BL-14 第 2 条
--      「一期种子只建行、不填价」。**本文件里不出现任何价格数字**，包括
--      Lovart 参考价（BL-14 第 9 条：参考价不进种子数据）。
--   3. 行必须存在，否则 GN-07 会把该模型当成「未登记」直接拒绝。
--
-- 为什么不建 RLS、也不挂 auth schema 里的函数和表：
--   这两张表只允许服务端 pg repository 访问（工单 31A 裁决 7）。不建策略、
--   不引用登录用户，工单 24 迁移到 canonical schema 时可以直接搬。
--   `price_change_log.operator_id` 就是操作人的 uuid，**故意不加外键**。
--   （写这一段时踩过一次坑：审计脚本按文本数 `auth` 的点号调用与点号表名，
--     注释里写字面量也会算进去。所以这里只写「auth schema」，不写那种形式。）
--
-- 口径（工单 31A §1 裁决 1~7）：
--   - 工具价按工具定价：`model_id = 'tool:<工具 id>'`，不随执行模型变化（GN-05）。
--   - 图片模型沿用现有三档 `standard/hd/ultra`；视频只建默认行。
--   - 默认行 `search_key = '*'`；一期 `time_period` 全部 `'normal'`。
--   - `price` 是整数积分，可空；`active` 时 `>= 0`，`pending` 时必须为 null（CHECK）。
--   - 零消耗的工具（调整/裁剪/翻转/下载）不建行（BL-14）。
-- ============================================================================

create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  model_id text not null,               -- 模型 id 或 'tool:<id>'
  entry_point text not null default '*' check (entry_point in ('*','agent','agent_generator','canvas_generator','tool')),
  search_key text not null,             -- 档位或 '*'（默认行）
  time_period text not null default 'normal' check (time_period in ('*','normal')),
  unit_name text not null default '次',
  unit_size integer check (unit_size is null or unit_size > 0),   -- 视频秒数单位，可空
  price integer,
  price_status text not null check (price_status in ('pending','active')),
  effective_at timestamptz not null default now(),
  extras jsonb not null default '[]'::jsonb,                     -- GN-28 预留
  created_at timestamptz not null default now(),
  check ((price_status = 'pending' and price is null) or (price_status = 'active' and price is not null and price >= 0)),
  unique (model_id, entry_point, search_key, time_period, effective_at)
);

comment on table public.pricing_rules is
  'BL-14 price table. A price lives HERE only; code holds no price constants. pending = 待定价 (quote returns 0, still executable).';
comment on column public.pricing_rules.search_key is
  'Tier (e.g. standard/hd/ultra for images, 2k/4k/8k for upscale) or * for the model default row.';
comment on column public.pricing_rules.effective_at is
  'Scheduled activation (BL-14 验收 5). A read at time T only sees rows with effective_at <= T, newest per (entry_point, search_key, time_period).';

-- `listCandidateRules` filters by model and cutoff, then takes the newest row per
-- (entry_point, search_key, time_period). The unique constraint already indexes
-- those four columns in that order; this one keeps the cutoff scan narrow.
create index pricing_rules_model_effective_idx
  on public.pricing_rules (model_id, effective_at desc);

create table public.price_change_log (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.pricing_rules(id) on delete cascade,
  operator_id uuid not null,            -- 不加 FK（见裁决 7）
  old_price integer, new_price integer, old_status text not null, new_status text not null,
  effective_at timestamptz not null, reason text not null check (length(reason) > 0),
  changed_at timestamptz not null default now()
);

comment on table public.price_change_log is
  'BL-14 第 6 条 改价留痕: who changed which rule from what to what, when it takes effect and why. History is append-only; transaction records keep their own quoted/charged price.';

-- FK side of the cascade plus the natural read order of one rule's history.
create index price_change_log_rule_changed_idx
  on public.price_change_log (rule_id, changed_at desc);

-- ============================================================================
-- 种子行（BL-14 第 2 条）：每行 price 为 null、price_status = 'pending'、
-- entry_point = '*'、time_period 走默认 'normal'。
--
-- 行数构成（工单 31A §1 裁决 6）：
--   工具 18 = 12 个计费工具的默认行 + upscale(2k/4k/8k) + edit_text(1k/2k/4k)
--   图片 80 = 20 个图片模型 × (默认行 + standard/hd/ultra)
--   视频 25 = VIDEO_MODEL_CATALOG 里每个模型一行默认行
--   ---------------------------------------------------------------
--   合计 123 行
--
-- ⚠️ 工单正文写的是「VIDEO 有 24 个 / 合计 122 行」，实测
--    `packages/shared/src/model-catalog.ts` 的 VIDEO_MODEL_CATALOG 是 **25 个**，
--    且 25 个都被 providers 引用（没有「未上线的第 25 个」可排除）。
--    按工单自己的规则「每个模型一行默认行 / 模型 id 从 catalog 抄」，
--    种子必须覆盖全部 25 个，否则被漏掉的那个模型会被 GN-07 当成「未登记」拒绝
--    （BL-14 第 2 条：行必须存在）。此处按 catalog 实测 123 行落库，
--    偏离与裁决请求见 `02-回传\工单31A-回传.md`。
-- ============================================================================

-- 工具：`pricing.generator` 就是工具 id（21AB 工具定义），零消耗工具不在此列。
insert into public.pricing_rules (model_id, entry_point, search_key, unit_name, price_status) values
  ('tool:quick_edit', '*', '*', '次', 'pending'),
  ('tool:remove_background', '*', '*', '次', 'pending'),
  ('tool:upscale', '*', '*', '次', 'pending'),
  ('tool:upscale', '*', '2k', '次', 'pending'),
  ('tool:upscale', '*', '4k', '次', 'pending'),
  ('tool:upscale', '*', '8k', '次', 'pending'),
  ('tool:layer_split_auto', '*', '*', '次', 'pending'),
  ('tool:layer_split_custom', '*', '*', '次', 'pending'),
  ('tool:edit_text', '*', '*', '次', 'pending'),
  ('tool:edit_text', '*', '1k', '次', 'pending'),
  ('tool:edit_text', '*', '2k', '次', 'pending'),
  ('tool:edit_text', '*', '4k', '次', 'pending'),
  ('tool:multi_angle', '*', '*', '次', 'pending'),
  ('tool:erase', '*', '*', '次', 'pending'),
  ('tool:expand', '*', '*', '次', 'pending'),
  ('tool:move_object', '*', '*', '次', 'pending'),
  ('tool:vectorize', '*', '*', '次', 'pending'),
  ('tool:motion', '*', '*', '次', 'pending');

-- 图片模型：默认行 + 现有扣费路径的三档（standard/hd/ultra），档位名沿用现状，
-- 下一张单切扣费时不用改语义（裁决 2）。
insert into public.pricing_rules (model_id, entry_point, search_key, unit_name, price_status) values
  ('black-forest-labs/flux-kontext-max', '*', '*', '次', 'pending'),
  ('black-forest-labs/flux-kontext-max', '*', 'standard', '次', 'pending'),
  ('black-forest-labs/flux-kontext-max', '*', 'hd', '次', 'pending'),
  ('black-forest-labs/flux-kontext-max', '*', 'ultra', '次', 'pending'),
  ('black-forest-labs/flux-kontext-pro', '*', '*', '次', 'pending'),
  ('black-forest-labs/flux-kontext-pro', '*', 'standard', '次', 'pending'),
  ('black-forest-labs/flux-kontext-pro', '*', 'hd', '次', 'pending'),
  ('black-forest-labs/flux-kontext-pro', '*', 'ultra', '次', 'pending'),
  ('bytedance/seedream-4', '*', '*', '次', 'pending'),
  ('bytedance/seedream-4', '*', 'standard', '次', 'pending'),
  ('bytedance/seedream-4', '*', 'hd', '次', 'pending'),
  ('bytedance/seedream-4', '*', 'ultra', '次', 'pending'),
  ('bytedance/seedream-4.5', '*', '*', '次', 'pending'),
  ('bytedance/seedream-4.5', '*', 'standard', '次', 'pending'),
  ('bytedance/seedream-4.5', '*', 'hd', '次', 'pending'),
  ('bytedance/seedream-4.5', '*', 'ultra', '次', 'pending'),
  ('bytedance/seedream-5-lite', '*', '*', '次', 'pending'),
  ('bytedance/seedream-5-lite', '*', 'standard', '次', 'pending'),
  ('bytedance/seedream-5-lite', '*', 'hd', '次', 'pending'),
  ('bytedance/seedream-5-lite', '*', 'ultra', '次', 'pending'),
  ('google-official/gemini-2.5-flash-image', '*', '*', '次', 'pending'),
  ('google-official/gemini-2.5-flash-image', '*', 'standard', '次', 'pending'),
  ('google-official/gemini-2.5-flash-image', '*', 'hd', '次', 'pending'),
  ('google-official/gemini-2.5-flash-image', '*', 'ultra', '次', 'pending'),
  ('google-official/gemini-3-pro-image-preview', '*', '*', '次', 'pending'),
  ('google-official/gemini-3-pro-image-preview', '*', 'standard', '次', 'pending'),
  ('google-official/gemini-3-pro-image-preview', '*', 'hd', '次', 'pending'),
  ('google-official/gemini-3-pro-image-preview', '*', 'ultra', '次', 'pending'),
  ('google-official/gemini-3.1-flash-image-preview', '*', '*', '次', 'pending'),
  ('google-official/gemini-3.1-flash-image-preview', '*', 'standard', '次', 'pending'),
  ('google-official/gemini-3.1-flash-image-preview', '*', 'hd', '次', 'pending'),
  ('google-official/gemini-3.1-flash-image-preview', '*', 'ultra', '次', 'pending'),
  ('google-vertex/gemini-2.5-flash-image', '*', '*', '次', 'pending'),
  ('google-vertex/gemini-2.5-flash-image', '*', 'standard', '次', 'pending'),
  ('google-vertex/gemini-2.5-flash-image', '*', 'hd', '次', 'pending'),
  ('google-vertex/gemini-2.5-flash-image', '*', 'ultra', '次', 'pending'),
  ('google-vertex/gemini-3-pro-image-preview', '*', '*', '次', 'pending'),
  ('google-vertex/gemini-3-pro-image-preview', '*', 'standard', '次', 'pending'),
  ('google-vertex/gemini-3-pro-image-preview', '*', 'hd', '次', 'pending'),
  ('google-vertex/gemini-3-pro-image-preview', '*', 'ultra', '次', 'pending'),
  ('google-vertex/gemini-3.1-flash-image-preview', '*', '*', '次', 'pending'),
  ('google-vertex/gemini-3.1-flash-image-preview', '*', 'standard', '次', 'pending'),
  ('google-vertex/gemini-3.1-flash-image-preview', '*', 'hd', '次', 'pending'),
  ('google-vertex/gemini-3.1-flash-image-preview', '*', 'ultra', '次', 'pending'),
  ('google/imagen-4', '*', '*', '次', 'pending'),
  ('google/imagen-4', '*', 'standard', '次', 'pending'),
  ('google/imagen-4', '*', 'hd', '次', 'pending'),
  ('google/imagen-4', '*', 'ultra', '次', 'pending'),
  ('google/nano-banana', '*', '*', '次', 'pending'),
  ('google/nano-banana', '*', 'standard', '次', 'pending'),
  ('google/nano-banana', '*', 'hd', '次', 'pending'),
  ('google/nano-banana', '*', 'ultra', '次', 'pending'),
  ('google/nano-banana-2', '*', '*', '次', 'pending'),
  ('google/nano-banana-2', '*', 'standard', '次', 'pending'),
  ('google/nano-banana-2', '*', 'hd', '次', 'pending'),
  ('google/nano-banana-2', '*', 'ultra', '次', 'pending'),
  ('google/nano-banana-pro', '*', '*', '次', 'pending'),
  ('google/nano-banana-pro', '*', 'standard', '次', 'pending'),
  ('google/nano-banana-pro', '*', 'hd', '次', 'pending'),
  ('google/nano-banana-pro', '*', 'ultra', '次', 'pending'),
  ('kwjm/gpt-image-1.5', '*', '*', '次', 'pending'),
  ('kwjm/gpt-image-1.5', '*', 'standard', '次', 'pending'),
  ('kwjm/gpt-image-1.5', '*', 'hd', '次', 'pending'),
  ('kwjm/gpt-image-1.5', '*', 'ultra', '次', 'pending'),
  ('kwjm/gpt-image-2', '*', '*', '次', 'pending'),
  ('kwjm/gpt-image-2', '*', 'standard', '次', 'pending'),
  ('kwjm/gpt-image-2', '*', 'hd', '次', 'pending'),
  ('kwjm/gpt-image-2', '*', 'ultra', '次', 'pending'),
  ('kwjm/gpt-image-2-inpaint', '*', '*', '次', 'pending'),
  ('kwjm/gpt-image-2-inpaint', '*', 'standard', '次', 'pending'),
  ('kwjm/gpt-image-2-inpaint', '*', 'hd', '次', 'pending'),
  ('kwjm/gpt-image-2-inpaint', '*', 'ultra', '次', 'pending'),
  ('openai/gpt-image-1.5', '*', '*', '次', 'pending'),
  ('openai/gpt-image-1.5', '*', 'standard', '次', 'pending'),
  ('openai/gpt-image-1.5', '*', 'hd', '次', 'pending'),
  ('openai/gpt-image-1.5', '*', 'ultra', '次', 'pending'),
  ('recraft-ai/recraft-v3', '*', '*', '次', 'pending'),
  ('recraft-ai/recraft-v3', '*', 'standard', '次', 'pending'),
  ('recraft-ai/recraft-v3', '*', 'hd', '次', 'pending'),
  ('recraft-ai/recraft-v3', '*', 'ultra', '次', 'pending');

-- 视频模型：每个模型一行默认行。计价单位是「秒」（GN-08），`unit_size` 一期留空
-- 待定（时长单位 4s/5s/6s 并存，GN-08 还没收口）。
insert into public.pricing_rules (model_id, entry_point, search_key, unit_name, price_status) values
  ('bytedance/seedance-1.5-pro', '*', '*', '秒', 'pending'),
  ('google-official/veo-2.0-generate-001', '*', '*', '秒', 'pending'),
  ('google-official/veo-3.0-fast-generate-001', '*', '*', '秒', 'pending'),
  ('google-official/veo-3.0-generate-001', '*', '*', '秒', 'pending'),
  ('google-official/veo-3.1-fast-generate-preview', '*', '*', '秒', 'pending'),
  ('google-official/veo-3.1-generate-preview', '*', '*', '秒', 'pending'),
  ('google-official/veo-3.1-lite-generate-preview', '*', '*', '秒', 'pending'),
  ('google-vertex/veo-2.0-generate-001', '*', '*', '秒', 'pending'),
  ('google-vertex/veo-3.0-fast-generate-001', '*', '*', '秒', 'pending'),
  ('google-vertex/veo-3.0-generate-001', '*', '*', '秒', 'pending'),
  ('google-vertex/veo-3.1-fast-generate-001', '*', '*', '秒', 'pending'),
  ('google-vertex/veo-3.1-generate-001', '*', '*', '秒', 'pending'),
  ('google-vertex/veo-3.1-lite-generate-001', '*', '*', '秒', 'pending'),
  ('google/veo-3', '*', '*', '秒', 'pending'),
  ('google/veo-3.1', '*', '*', '秒', 'pending'),
  ('google/veo-3.1-fast', '*', '*', '秒', 'pending'),
  ('kwaivgi/kling-o1', '*', '*', '秒', 'pending'),
  ('kwaivgi/kling-v2.6', '*', '*', '秒', 'pending'),
  ('kwaivgi/kling-v3-omni-video', '*', '*', '秒', 'pending'),
  ('kwaivgi/kling-v3-video', '*', '*', '秒', 'pending'),
  ('metaso/minimax-h3', '*', '*', '秒', 'pending'),
  ('minimax/hailuo-2.3', '*', '*', '秒', 'pending'),
  ('openai/sora-2', '*', '*', '秒', 'pending'),
  ('openai/sora-2-pro', '*', '*', '秒', 'pending'),
  ('wan-video/wan-2.6', '*', '*', '秒', 'pending');
