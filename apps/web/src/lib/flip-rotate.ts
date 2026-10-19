/**
 * ED-03 · 翻转与旋转的能力层（工单 30J T1）
 *
 * 纯函数，**不 import React、不 import Excalidraw**：本单不接入画布，
 * 与画布元素（`angle` 弧度 + `scale` 正负）的互转只在这里做一次，
 * 接入那张单直接调这几个函数即可。
 *
 * 本文件写的是工单 §2 的裁决口径，逐条对应：
 *
 * 1. **角度取值**：规格正文写「接受 −360~360 的整数」，验收第 3 条却写「输入 450 → 归一为 90」，
 *    两处以**验收**为准 —— 接受任意整数，按 `((n % 360) + 360) % 360` 归一到 `[0, 360)`。
 *    小数、空串、非数字一律非法；允许首尾空白与末尾一个 `°`。
 *    所以 `-90` → 270、`"90°"` → 90、`"12.5"` → `null`。规格正文的修订登记为 T-62。
 * 2. **文件名后缀顺序**：`_flipH`、`_flipV`、`_rot{角度}`，没有变换的项不拼，最后接原扩展名。
 * 3. **水平翻转 + 垂直翻转不合并成 180°**：视觉上等价，但按字面状态生成文件名与矩阵。
 */

/** 翻转与旋转状态。`angle` 一定在 `[0, 360)` 里且是整数。 */
export type FlipRotateState = {
  /** 角度，单位**度**，取值 `[0, 360)` 的整数。 */
  angle: number;
  /** 水平翻转（左右镜像）。 */
  flipH: boolean;
  /** 垂直翻转（上下镜像）。 */
  flipV: boolean;
};

/** 与画布元素互转用的变换：Excalidraw 的 `angle` 是**弧度**，`scale` 用正负表示翻转。 */
export type ElementTransform = {
  /** 弧度。 */
  angle: number;
  /** `[x, y]`，`-1` 表示该轴翻转。 */
  scale: [number, number];
};

const FULL_TURN = 360;

/**
 * 把任意数值归一到 `[0, 360)`。
 *
 * 两处偏移都必要：`%` 在 JS 里对负数返回负值（`-90 % 360 === -90`），先 `+ 360` 再取模才落到正区间；
 * 末了把 `-0` 折成 `0`，否则 `JSON.stringify` / 快照断言里会冒出 `-0`。
 */
export function normalizeAngle(n: number): number {
  const wrapped = ((n % FULL_TURN) + FULL_TURN) % FULL_TURN;
  return wrapped === 0 ? 0 : wrapped;
}

/**
 * 整数角度输入的形状：可带正负号、纯数字、末尾至多一个 `°`。
 * 小数（`12.5`）、空串、非数字都在正则这一步就被拒掉，落到 `null`。
 */
const ANGLE_INPUT_RE = /^[+-]?\d+°?$/;

/**
 * 解析角度输入框的文本（裁决 1）。
 *
 * 合法 → 返回**已归一**的整数（`450` → 90、`-90` → 270、`360` → 0）；
 * 非法 → `null`，调用方负责把输入框恢复成原值、且不触发 `onChange`。
 *
 * 允许首尾空白（`" 45 "` → 45）与末尾一个 `°`（`"90°"` → 90）。
 * 注意 `"45 °"` 是**非法**的：`°` 必须紧跟数字，中间夹空格算格式错误。
 */
export function parseAngleInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!ANGLE_INPUT_RE.test(trimmed)) return null;
  const digits = trimmed.endsWith("°") ? trimmed.slice(0, -1) : trimmed;
  // `digits` 已被正则保证是 `[+-]?\d+`，`parseInt` 不会失败。
  return normalizeAngle(Number.parseInt(digits, 10));
}

/** 顺时针转 90°（每次旋转按钮调的），结果已归一。 */
export function rotateStep(state: FlipRotateState): FlipRotateState {
  return { ...state, angle: normalizeAngle(state.angle + 90) };
}

/** 按轴切换翻转。`"h"` 是水平（左右镜像），`"v"` 是垂直（上下镜像）。 */
export function toggleFlip(state: FlipRotateState, axis: "h" | "v"): FlipRotateState {
  return axis === "h" ? { ...state, flipH: !state.flipH } : { ...state, flipV: !state.flipV };
}

/** 状态 → 画布元素变换。flipH 对应 `scale[0] = -1`，flipV 对应 `scale[1] = -1`；度数转弧度。 */
export function toElementTransform(state: FlipRotateState): ElementTransform {
  return {
    angle: (state.angle * Math.PI) / 180,
    scale: [state.flipH ? -1 : 1, state.flipV ? -1 : 1],
  };
}

/**
 * 画布元素变换 → 状态。
 *
 * 弧度转回度数后 `Math.round` 再归一：`90 * Math.PI / 180` 的反算是 `90.00000000000001`，
 * 不取整就得到带小数的角度。它与 {@link toElementTransform} 必须能往返还原（测试穷举 16 组）。
 */
export function fromElementTransform(t: ElementTransform): FlipRotateState {
  return {
    angle: normalizeAngle(Math.round((t.angle * 180) / Math.PI)),
    flipH: t.scale[0] < 0,
    flipV: t.scale[1] < 0,
  };
}

/** 文件名后缀的拼接顺序（裁决 2）：`_flipH` → `_flipV` → `_rot{角度}`。 */
function fileSuffixParts(state: FlipRotateState): string[] {
  const parts: string[] = [];
  if (state.flipH) parts.push("flipH");
  if (state.flipV) parts.push("flipV");
  // 角度为 0 视作「没有旋转」：不拼 `_rot0`。
  if (state.angle !== 0) parts.push(`rot${state.angle}`);
  return parts;
}

/**
 * 变换后的下载文件名（裁决 2）。
 *
 * `cat.png` + flipH + 90° → `cat_flipH_rot90.png`；没有任何变换 → 原文件名；
 * 没有扩展名（或名字本身就是 `.png` 这种）→ 后缀直接接在末尾。
 */
export function transformedFileName(name: string, state: FlipRotateState): string {
  const parts = fileSuffixParts(state);
  if (parts.length === 0) return name;

  const dot = name.lastIndexOf(".");
  // `dot <= 0` 覆盖三种情况：没有点、点在最前（`.gitignore` 这种隐藏名没有扩展名）。
  const hasExtension = dot > 0 && dot < name.length - 1;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  return `${base}_${parts.join("_")}${extension}`;
}

/**
 * 旋转后的外接矩形尺寸（导出用）。
 *
 * `|w·cos| + |h·sin|` 与 `|w·sin| + |h·cos|` 再 `Math.round`：
 * 90°/270° 时宽高互换，0°/180° 时不变；取整是为了抹掉 `cos(90°) ≈ 6.1e-17` 这种浮点残差。
 */
export function transformedSize(w: number, h: number, angle: number): { width: number; height: number } {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    width: Math.round(Math.abs(w * cos) + Math.abs(h * sin)),
    height: Math.round(Math.abs(w * sin) + Math.abs(h * cos)),
  };
}

/**
 * 导出：把一张 `w×h` 的图画进「旋转后的外接矩形」里。
 *
 * 只调两次画布 API —— 一次 `setTransform`（平移到输出中心 → 旋转 → 缩放 ±1），
 * 一次 `drawImage`（以**原图中心**为原点画）。测试用记录调用的假 ctx 断言这两次调用，
 * 并把矩阵作用到原图的 4 个角上验证都落在输出框内。
 *
 * 矩阵按画布的 `(a, b, c, d, e, f)` 约定：
 * `x' = a·x + c·y + e`、`y' = b·x + d·y + f`，所以平移进 `e`/`f`。
 */
export function drawTransformed(
  ctx: Pick<CanvasRenderingContext2D, "setTransform" | "drawImage">,
  img: CanvasImageSource,
  w: number,
  h: number,
  state: FlipRotateState,
): void {
  const out = transformedSize(w, h, state.angle);
  const radians = (state.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const scaleX = state.flipH ? -1 : 1;
  const scaleY = state.flipV ? -1 : 1;

  ctx.setTransform(cos * scaleX, sin * scaleX, -sin * scaleY, cos * scaleY, out.width / 2, out.height / 2);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
}
