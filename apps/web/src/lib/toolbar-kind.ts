/**
 * ED-00e · 选中内容 → 工具条形态（纯函数，不碰 DOM、不依赖 Excalidraw 类型）
 *
 * 规格表在 `docs/项目/hahart/00-需求与策划/功能需求/ED-逐图编辑.md` 的 ED-00e（约 L168–190），
 * 共 9 行。本模块只认下面这个抽象的 `kind`：从 Excalidraw 元素映射到 `kind` 的工作要改
 * `canvas-editor.tsx`（脏文件），留到接入画布时再做。
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
