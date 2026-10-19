/**
 * ED-02 · 裁剪的几何与校验能力层（工单 30J T3）
 *
 * 纯函数，**不 import React**：面板与叠层组件里不许出现几何算法，全部落在这里，
 * 这样「拖手柄改多少」这类规则可以脱离 DOM 直接复算。
 *
 * 坐标系一律是**原图像素**。屏幕位移要由调用方除以显示缩放比之后再交进来
 * （`CropOverlay` 收 `displayScale` 就是为了这一步），本文件不认屏幕坐标。
 *
 * 本文件写的是工单 §2 的裁决口径，逐条对应：
 *
 * - 裁决 5（比例联动取整）：`H = Math.round(W * rh / rw)`、`W = Math.round(H * rw / rh)`；
 *   选「通用」（`ratio: null`）时不联动。
 * - 裁决 6（选预设时框怎么放）：取原图内能放下的最大同比例矩形并**居中**，取整后再夹到原图内。
 * - 裁决 7（手改 W/H）：保持左上角不动；超出右边/下边时把框整体往左/往上平移。
 * - 裁决 8（「完成」不可点的原因优先级）：先宽、再高（取首个非法原因），最后才是「未做裁剪」。
 */

export type Size = { width: number; height: number };

/** 裁剪框：原图像素，整数。 */
export type CropRect = { x: number; y: number; width: number; height: number };

/**
 * 比例预设。**web 侧不写死任何预设**(裁决 4，X-P11 规定由服务端下发)：
 * 组件与纯函数都通过参数接收，测试用 fixture。
 */
export type SizePreset = { id: string; name: string; ratio: [number, number] | null };

/** 8 个手柄：四边 + 四角。`n`/`s`/`e`/`w` 是**边**手柄，`ne`/`nw`/`se`/`sw` 是**角**手柄。 */
export type CropHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** 8 个手柄的遍历顺序（给叠层渲染用；顺序只影响 DOM 顺序，不影响几何）。 */
export const CROP_HANDLES: readonly CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** 文案逐字照规格（§3-T3），三处不要改写。 */
const MUST_BE_POSITIVE_INTEGER = "必须是正整数";
const EXCEEDS_SOURCE_TEMPLATE = (axis: "宽度" | "高度", max: number) => `不能超过原图${axis} ${max}`;

/** 裁剪框等于整图时「完成」不可点的原因（ED-02 的 disabled rule 文案）。 */
export const NOT_CROPPED_REASON = "未做裁剪";

const POSITIVE_INT_RE = /^\d+$/;

function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/**
 * 校验 W/H 输入框的文本（§3-T3 的三条文案）。
 *
 * `0`、负数、小数、空串、非数字都返回「必须是正整数」—— **先判形状再判上限**：
 * 否则 `"2000.5"`（大于上限的小数）会报「不能超过原图宽度」，而它首先不是整数。
 */
export function validateDimension(
  raw: string,
  axis: "width" | "height",
  max: number,
): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!POSITIVE_INT_RE.test(trimmed)) return { ok: false, reason: MUST_BE_POSITIVE_INTEGER };

  const value = Number.parseInt(trimmed, 10);
  if (value <= 0) return { ok: false, reason: MUST_BE_POSITIVE_INTEGER };
  if (value > max) {
    return { ok: false, reason: EXCEEDS_SOURCE_TEMPLATE(axis === "width" ? "宽度" : "高度", max) };
  }
  return { ok: true, value };
}

/** 裁决 5：按比例从宽算高。 */
export function linkedHeight(width: number, ratio: [number, number]): number {
  return Math.round((width * ratio[1]) / ratio[0]);
}

/** 裁决 5：按比例从高算宽。 */
export function linkedWidth(height: number, ratio: [number, number]): number {
  return Math.round((height * ratio[0]) / ratio[1]);
}

/** 取整夹边后的矩形，顺手保证不越出原图（`x`/`y` 与右上/下边都夹一遍）。 */
function clampRect(rect: CropRect, source: Size): CropRect {
  const width = clampInt(rect.width, 1, source.width);
  const height = clampInt(rect.height, 1, source.height);
  return {
    x: clampInt(rect.x, 0, source.width - width),
    y: clampInt(rect.y, 0, source.height - height),
    width,
    height,
  };
}

/**
 * 裁决 6：选比例预设时框怎么放 —— 原图内能放下的最大同比例矩形，居中。
 *
 * `ratio: null`（通用）→ 整图。取整顺序是**先宽后高**：先按原图宽度贴满算高，
 * 放不下就改成按原图高度贴满算宽，这样 `1254×1254` 取 3:4 得 `{x:157,y:0,width:941,height:1254}`
 * （`Math.round(1254*3/4)=941`、`x=Math.round((1254-941)/2)=157`）。
 */
export function fitRatioRect(source: Size, ratio: [number, number] | null): CropRect {
  if (ratio === null) {
    return { x: 0, y: 0, width: source.width, height: source.height };
  }

  let width = source.width;
  let height = linkedHeight(width, ratio);
  if (height > source.height) {
    height = source.height;
    width = linkedWidth(height, ratio);
  }

  // 取整可能让宽高各多出 1（`Math.round` 向上），夹回原图；夹完再按比例补一次，尽量守住比例。
  const clampedWidth = Math.min(width, source.width);
  const clampedHeight = Math.min(height, source.height);

  return clampRect(
    {
      x: Math.round((source.width - clampedWidth) / 2),
      y: Math.round((source.height - clampedHeight) / 2),
      width: clampedWidth,
      height: clampedHeight,
    },
    source,
  );
}

/**
 * 裁决 7：W/H 数值合法后改裁剪框 —— **保持左上角不动**，
 * 超出右边或下边时把框整体往左/往上平移，直到放进原图。
 */
export function applyDimensions(rect: CropRect, width: number, height: number, source: Size): CropRect {
  return clampRect({ x: rect.x, y: rect.y, width, height }, source);
}

/** 整体平移：只夹边，不改尺寸。 */
export function moveRect(rect: CropRect, dx: number, dy: number, source: Size): CropRect {
  return clampRect({ x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height }, source);
}

/**
 * 联动用的上限换算。`Math.round` 不会把「≤ h 的宽算出来的高」抬过 `h`，
 * 所以 `floor` 出来的上限是安全的：`round(w*rh/rw) ≤ h` 对所有 `w ≤ floor(h*rw/rh)` 成立。
 */
function maxWidthForHeight(heightLimit: number, ratio: [number, number]): number {
  return Math.max(1, Math.floor((heightLimit * ratio[0]) / ratio[1]));
}

/** 对称于 {@link maxWidthForHeight}：宽定死时，高最多能到多少。 */
function maxHeightForWidth(widthLimit: number, ratio: [number, number]): number {
  return Math.max(1, Math.floor((widthLimit * ratio[1]) / ratio[0]));
}

/** 原图本身允许的最大宽度（再按比例联动出来的高也不能超）。 */
function maxWidthInSource(ratio: [number, number], source: Size): number {
  return Math.max(1, Math.min(source.width, maxWidthForHeight(source.height, ratio)));
}

/** 原图本身允许的最大高度。 */
function maxHeightInSource(ratio: [number, number], source: Size): number {
  return Math.max(1, Math.min(source.height, maxHeightForWidth(source.width, ratio)));
}

/**
 * 拖手柄改裁剪框。`dx`/`dy` 都是**原图像素**（调用方已除以显示缩放比）。
 *
 * 规则（§3-T3）：
 * - 宽高最小 1，结果不越出原图；
 * - 有比例时：**角手柄以宽的变化为准**、按比例联动出高；
 *   边手柄（`n`/`s`/`e`/`w`）只按它控制的那条边算，另一边按比例联动，并以**框中心对齐**；
 * - 无比例时：角手柄两条边各自独立变，边手柄只动那一条边。
 *
 * **夹边是「被拖的那条边停住」，不是把整个框往回推**：
 * 反过来推会让对面那条边跟着动，拖右下角时左上角会跑 —— 那不是拖拽该有的手感。
 */
export function resizeByHandle(
  rect: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  source: Size,
  ratio: [number, number] | null,
): CropRect {
  const movesE = handle.includes("e");
  const movesW = handle.includes("w");
  const movesS = handle.includes("s");
  const movesN = handle.includes("n");
  /** 角手柄 = 同时驱动两条轴（`e`/`w` 走宽这一支，`n`/`s` 走另一支）。 */
  const drivesWidth = movesE || movesW;

  // 裁剪框的四条边（对面那条边是拖动过程的锚）。
  const rectRight = rect.x + rect.width;
  const rectBottom = rect.y + rect.height;

  if (ratio === null) {
    let left = rect.x;
    let right = rectRight;
    let top = rect.y;
    let bottom = rectBottom;

    if (movesE) right = clampInt(rectRight + dx, rect.x + 1, source.width);
    if (movesW) left = clampInt(rect.x + dx, 0, rectRight - 1);
    if (movesS) bottom = clampInt(rectBottom + dy, rect.y + 1, source.height);
    if (movesN) top = clampInt(rect.y + dy, 0, rectBottom - 1);

    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  if (drivesWidth) {
    // 角手柄与 e/w 都走这条：以宽为准联动高（角手柄的 dy 被忽略，这是规格里明写的）。
    const requested = movesE ? rect.width + dx : rect.width - dx;
    // 横向可用空间：拖 e 时左边是锚（可用到原图右边），拖 w 时右边是锚。
    const horizontalSpace = movesE ? source.width - rect.x : rectRight;
    /**
     * 纵向可用空间：`n` 的锚在下边（可以往上长到 0），`s` 的锚在上边；
     * `e`/`w` 的高是被联动的、按中心对齐，所以整张原图的高度都能用。
     */
    const verticalSpace = movesN ? rectBottom : movesS ? source.height - rect.y : source.height;
    const cap = Math.min(
      maxWidthInSource(ratio, source),
      Math.floor(horizontalSpace),
      maxWidthForHeight(verticalSpace, ratio),
    );
    const width = clampInt(requested, 1, Math.max(1, cap));
    const height = Math.min(source.height, linkedHeight(width, ratio));
    const x = movesW ? rectRight - width : rect.x;
    let y = rect.y;
    if (movesN) y = rectBottom - height;
    // `e`/`w` 是边手柄：联动出来的高以框中心对齐（§3-T3）。
    else if (!movesS) y = Math.round(rect.y + (rect.height - height) / 2);
    return clampRect({ x, y, width, height }, source);
  }

  const requestedHeight = movesS ? rect.height + dy : rect.height - dy;
  const verticalSpace = movesS ? source.height - rect.y : rectBottom;
  const cap = Math.min(
    maxHeightInSource(ratio, source),
    Math.floor(verticalSpace),
    maxHeightForWidth(source.width, ratio),
  );
  const height = clampInt(requestedHeight, 1, Math.max(1, cap));
  const width = Math.min(source.width, linkedWidth(height, ratio));
  // 边手柄的联动那一轴按「以框中心对齐」放。
  const x = Math.round(rect.x + (rect.width - width) / 2);
  const y = movesN ? rectBottom - height : rect.y;
  return clampRect({ x, y, width, height }, source);
}

/** 裁剪框是否等于整图（`未做裁剪` 的判据）。 */
export function isFullImage(rect: CropRect, source: Size): boolean {
  return (
    rect.x === 0 && rect.y === 0 && rect.width === source.width && rect.height === source.height
  );
}

/**
 * 裁决 8：「完成」按钮不可点的原因。
 *
 * 优先级：**先宽、再高**（取首个非法原因），最后才是「未做裁剪」；
 * 三样都不成立时返回 `null`，表示可以点。
 */
export function doneDisabledReason(
  widthRaw: string,
  heightRaw: string,
  rect: CropRect,
  source: Size,
): string | null {
  const width = validateDimension(widthRaw, "width", source.width);
  if (!width.ok) return width.reason;
  const height = validateDimension(heightRaw, "height", source.height);
  if (!height.ok) return height.reason;
  if (isFullImage(rect, source)) return NOT_CROPPED_REASON;
  return null;
}

/** 导出用的原图矩形：取整一遍（面板里为了拖动平顺可能留着小数）。 */
export function cropSourceRect(rect: CropRect): CropRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * 导出：把裁剪框那一块画到 `(0, 0)` 的 `w×h` 画布上。
 * 只调用一次 `drawImage`，源矩形就是 {@link cropSourceRect} 的结果。
 */
export function drawCrop(
  ctx: Pick<CanvasRenderingContext2D, "drawImage">,
  img: CanvasImageSource,
  rect: CropRect,
): void {
  const source = cropSourceRect(rect);
  ctx.drawImage(img, source.x, source.y, source.width, source.height, 0, 0, source.width, source.height);
}
