/**
 * ED-00d · 面板定位（纯函数，不碰 DOM）
 *
 * 规格：面板默认出现在选中对象**右侧**；右侧放不下放左侧；两侧都放不下放下方。
 * 面板不得超出视口。ED-00d 验收 1 是「对象贴着画布右边缘时，面板出现在左侧且完整在视口内」。
 *
 * 不引第三方定位库（floating-ui 等）：要装包，被工单禁止，而且这条规则自己写只要十几行。
 *
 * 坐标系与入参一致：`anchor` / `viewport` / 返回值都是同一个坐标系里的像素值
 * （调用方要么全用视口坐标，要么全用画布坐标，本模块不做换算），`gap` 也是同一单位。
 */

export type Rect = { x: number; y: number; width: number; height: number };

/** 面板尺寸。与 `Rect` 分开写，是因为面板只要宽高，没有自己的位置。 */
export type PanelSize = { width: number; height: number };

export type PanelSide = "right" | "left" | "below";

export type PanelPlacement = { side: PanelSide; x: number; y: number };

/** 面板与锚点之间的默认间距（px）。 */
export const PANEL_GAP = 8;

export type PlacePanelInput = {
  /** 锚点矩形：通常是选中对象在视口里的包围盒。 */
  anchor: Rect;
  /** 面板尺寸。 */
  panel: PanelSize;
  /** 视口矩形：通常是画布容器的 `getBoundingClientRect()`。 */
  viewport: Rect;
  /** 面板与锚点的间距，默认 `PANEL_GAP`（8）。 */
  gap?: number;
};

/**
 * 把一轴上的坐标压进 `[start, start + length - size]`。
 *
 * 面板比视口还大时（`start + length - size < start`），上界会小于下界。
 * 这时按规格「贴左上角」处理：钳到 `start`（左 / 上边缘），
 * 溢出的部分只能留在视口外 —— 视口比面板还小，两边不可能同时满足。
 */
function clampAxis(value: number, start: number, length: number, size: number): number {
  const upper = Math.max(start + length - size, start);
  if (!Number.isFinite(value)) return start;
  return Math.min(Math.max(value, start), upper);
}

/**
 * 算面板位置。
 *
 * 三步选边（**只按水平方向选 right → left**，两侧都不行才落到下方）：
 * 1. 右侧：`x = anchor.x + anchor.width + gap`，要满足 `x + panel.width <= 视口右边`；
 * 2. 左侧：`x = anchor.x - gap - panel.width`，要满足 `x >= 视口左边`；
 * 3. 下方：`y = anchor.y + anchor.height + gap`（不再判是否放得下）。
 *
 * 三种情况最后都把 x / y 钳制回视口内，保证**结果完整落在 viewport 里**
 * （唯一例外是面板比视口大，见 `clampAxis` 的注释）。
 */
export function placePanel(input: PlacePanelInput): PanelPlacement {
  const { anchor, panel, viewport } = input;
  const gap = input.gap ?? PANEL_GAP;

  const viewportRight = viewport.x + viewport.width;
  const viewportBottom = viewport.y + viewport.height;

  const rightX = anchor.x + anchor.width + gap;
  const leftX = anchor.x - gap - panel.width;
  const belowY = anchor.y + anchor.height + gap;

  let side: PanelSide;
  let x: number;
  let y: number;

  if (rightX + panel.width <= viewportRight) {
    side = "right";
    x = rightX;
    y = anchor.y;
  } else if (leftX >= viewport.x) {
    side = "left";
    x = leftX;
    y = anchor.y;
  } else {
    side = "below";
    x = anchor.x;
    y = belowY;
  }

  return {
    side,
    x: clampAxis(x, viewport.x, viewport.width, panel.width),
    y: clampAxis(y, viewport.y, viewport.height, panel.height),
  };
}
