/**
 * ED-00a · 逐图工具条的位置（纯函数，不碰 DOM、不依赖 Excalidraw 类型）
 *
 * 工单 30Q §3 的第 3 条口径，逐条对应：
 *
 * 1. 先按 `angle` 算出**旋转后的轴对齐外接框**。Excalidraw 的 `x` / `y` 是旋转**之前**的
 *    左上角，旋转绕元素中心进行，所以外接框的中心恒等于 `(x + width/2, y + height/2)`，
 *    宽高是 `|w·cos| + |h·sin|` 与 `|w·sin| + |h·cos|`（与 `lib/flip-rotate.ts` 的
 *    `transformedSize` 同一条公式，两处都算「转完以后看起来多大」）。
 * 2. 工具条**水平居中**对齐外接框，放在外接框上沿上方 `8 + TOOLBAR_HEIGHT` 处
 *    （即与上沿留 8，再往上让出整条工具条的高度）。
 * 3. 上沿放不下（`y < 8`）就改放到外接框下沿下方 8，`placement` 变 `"below"`。
 * 4. `x` 夹在 `[8, viewportWidth − toolbarWidth − 8]`。
 *
 * ## 坐标系
 *
 * 入参与返回值都在**同一个坐标系**里：Excalidraw 容器坐标（`scrollX` / `scrollY` / `zoom`
 * 是 `appState` 里那一组，`el` 是场景坐标，函数内部按 `(scene + scroll) * zoom` 换算）。
 * `toolbarWidth` 由调用方测量后传入 —— jsdom 里宽度恒为 0，所以**测试只测这个纯函数**。
 *
 * ## 为什么高度从 `image-toolbar.tsx` import
 *
 * `TOOLBAR_HEIGHT = 44` 是 ED-00a 的尺寸常量，已经写在工具条组件里；这里再抄一份，
 * 以后改尺寸就会出现「工具条高了、间距还是旧的」这种只在浏览器里看得见的错位。
 */

import { TOOLBAR_HEIGHT } from "../components/canvas/image-toolbar";

/** 工具条与图片外接框之间、以及工具条与视口边缘之间的间距（px）。 */
export const TOOLBAR_MARGIN = 8;

/** 元素参与定位的那几个字段（Excalidraw 元素的结构子集）。 */
export type ImageToolbarElement = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 弧度。元素没有这个字段（或为 undefined）时按未旋转处理。 */
  angle?: number | undefined;
};

export type ImageToolbarPositionInput = {
  /** 选中的那张图（场景坐标）。 */
  el: ImageToolbarElement;
  scrollX: number;
  scrollY: number;
  zoom: number;
  /** 视口宽度，通常是 `appState.width`（Excalidraw 容器宽度）。 */
  viewportWidth: number;
  /** 工具条实测宽度。0 是合法值（jsdom / 还没量到）。 */
  toolbarWidth: number;
};

export type ImageToolbarPlacement = "above" | "below";

export type ImageToolbarPosition = {
  x: number;
  y: number;
  placement: ImageToolbarPlacement;
};

/**
 * 工具条位置。
 *
 * 注意 `x` 只取决于外接框的**中心**（居中对齐），而中心在旋转下不变 —— 所以旋转 90°
 * 只会改变 `y`（外接框的高变成了原来的宽）。这是「居中对齐」的必然结果，不是漏算。
 */
export function imageToolbarPosition(input: ImageToolbarPositionInput): ImageToolbarPosition {
  const { el, scrollX, scrollY, zoom, viewportWidth, toolbarWidth } = input;
  const angle = el.angle ?? 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // 旋转后的轴对齐外接框：半宽 / 半高。
  const halfWidth = (Math.abs(el.width * cos) + Math.abs(el.height * sin)) / 2;
  const halfHeight = (Math.abs(el.width * sin) + Math.abs(el.height * cos)) / 2;

  // 外接框中心（场景坐标）→ 容器坐标。
  const centerX = (el.x + el.width / 2 + scrollX) * zoom;
  const centerY = (el.y + el.height / 2 + scrollY) * zoom;

  const top = centerY - halfHeight * zoom;
  const bottom = centerY + halfHeight * zoom;

  // 上沿 → 工具条上沿。放不下就翻到下方（下方不再判是否放得下：翻下去也放不下时
  // 只能让工具条贴住底边，而 `y` 不参与夹边，所以不再做第二次翻转）。
  const aboveY = top - TOOLBAR_MARGIN - TOOLBAR_HEIGHT;
  const placement: ImageToolbarPlacement = aboveY < TOOLBAR_MARGIN ? "below" : "above";
  const y = placement === "above" ? aboveY : bottom + TOOLBAR_MARGIN;

  // 水平居中，再夹进视口。
  const centeredX = centerX - toolbarWidth / 2;
  // 视口比工具条还窄时上界会小于下界（`toolbarWidth = 0` 加宽视口不会走到，但窄窗口会），
  // 那时按「贴左边」处理 —— 溢出的部分只能留在视口外，两边不可能同时满足。
  const maxX = Math.max(TOOLBAR_MARGIN, viewportWidth - toolbarWidth - TOOLBAR_MARGIN);
  const x = Math.min(Math.max(centeredX, TOOLBAR_MARGIN), maxX);

  return { x, y, placement };
}
