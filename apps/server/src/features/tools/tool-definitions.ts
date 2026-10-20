import {
  type ToolDefinition,
  toolListResponseSchema,
} from "@loomic/shared";

/**
 * ED-00k — the one static tool table (workorder 21AB).
 *
 * The front end does not hard-code a tool list: the per-image toolbar (ED-00),
 * the "more" menu (ED-00f), the custom-toolbar grid (ED-00g), the tooltips and
 * the Agent tool registration (SK-13) all render from this table, shipped over
 * `GET /api/tools`.
 *
 * Every value below is taken from the ED spec as written, one row per
 * `ED-01`..`ED-17` section — 17 tools, not the "18" ED-00k's prose claims (see
 * `ED_00K_CLAIMED_TOOL_COUNT`). Where the spec states no value the field is
 * `null` rather than invented; the workorder lists each of those.
 *
 * Order is the ED number order, so a reader can walk the spec and the table
 * together.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  // ED-01 调整（调色）— pure front-end, zero cost; "完成" is disabled while all
  // 17 sliders are 0 (ED-01: tooltip 未做任何调整).
  {
    id: "adjust",
    label: "调整",
    icon: "adjust",
    testid: "image-toolbar-adjust",
    form: "panel",
    default_slot: "more",
    removable: true,
    consumes: false,
    pricing: null,
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [
      { id: "no_adjustment", message: "未做任何调整" },
    ],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
    /**
     * ED-01 规格表, verbatim (MD-03 / X-P11, T-66): 17 sliders in three groups.
     * The web panel renders from this, so the labels and the ranges live here
     * only. Every slider defaults to 0 ("默认值全为 0"), which is also what makes
     * 「完成」 disabled via `disabled_rules.no_adjustment`.
     */
    param_groups: [
      {
        id: "light",
        label: "光",
        params: [
          { id: "light", label: "光线", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "exposure", label: "曝光", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "contrast", label: "对比度", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "highlights", label: "高光", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "shadows", label: "阴影", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "whites", label: "白色", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "blacks", label: "黑色", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
        ],
      },
      {
        id: "color",
        label: "色",
        params: [
          { id: "vibrance", label: "自然饱和度", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "saturation", label: "饱和度", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "temperature", label: "色温", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "tint", label: "色调", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
        ],
      },
      {
        id: "effect",
        label: "效果",
        params: [
          { id: "sharpen", label: "锐化", min: 0, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "clarity", label: "清晰度", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "grain", label: "颗粒", min: 0, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "vignette", label: "晕影", min: -100, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "glamour", label: "柔光", min: 0, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
          { id: "bloom", label: "辉光", min: 0, max: 100, defaultValue: 0, display: { kind: "linear", a: 0, k: 1, round: 0 } },
        ],
      },
    ],
  },
  // ED-02 裁剪 — pure front-end, zero cost. The spec's messages carry the
  // source image's numbers ("不能超过原图宽度 1254"); the table holds the fixed
  // part and the client appends the measured value.
  {
    id: "crop",
    label: "裁剪",
    icon: "crop",
    testid: "image-toolbar-crop",
    form: "panel",
    default_slot: "more",
    removable: true,
    consumes: false,
    pricing: null,
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [
      { id: "width_exceeds_source", message: "不能超过原图宽度" },
      { id: "height_exceeds_source", message: "不能超过原图高度" },
      { id: "not_positive_integer", message: "必须是正整数" },
      { id: "no_crop", message: "未做裁剪" },
    ],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
  },
  // ED-03 翻转与旋转 — geometry only: the element transform changes, no file and
  // no artifact row is created (ED-00i ②), hence output_kind "none".
  {
    id: "flip_rotate",
    label: "翻转与旋转",
    icon: "flip_rotate",
    testid: "image-toolbar-flip-rotate",
    form: "subbar",
    default_slot: "more",
    removable: true,
    consumes: false,
    pricing: null,
    output_kind: "none",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
  },
  // ED-04 Mockup — behaviour untested (R19), not scheduled; it is not in
  // ED-00f's menu and not in ED-00g's default seven, and the spec never says it
  // bills. It inserts a container object instead of producing an artifact
  // (gap-8 C4: Mockup 不走模型), so `insert` and `consumes: false`.
  {
    id: "mockup",
    label: "Mockup",
    icon: "mockup",
    testid: "image-toolbar-mockup",
    form: "insert",
    default_slot: "more",
    removable: true,
    consumes: false,
    pricing: null,
    output_kind: "mockup",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [],
    eta_seconds: null,
    agent_callable: false,
    availability: "unavailable",
  },
  // ED-05 下载 — downloads the ORIGINAL (ED-00j), no new artifact; fixed,
  // non-removable (ED-00g), zero cost (ED-00c: 下载是零消耗操作).
  {
    id: "download",
    label: "下载",
    icon: "download",
    testid: "image-toolbar-download",
    form: "direct",
    default_slot: "main",
    removable: false,
    consumes: false,
    pricing: null,
    output_kind: "none",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
  },
  // ED-06 快捷编辑 — paid ("生成 · N"), fixed non-removable (ED-00g) because its
  // panel REPLACES the toolbar. The spec names the task type literally:
  // `event_type = quick_edit`.
  {
    id: "quick_edit",
    label: "快捷编辑",
    icon: "quick_edit",
    testid: "image-toolbar-quick-edit",
    form: "panel",
    default_slot: "main",
    removable: false,
    consumes: true,
    pricing: { generator: "quick_edit", tiers: [] },
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: "quick_edit",
    disabled_rules: [
      { id: "empty_prompt", message: "请先描述要怎么改" },
    ],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
  },
  // ED-07 去背景 — direct execution; true transparent PNG at source size,
  // `remove_background_<id>.png` (ED-05 file-name rule). Lovart measured ~12 s.
  // availability stays `unavailable`: the capability gap T-ED4 is open.
  {
    id: "remove_background",
    label: "去背景",
    icon: "remove_background",
    testid: "image-toolbar-remove-background",
    form: "direct",
    default_slot: "main",
    removable: true,
    consumes: true,
    pricing: { generator: "remove_background", tiers: [] },
    output_kind: "image",
    output_format: "png",
    file_prefix: "remove_background",
    event_type: null,
    disabled_rules: [],
    eta_seconds: 12,
    agent_callable: true,
    availability: "unavailable",
  },
  // ED-08 放大 — the ED-00k example row: dropdown over 2k/4k/8k, output format
  // 同源图, file prefix upscale, event type upscale, eta 30 s.
  {
    id: "upscale",
    label: "放大",
    icon: "upscale",
    testid: "image-toolbar-upscale",
    form: "dropdown",
    default_slot: "main",
    removable: true,
    consumes: true,
    pricing: { generator: "upscale", tiers: ["2k", "4k", "8k"] },
    output_kind: "image",
    output_format: "同源图",
    file_prefix: "upscale",
    event_type: "upscale",
    disabled_rules: [
      { id: "source_at_target", message: "原图已达该分辨率" },
    ],
    eta_seconds: 30,
    agent_callable: true,
    availability: "unavailable",
  },
  // ED-09 图层拆分 · 自动 — direct execution (ED-00d / ED-00m), one toolbar
  // "图层拆分" button whose first menu entry this is. Lovart measured ~9 s.
  {
    id: "layer_split_auto",
    label: "自动拆分",
    icon: "layer_split_auto",
    testid: "image-toolbar-layer-split-auto",
    form: "direct",
    default_slot: "main",
    removable: true,
    consumes: true,
    pricing: { generator: "layer_split_auto", tiers: [] },
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [],
    eta_seconds: 9,
    agent_callable: true,
    availability: "unavailable",
  },
  // ED-10 图层拆分 · 自定义 — panel, priced per call ("拆分 · N", never "/层").
  {
    id: "layer_split_custom",
    label: "自定义拆分",
    icon: "layer_split_custom",
    testid: "image-toolbar-layer-split-custom",
    form: "panel",
    default_slot: "main",
    removable: true,
    consumes: true,
    pricing: { generator: "layer_split_custom", tiers: [] },
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [
      { id: "empty_selection_and_prompt", message: "请框选或描述要拆出的内容" },
    ],
    eta_seconds: null,
    agent_callable: true,
    availability: "unavailable",
  },
  // ED-11 编辑文字 — panel; OCR first, so the panel opens into a loading state.
  // Resolution tiers are literal: 1K / 2K / 4K by source long edge.
  {
    id: "edit_text",
    label: "编辑文字",
    icon: "edit_text",
    testid: "image-toolbar-edit-text",
    form: "panel",
    default_slot: "main",
    removable: true,
    consumes: true,
    pricing: { generator: "edit_text", tiers: ["1k", "2k", "4k"] },
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [
      { id: "no_text_detected", message: "图中未检测到文字" },
      { id: "no_text_change", message: "请先修改文字" },
    ],
    eta_seconds: null,
    agent_callable: true,
    availability: "unavailable",
  },
  // ED-12 多角度 — panel; executing with the source viewpoint is refused
  // because it would spend credits on an identical image.
  {
    id: "multi_angle",
    label: "多角度",
    icon: "multi_angle",
    testid: "image-toolbar-multi-angle",
    form: "panel",
    default_slot: "main",
    removable: true,
    consumes: true,
    pricing: { generator: "multi_angle", tiers: [] },
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [
      { id: "params_unchanged", message: "参数未改变" },
    ],
    eta_seconds: null,
    agent_callable: true,
    availability: "unavailable",
  },
  // ED-13 橡皮 — panel with a mask; the ONE tool the spec pins to
  // `agent_callable = false` (an Agent cannot draw a mask, list L594).
  // Panel says 约 15 秒.
  {
    id: "erase",
    label: "橡皮",
    icon: "erase",
    testid: "image-toolbar-erase",
    form: "panel",
    default_slot: "main",
    removable: true,
    consumes: true,
    pricing: { generator: "erase", tiers: [] },
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [
      { id: "no_mask", message: "请先涂抹要消除的区域" },
    ],
    eta_seconds: 15,
    agent_callable: false,
    availability: "unavailable",
  },
  // ED-14 扩图 — "更多" → 扩展, panel with 11 ratio presets.
  {
    id: "expand",
    label: "扩展",
    icon: "expand",
    testid: "image-toolbar-expand",
    form: "panel",
    default_slot: "more",
    removable: true,
    consumes: true,
    pricing: { generator: "expand", tiers: [] },
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [
      { id: "no_expand_area", message: "未设置扩展区域" },
    ],
    eta_seconds: null,
    agent_callable: false,
    availability: "unavailable",
  },
  // ED-15 移动对象 — needs a model (gap-8 C4), so it is a panel here, not a
  // front-end-only action.
  {
    id: "move_object",
    label: "移动对象",
    icon: "move_object",
    testid: "image-toolbar-move-object",
    form: "panel",
    default_slot: "more",
    removable: true,
    consumes: true,
    pricing: { generator: "move_object", tiers: [] },
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [
      { id: "no_object_selected", message: "尚未选择对象" },
    ],
    eta_seconds: null,
    agent_callable: false,
    availability: "unavailable",
  },
  // ED-16 矢量化 — direct execution, produces SVG (not an image; CV-01), the
  // documented exception to the "image" output kind.
  {
    id: "vectorize",
    label: "矢量",
    icon: "vectorize",
    testid: "image-toolbar-vectorize",
    form: "direct",
    default_slot: "more",
    removable: true,
    consumes: true,
    pricing: { generator: "vectorize", tiers: [] },
    output_kind: "svg",
    output_format: "svg",
    file_prefix: null,
    event_type: null,
    disabled_rules: [],
    eta_seconds: null,
    agent_callable: false,
    availability: "unavailable",
  },
  // ED-17 动态图片（图生视频）— reuses the existing video-generator panel, so
  // the server adds no task type (ED-17 后端要点: 无新增).
  {
    id: "motion",
    label: "动态图片",
    icon: "motion",
    testid: "image-toolbar-motion",
    form: "panel",
    default_slot: "main",
    removable: true,
    consumes: true,
    pricing: { generator: "motion", tiers: [] },
    output_kind: "video",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [],
    eta_seconds: null,
    agent_callable: false,
    availability: "unavailable",
  },
];

/**
 * ED-00k's prose says "18 项工具"; the sections `ED-01`..`ED-17` are 17 tools
 * (`ED-11a`..`ED-11d` are sub-tasks, `ED-18` is not built — D-4). The table
 * follows the sections. Recorded here so the difference is a fact in the code
 * rather than a number in a report.
 */
export const ED_00K_CLAIMED_TOOL_COUNT = 18;

// Load-time self-check (workorder 21AB T2). A row that breaks the wire contract
// — an unknown enum value, a paying tool without a billing generator, a
// duplicated id — fails the module import, so the server cannot start with a
// broken table. The exhaustive invariants (count, slots, availability, ETAs)
// are pinned in `tool-definitions.test.ts`.
toolListResponseSchema.parse({ tools: TOOL_DEFINITIONS });
