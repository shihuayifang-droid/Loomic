/**
 * ED-00e · 选中内容 → 工具条形态（纯函数，不碰 DOM、不依赖 Excalidraw 类型）
 *
 * 规格表在 `docs/项目/hahart/00-需求与策划/功能需求/ED-逐图编辑.md` 的 ED-00e（约 L168–190），
 * 共 9 行。本模块只认下面这个抽象的 `kind`；Excalidraw 元素到 `kind` 的映射见本文件的
 * {@link elementKind}（工单 30Q 接入画布时加入）。
 *
 * ## 判定优先级（工单 30E §1 的 Kiro 裁定，写在这里免得下一个人再猜一遍）
 *
 * 规格表里「多选（≥2，任意类型）」与「混选图片 + 形状」两行有重叠，裁定后的顺序是：
 *
 * 1. 空选择 → `none`。
 * 2. 单选（1 个）→ 按 `SINGLE_KIND_TOOLBAR` 逐 kind 映射，即规格表第 1、4~9 行。
 * 3. 多选且**全部是形状 / 文字** → `style`（批量改样式，ED-00o）。
 * 4. 多选且**恰好由图片 + 形状/文字组成**（至少 1 张图片、至少 1 个形状或文字，没有第三种 kind）
 *    → `common`（只显示通用项：不透明度、删除）。
 * 5. 其余多选 → `download_all`（只显示「下载全部」，打包 zip，ED-05）。
 *
 * 第 3 条要排在第 4 条前面：两份条件互斥（一份没有图片、一份必须有图片），顺序不影响结果，
 * 但把它写死能防止以后有人给第 4 条加条件时把「全是形状」吞掉。
 *
 * **规格未定义的一格**：「全是形状/文字」按裁定字面只含 `shape` 与 `text`。线条（`line`）与
 * 画笔（`freedraw`）只在**单选**那几行里归 `style`；多选 线条+画笔 落到第 5 条 `download_all`。
 * 与 Kiro 的裁定不冲突（裁定写的就是「全是形状/文字」），但规格本身没说，已写进回传的「新增发现」。
 */

export type SelectionItemKind =
  | "image"
  | "video"
  | "text"
  | "shape"
  | "line"
  | "freedraw"
  | "frame"
  | "placeholder_generating"
  | "placeholder_failed"
  | "vector";

export type ToolbarKind =
  | "none"
  | "image"
  | "video_panel"
  | "style"
  | "frame"
  | "placeholder_generating"
  | "placeholder_failed"
  | "vector"
  | "download_all"
  | "common";

/** 编辑类对象的 kind：只有这两种算「样式工具条」的对象（ED-00o，批量改样式）。 */
const STYLE_OBJECT_KINDS: ReadonlySet<SelectionItemKind> = new Set(["shape", "text"]);

/**
 * 单选时每个 kind 归哪种形态。用 `Record<SelectionItemKind, ToolbarKind>` 而不是
 * `Partial<...>`，是为了让 TypeScript 在**新增一个 kind 却忘了归类**时直接报错。
 */
const SINGLE_KIND_TOOLBAR: Record<SelectionItemKind, ToolbarKind> = {
  image: "image",
  video: "video_panel",
  text: "style",
  shape: "style",
  line: "style",
  freedraw: "style",
  frame: "frame",
  placeholder_generating: "placeholder_generating",
  placeholder_failed: "placeholder_failed",
  vector: "vector",
};

/**
 * 每种形态显示哪些项（规范名，snake_case）。
 *
 * - `image` 写 `["*"]`：完整图片工具条由 ED-00k 的 `/api/tools` 下发（30F 做），
 *   本单**不许硬编码工具列表**，所以这里只放一个占位通配符。
 * - `video_panel` / `frame` 是空数组：这两种形态**不弹图片工具条**
 *   （视频走 `components/canvas/generator-registry.tsx` 的现有视频面板，画板走 CV 模块），
 *   所以图片工具条这一侧一个项都不渲染。
 * - `style` 的项来自 ED-00o 的固定表（描边色 / 填充色 / 线宽 / 线型 / 不透明度 / 字号 / 字体 / 对齐 / 删除），
 *   它不是 `/api/tools` 下发的工具清单，所以可以写死。「适用对象」那一列（谁能改线宽、谁只能改字号）
 *   由 ED-00o 自己的规则决定，不在本模块的范围里 —— 这里给的是样式工具条这个**形态**的并集。
 */
export const TOOLBAR_ITEMS: Record<ToolbarKind, readonly string[]> = {
  none: [],
  image: ["*"],
  video_panel: [],
  style: [
    "stroke",
    "fill",
    "stroke_width",
    "stroke_style",
    "opacity",
    "font_size",
    "font_family",
    "text_align",
    "delete",
  ],
  frame: [],
  placeholder_generating: ["cancel"],
  placeholder_failed: ["retry", "delete"],
  vector: ["download", "flip_rotate"],
  download_all: ["download_all"],
  common: ["opacity", "delete"],
};

/**
 * 参与映射的 Excalidraw 元素字段（结构子集，不引 Excalidraw 的类型）。
 *
 * `customData` 用 `unknown` 而不是 `boolean`：Excalidraw 的元素是 `Record<string, any>`，
 * 真实数据里这个键可能被写成任何东西，所以只在 `=== true` 时才认（见 {@link elementKind}）。
 */
export type ElementKindInput = {
  readonly type?: string | undefined;
  readonly customData?: { readonly generating?: unknown } | null | undefined;
};

/**
 * 元素 → kind（工单 30Q §3 裁决 2 的表格，**顺序即优先级**）。
 *
 * | 元素 | kind |
 * |---|---|
 * | `customData.generating === true` | `placeholder_generating` |
 * | `type === "image"` | `image` |
 * | `text` | `text` |
 * | `rectangle` / `ellipse` / `diamond` | `shape` |
 * | `line` / `arrow` | `line` |
 * | `freedraw` | `freedraw` |
 * | `frame` / `magicframe` | `frame` |
 * | 其余（含 `embeddable`） | `null` |
 *
 * 三处口径：
 *
 * 1. **「正在生成」排在最前**。占位符在生成中会显示成一张图（`type` 也是 `image`），
 *    先判 `generating` 才不会把生成中的占位当成可编辑的图片、弹出一条对占位无意义的工具条。
 * 2. `placeholder_failed` 与 `vector` **本单不映射**（返回 `null`），接对应工具的那张单再补，
 *    见 T-78。`embeddable` 同理：视频走另一张单，`video` 的判定不在这里做。
 * 3. `null` 是「这个元素不在本模块的认知范围」，调用方拿到 `null` 就**不显示工具条**
 *    （工单 §3 裁决 2 最后一句：任意一个选中元素映射成 null 就不显示）。
 */
export function elementKind(el: ElementKindInput): SelectionItemKind | null {
  if (el.customData?.generating === true) return "placeholder_generating";
  switch (el.type) {
    case "image":
      return "image";
    case "text":
      return "text";
    case "rectangle":
    case "ellipse":
    case "diamond":
      return "shape";
    case "line":
    case "arrow":
      return "line";
    case "freedraw":
      return "freedraw";
    case "frame":
    case "magicframe":
      return "frame";
    default:
      return null;
  }
}

/**
 * 选中内容 → 工具条形态。纯函数，无副作用，可单测。
 *
 * @param selection 当前选中的对象（只用到 `kind`）。顺序无关，重复的 kind 会被合并考虑。
 */
export function resolveToolbar(
  selection: readonly { kind: SelectionItemKind }[],
): ToolbarKind {
  // 1. 空选择：没有选中任何对象时不显示工具条。
  if (selection.length === 0) return "none";

  // 2. 单选：逐 kind 映射（规格表第 1、4~9 行）。
  if (selection.length === 1) {
    const only = selection[0];
    // `noUncheckedIndexedAccess` 下 `selection[0]` 可能是 undefined，长度已判过，这里只是收窄。
    if (only === undefined) return "none";
    return SINGLE_KIND_TOOLBAR[only.kind];
  }

  // 3~5. 多选：三分支。
  let everyStyleObject = true;
  let everyImageOrStyleObject = true;
  let hasImage = false;
  let hasStyleObject = false;

  for (const item of selection) {
    const isStyleObject = STYLE_OBJECT_KINDS.has(item.kind);
    const isImage = item.kind === "image";
    if (!isStyleObject) everyStyleObject = false;
    if (!isStyleObject && !isImage) everyImageOrStyleObject = false;
    if (isImage) hasImage = true;
    if (isStyleObject) hasStyleObject = true;
  }

  // 3. 全是形状 / 文字 → 样式工具条（批量修改，ED-00o）。
  if (everyStyleObject) return "style";

  // 4. 恰好由图片 + 形状/文字组成 → 只显示通用项（不透明度、删除）。
  if (everyImageOrStyleObject && hasImage && hasStyleObject) return "common";

  // 5. 其余多选（两张图片、图片 + 视频、图片 + 画板…）→ 只显示「下载全部」。
  return "download_all";
}
