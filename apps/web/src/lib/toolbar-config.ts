/**
 * ED-00g · 自定义工具栏的两个纯函数（工单 30N T1）
 *
 * 规格在 `docs/项目/hahart/00-需求与策划/功能需求/ED-逐图编辑.md` 的 ED-00g。本模块只做两件
 * 不碰 DOM、不碰 React 的事，两件都是为了「接入画布那一单一行都不用改组件」：
 *
 * 1. `applyToolbarConfig(tools, config)` —— 把用户保存的配置**翻译成工具定义的
 *    `default_slot`**，返回新定义数组。这样 `ImageToolbar` / `ImageToolbarMoreMenu` 现有的
 *    「`default_slot === "main"` 进工具条、否则进『更多』」过滤逻辑一个字都不用动
 *    （工单 §2 裁决 3），预览条和真实工具条用的就是同一个组件。
 * 2. `fitToolbar(...)` —— 溢出判定。jsdom 不做布局（`offsetWidth` 恒为 0），所以宽度**由调用方
 *    量好传进来**，本函数只做算术；量 DOM 属于接入单（`maxWidth = viewportWidth − 2×24`）。
 *
 * ## 默认配置不写死在这里（工单 §2 裁决 2）
 *
 * 规格的「默认 7 个」由**服务端**在用户没保存过时返回，所以 src 里不许出现那组工具 id 的数组。
 * 本文件里出现的字符串只有字段名（`pinned` / `show_labels`），没有任何工具 id。
 */

import type { ToolDefinition, ToolSlot } from "@loomic/shared";

/**
 * ED-00g 的配置形状，字段名与规格的后端接口一致（工单 §2 裁决 1）。
 *
 * `pinned` = 用户勾选进 main 区的工具 id，**数组顺序就是 main 区的顺序**；
 * 不在里面的可移除工具进「更多」。
 */
export type ToolbarConfig = {
  pinned: string[];
  show_labels: boolean;
};

/**
 * 把配置应用到工具定义上，返回**改写过 `default_slot` 的新数组**（工单 §2 裁决 3）。
 *
 * 规则逐条对应裁决：
 * - `removable === true`：在 `pinned` 里就是 `main`，否则 `more`；
 * - `removable === false`（快捷编辑、下载）：**保持原来的 `default_slot`**，`pinned` 里出现它的
 *   id 也不生效 —— 规格的「不可移除」就是这个意思，否则用户能把入口/导出从工具条上弄没；
 * - `pinned` 里未知的 id、不可移除工具的 id、重复的 id 一律丢弃（规格「非法 tool_id 在读取时丢弃」）；
 * - main 区的顺序**按 `pinned` 数组的顺序**：返回数组的前半段就是 pinned 依次对应的工具，
 *   其余工具按入参原顺序跟在后面。`ImageToolbar` 按数组顺序渲染编辑动作组，于是顺序自动成立，
 *   **不需要给组件加排序参数**。
 *
 * 入参数组与数组里的对象都不会被修改（返回的是浅拷贝），测试里钉住了这一条。
 */
export function applyToolbarConfig(
  tools: readonly ToolDefinition[],
  config: ToolbarConfig,
): ToolDefinition[] {
  const byId = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    // 同名 id 只认第一条：定义表的唯一性由 21AB 的 `toolListResponseSchema` 保证，
    // 这里只是不让重复 id 把 pinned 的顺序算出两种结果。
    if (!byId.has(tool.id)) byId.set(tool.id, tool);
  }

  /** pinned 依次对应的工具（已经是 main）。 */
  const pinned: ToolDefinition[] = [];
  const taken = new Set<string>();

  for (const id of config.pinned) {
    const tool = byId.get(id);
    // 未知 id：丢弃（裁决 3 第三条）。
    if (tool === undefined) continue;
    // 不可移除的工具：保持原 slot，pinned 里的这个 id 不生效。
    if (!tool.removable) continue;
    // 重复 id：只保留第一次出现的位置。
    if (taken.has(id)) continue;

    taken.add(id);
    pinned.push({ ...tool, default_slot: "main" });
  }

  /** 其余工具：可移除的一律进「更多」，不可移除的保持原 slot；相对顺序照入参。 */
  const rest: ToolDefinition[] = [];
  for (const tool of tools) {
    if (taken.has(tool.id)) continue;
    const slot: ToolSlot = tool.removable ? "more" : tool.default_slot;
    rest.push({ ...tool, default_slot: slot });
  }

  return [...pinned, ...rest];
}

/** `fitToolbar` 的入参：宽度全部由调用方量好（本单不碰 DOM，见文件头）。 */
export type FitToolbarInput = {
  /** 每一项的宽度，顺序 = 工具条上的显示顺序。 */
  itemWidths: readonly number[];
  /** 可用宽度：`viewportWidth − 2×24` 由调用方算好传进来（裁决 5）。 */
  maxWidth: number;
  /** 「更多」按钮本身的宽度。溢出时它要占一格，所以必须算进去。 */
  moreWidth: number;
  /** 相邻两项之间的间距。 */
  gap: number;
  /** 容器左右内边距（单侧；总占用是它的两倍）。 */
  paddingX: number;
};

/**
 * 溢出判定：返回工具条上**还能照常显示**的项数，其余从**末尾**开始挤进「更多」
 * （工单 §2 裁决 5 / 规格验收 3 的纯函数半边）。
 *
 * 两种布局的宽度公式（n 项、可见 k 项）：
 * - 全部放得下（`k = n`，「更多」不出现）：`2·paddingX + Σwidths + gap·(n−1)`；
 * - 溢出（可见 k 项 + 「更多」共 k+1 个元素）：`2·paddingX + Σ(前 k 项) + moreWidth + gap·k`。
 *
 * 判据是 `<= maxWidth`：**恰好相等算放得下**（工单 §3 T4 的边界用例）。
 *
 * 注意溢出时 k 会**小于**「不加『更多』时能放下的项数」—— 因为「更多」自己要占 32 宽，
 * 验收 3 的数值版（14 项）就是这个差：13 项不带「更多」放得下（1204），但溢出后最多只能
 * 显示 12 项（1148 ≤ 1232 < 1240）。算式见 `test/toolbar-config.test.ts`。
 */
export function fitToolbar({
  itemWidths,
  maxWidth,
  moreWidth,
  gap,
  paddingX,
}: FitToolbarInput): { visibleCount: number } {
  // 前缀和：prefix[i] = 前 i+1 项的和；越界取 undefined 时按 0 处理（k = 0 那一格）。
  const prefix: number[] = [];
  let sum = 0;
  for (const width of itemWidths) {
    sum += width;
    prefix.push(sum);
  }

  const count = itemWidths.length;
  const padding = paddingX * 2;

  // 1. 全部放得下：此时没有「更多」按钮，间隙是 n−1 个。
  const fullWidth = padding + sum + gap * Math.max(count - 1, 0);
  if (fullWidth <= maxWidth) return { visibleCount: count };

  // 2. 溢出：从末尾逐个挤进「更多」，取最大的、放得下的 k。
  for (let visible = count - 1; visible >= 0; visible -= 1) {
    const shownWidth = prefix[visible - 1] ?? 0;
    // 可见 visible 项 + 「更多」= visible+1 个元素 → visible 个间隙（k=0 时就是 0 个）。
    const width = padding + shownWidth + moreWidth + gap * visible;
    if (width <= maxWidth) return { visibleCount: visible };
  }

  // 连「更多」都放不下：一项都不显示（调用方仍然可以只渲染「更多」，取 0 时宽度不再是约束）。
  return { visibleCount: 0 };
}
