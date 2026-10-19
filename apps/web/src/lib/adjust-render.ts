/**
 * ED-01 · 调整（adjust）的渲染内核（工单 30K T1）
 *
 * 纯函数，不碰 DOM、不碰 canvas：进出的都是 `PixelBuffer` —— 与 `ImageData` 结构兼容的
 * RGBA 缓冲（`width` / `height` / `data`），接入单自己负责取放像素，本文件不引用任何画布 API。
 *
 * 预览（降采样后）与导出（原尺寸）调用的是**同一个** `renderAdjust`：全仓只有这一份渲染实现。
 *
 * ## 渲染域与固定顺序（工单 §2 裁决 3）
 *
 * 每个像素先转成 [0,1] 浮点 RGB，按下表顺序逐步处理，最后夹回 [0,255] 取整；alpha 原样保留：
 *
 *   1 exposure → 2 light → 3 contrast → 4 highlights → shadows
 *   → 5 whites → blacks → 6 temperature → tint → 7 vibrance → saturation
 *   → 8 clarity → 9 sharpen → 10 glamour → 11 bloom → 12 vignette → 13 grain
 *
 * 前 11 项都是**逐像素**的（只看本像素），所以合成一趟循环：「先对全图做 A、再对全图做 B」
 * 与「每个像素依次做 A、B」逐字节等价。后 6 项里 clarity / sharpen / glamour / bloom 是邻域算子，
 * vignette 依赖坐标，grain 依赖坐标哈希，各自单独一遍。
 *
 * ## 各项公式（"具体实现由执行方定" —— 工单 §2 裁决 4）
 *
 * 记 t = v/100（v 为滑块的内部值），逐通道 x ∈ [0,1]，Y = Rec.709 亮度：
 *
 * | 参数 | 公式 | 性质 |
 * |---|---|---|
 * | exposure | x × 2^t | 规格点名 |
 * | light | x + 0.25t | 三通道同值加法 |
 * | contrast | 0.5 + (x − 0.5) × (1 + t) | 绕中灰线性拉伸，标准差按 (1+t) 缩放 |
 * | highlights | x × (1 + 0.5t·w(Y)) | w = smoothstep(0.25, 1, Y)：暗部 w=0，变化恒为 0 |
 * | shadows | x + 0.25t·w(Y) | w = smoothstep(0.75, 0.25, Y)：亮部 w=0，变化恒为 0 |
 * | whites | x + 0.25t·smoothstep(0.5, 1, Y) | |
 * | blacks | x + 0.25t·smoothstep(0.5, 0, Y) | |
 * | temperature | R + 0.15t、B − 0.15t | t>0 时 R 升 B 降 |
 * | tint | G − 0.15t | t>0 时 G 降（偏洋红） |
 * | vibrance | k = 1 + t·(1 − 本像素色度)，x ← Y + (x − Y)k | 低色度提得多，满色度不动 |
 * | saturation | k = 1 + t，x ← Y + (x − Y)k | t = −1 时三通道都等于 Y |
 * | clarity | x + t·(x − blur_r)，r = radius(16) | |
 * | sharpen | x + 0.8t·(x − blur_r)，r = radius(4) | |
 * | glamour | x + 0.6t·(blur_r − x)，r = radius(24) | |
 * | bloom | e = max(0, x − 0.6)；x + 1.5t·blur_r(e)，r = radius(40) | |
 * | vignette | x × (1 + 0.6t·d²) | d² 以中心为 0、四角为 1：中心像素变化恒为 0 |
 * | grain | x + 0.12t·(hash(x,y) − 0.5) | 确定性：同一输入跑两次逐字节相等 |
 *
 * 四个色调权重由 `toneWeight()` 给出（`adjust-auto` 反解建议值时调的就是它）；
 * 渲染的热循环里是同一个三次多项式的内联写法，两份式子的一致性由测试钉住，
 * 这样「写回滑块的数字」和「渲染用的曲线」不会各走一套。
 *
 * ## 邻域半径与短边成比例（ED-01 验收 3 的前提）
 *
 * radius(k) = max(1, round(k × min(w, h) / 1000))，k 见 `NEIGHBOUR_RADIUS_K`。
 * 半径跟着短边缩放，降采样后的预览才和原尺寸导出看起来一致；
 * 常数取大一些（16 / 24 / 40）是为了让 64px 预览的整数半径与原尺寸大致成同一倍数。
 */

export type AdjustParamId =
  | "light"
  | "exposure"
  | "contrast"
  | "highlights"
  | "shadows"
  | "whites"
  | "blacks"
  | "vibrance"
  | "saturation"
  | "temperature"
  | "tint"
  | "sharpen"
  | "clarity"
  | "grain"
  | "vignette"
  | "glamour"
  | "bloom";

/** 17 个参数的取值表（单位：滑块内部值，全部为整数语义）。 */
export type AdjustParams = Readonly<Record<AdjustParamId, number>>;

/**
 * 17 个参数，**顺序同规格表**（光 7 → 色 4 → 效果 6）。
 *
 * 注意这只是「参数表顺序」，渲染顺序是另一份（见文件头的 13 步）：规格里两边要求的次序不同，
 * 不能拿本数组当渲染顺序用。
 */
export const ADJUST_PARAM_IDS: readonly AdjustParamId[] = [
  "light",
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "vibrance",
  "saturation",
  "temperature",
  "tint",
  "sharpen",
  "clarity",
  "grain",
  "vignette",
  "glamour",
  "bloom",
];

/** 全 0 = 恒等变换。`isZeroAdjust` 为真时 `renderAdjust` 直接返回输入的副本。 */
export const ZERO_ADJUST: AdjustParams = Object.freeze({
  light: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  sharpen: 0,
  clarity: 0,
  grain: 0,
  vignette: 0,
  glamour: 0,
  bloom: 0,
});

/** 与 `ImageData` 结构兼容的 RGBA 缓冲（`data` 是 `width × height × 4` 字节）。 */
export type PixelBuffer = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

/** 四个色调权重的种类（与 `toneWeight` / `TONE_SHIFT_GAIN` 对应）。 */
export type ToneKind = "highlights" | "shadows" | "whites" | "blacks";

// --- 公式常数（全部写在一处，改公式只改这里） --------------------------------

/** Rec.709 亮度权重（`adjust-auto` 算直方图用的是同一组）。 */
export const LUMA_WEIGHTS = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/** 字节 → [0,1] 的乘法倒数（热路径上用乘法代替除法）。 */
const BYTE_TO_UNIT = 1 / 255;

/** 邻域类参数的半径系数 k，半径 = max(1, round(k × min(w,h) / 1000))。 */
export const NEIGHBOUR_RADIUS_K = {
  clarity: 16,
  sharpen: 4,
  glamour: 24,
  bloom: 40,
} as const;

/** 同一个色调权重函数在渲染（乘/加）时用的幅度。 */
export const TONE_SHIFT_GAIN: Readonly<Record<ToneKind, number>> = Object.freeze({
  highlights: 0.5,
  shadows: 0.25,
  whites: 0.25,
  blacks: 0.25,
});

/** 四个色调权重的过渡区间（与 `toneWeight` 一一对应）。 */
export const TONE_EDGE: Readonly<Record<ToneKind, readonly [number, number]>> = Object.freeze({
  highlights: [0.25, 1] as const,
  shadows: [0.75, 0.25] as const,
  whites: [0.5, 1] as const,
  blacks: [0.5, 0] as const,
});

/** contrast / saturation 的斜率幅度：k = 1 + gain × t。 */
export const CONTRAST_GAIN = 1;
export const SATURATION_GAIN = 1;
/** light / temperature / tint 的加法幅度（每 100 个单位）。 */
const LIGHT_GAIN = 0.25;
const TEMPERATURE_GAIN = 0.15;
const TINT_GAIN = 0.15;
/** vibrance 的低色度加权幅度。 */
const VIBRANCE_GAIN = 1;
/** 邻域类的混合幅度。 */
const CLARITY_GAIN = 1;
const SHARPEN_GAIN = 0.8;
const GLAMOUR_GAIN = 0.6;
/** bloom 的提亮门槛与幅度。 */
const BLOOM_THRESHOLD = 0.6;
const BLOOM_GAIN = 1.5;
/** vignette 的四角幅度（四角 d²=1 时：1 + 0.6t）。 */
const VIGNETTE_GAIN = 0.6;
/** grain 的最大偏移（±0.5 × 0.12 = ±3.06% ≈ ±8/255）与固定种子。 */
const GRAIN_GAIN = 0.12;
const GRAIN_SEED = 0x9e3779b9;

// --- 小工具 ------------------------------------------------------------------

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 与 GLSL `smoothstep` 同式：`x ≤ edge0` 给 0，`x ≥ edge1` 给 1，中间 3t²−2t³。
 * `edge0 > edge1` 时是反方向（`shadows` 用它：暗部给 1、亮部给 0）。
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * 四个色调权重（0~1）。`luma` 传 [0,1] 的 Rec.709 亮度，越界会先夹住。
 *
 * 权重只在 `TONE_EDGE` 的区间里有过渡，所以 `highlights` 的权重在 Y ≤ 0.25 时**恰好为 0**、
 * `shadows` 的权重在 Y ≥ 0.75 时**恰好为 0** —— 工单 §2 裁决 4 那两条「±1 以内」的性质靠它成立。
 */
export function toneWeight(kind: ToneKind, luma: number): number {
  const [edge0, edge1] = TONE_EDGE[kind];
  return smoothstep(edge0, edge1, clamp01(luma));
}

function lumaOf(r: number, g: number, b: number): number {
  return LUMA_WEIGHTS.r * r + LUMA_WEIGHTS.g * g + LUMA_WEIGHTS.b * b;
}

/** 邻域半径：与图像短边成比例，至少 1 像素。 */
export function neighbourhoodRadius(k: number, width: number, height: number): number {
  return Math.max(1, Math.round((k * Math.min(width, height)) / 1000));
}

/**
 * 确定性伪随机：以像素坐标与固定种子做整数哈希，返回 [0,1)。
 *
 * 不用 `Math.random()`：grain 要求「同一输入运行两次，输出逐字节相等」，
 * 而且预览和导出必须各自独立算出同一份噪声。
 */
function grainNoise(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + GRAIN_SEED) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 65536) / 65536;
}

// --- 盒式模糊（可分离，边缘收缩窗口） ----------------------------------------

/**
 * 单通道盒式平均；`radius` 是半径像素（窗口 = 2r+1，边缘处窗口自动收缩）。
 *
 * 可分离：先横后纵各一次一维窗口平均，O(n)（前缀和，不随半径变慢）。
 */
function boxBlurPlane(
  plane: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (radius <= 0) return plane.slice();

  const horizontal = new Float32Array(plane.length);
  const prefix = new Float64Array(width + 1);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width;
    prefix[0] = 0;
    for (let x = 0; x < width; x += 1) {
      prefix[x + 1] = prefix[x]! + plane[rowStart + x]!;
    }
    for (let x = 0; x < width; x += 1) {
      const lo = Math.max(0, x - radius);
      const hi = Math.min(width - 1, x + radius);
      horizontal[rowStart + x] = (prefix[hi + 1]! - prefix[lo]!) / (hi - lo + 1);
    }
  }

  const out = new Float32Array(plane.length);
  const columnPrefix = new Float64Array(height + 1);
  for (let x = 0; x < width; x += 1) {
    columnPrefix[0] = 0;
    for (let y = 0; y < height; y += 1) {
      columnPrefix[y + 1] = columnPrefix[y]! + horizontal[y * width + x]!;
    }
    for (let y = 0; y < height; y += 1) {
      const lo = Math.max(0, y - radius);
      const hi = Math.min(height - 1, y + radius);
      out[y * width + x] = (columnPrefix[hi + 1]! - columnPrefix[lo]!) / (hi - lo + 1);
    }
  }
  return out;
}

// --- 逐像素链（固定顺序） ----------------------------------------------------

/**
 * 前 11 项：exposure → light → contrast → highlights → shadows → whites → blacks
 * → temperature → tint → vibrance → saturation。
 *
 * 系数在循环外算一次；`=== 0` 的项整段跳过 —— 全 0 时这一趟只剩两处恒等变换，
 * 这正是「全 0 恒等」的实现。
 *
 * 1~3 三项都是「逐通道、三通道同系数」的仿射变换，合成一次 `a·x + b` 再算
 * （数学上与按序逐步处理等价，省掉 6 次浮点运算；三者全为 0 时 a=1、b=0，仍逐字节恒等）。
 * 四个色调权重用的过渡区间与它们的倒数在循环外读进局部变量，循环里是 `smoothstep` 的三次多项式
 * 内联写法 —— 不在每像素上做字符串键查表、也不做除法。两份式子由测试钉成一致。
 */
function applyPerPixel(
  red: Float32Array,
  green: Float32Array,
  blue: Float32Array,
  count: number,
  params: AdjustParams,
): void {
  const exposure = params.exposure;
  const light = params.light;
  const contrast = params.contrast;
  const highlights = params.highlights;
  const shadows = params.shadows;
  const whites = params.whites;
  const blacks = params.blacks;
  const temperature = params.temperature;
  const tint = params.tint;
  const vibrance = params.vibrance;
  const saturation = params.saturation;

  const exposureGain = exposure === 0 ? 1 : 2 ** (exposure / 100);
  const lightShift = (light / 100) * LIGHT_GAIN;
  const contrastGain = contrast === 0 ? 1 : 1 + (contrast / 100) * CONTRAST_GAIN;
  const affineScale = exposureGain * contrastGain;
  const affineOffset = contrastGain * lightShift + 0.5 * (1 - contrastGain);
  const affineActive = exposure !== 0 || light !== 0 || contrast !== 0;

  const [highlightEdge0, highlightEdge1] = TONE_EDGE.highlights;
  const [shadowEdge0, shadowEdge1] = TONE_EDGE.shadows;
  const [whiteEdge0, whiteEdge1] = TONE_EDGE.whites;
  const [blackEdge0, blackEdge1] = TONE_EDGE.blacks;
  // 过渡区间的倒数（1/(edge1−edge0)）在循环外算好：循环里用乘法代替除法。
  // 循环体把 smoothstep 的三次多项式直接写开（与导出的 `smoothstep` 同式，
  // 一致性由 `test/adjust-render.test.ts` 里那条「与 toneWeight 一致」的用例钉住）。
  const highlightInv = 1 / (highlightEdge1 - highlightEdge0);
  const shadowInv = 1 / (shadowEdge1 - shadowEdge0);
  const whiteInv = 1 / (whiteEdge1 - whiteEdge0);
  const blackInv = 1 / (blackEdge1 - blackEdge0);

  const highlightsSpan = (highlights / 100) * TONE_SHIFT_GAIN.highlights;
  const shadowsShift = (shadows / 100) * TONE_SHIFT_GAIN.shadows;
  const whitesShift = (whites / 100) * TONE_SHIFT_GAIN.whites;
  const blacksShift = (blacks / 100) * TONE_SHIFT_GAIN.blacks;
  const temperatureShift = (temperature / 100) * TEMPERATURE_GAIN;
  const tintShift = (tint / 100) * TINT_GAIN;
  const vibranceAmount = (vibrance / 100) * VIBRANCE_GAIN;
  const saturationGain = 1 + (saturation / 100) * SATURATION_GAIN;

  for (let i = 0; i < count; i += 1) {
    let r = red[i]!;
    let g = green[i]!;
    let b = blue[i]!;

    if (affineActive) {
      r = r * affineScale + affineOffset;
      g = g * affineScale + affineOffset;
      b = b * affineScale + affineOffset;
    }

    if (highlights !== 0) {
      // 乘性、只压/提亮部：权重在 Y ≤ 0.25 处恰好为 0。
      const t = clamp01((lumaOf(r, g, b) - highlightEdge0) * highlightInv);
      const gain = 1 + highlightsSpan * t * t * (3 - 2 * t);
      r *= gain;
      g *= gain;
      b *= gain;
    }

    if (shadows !== 0) {
      const t = clamp01((lumaOf(r, g, b) - shadowEdge0) * shadowInv);
      const shift = shadowsShift * t * t * (3 - 2 * t);
      r += shift;
      g += shift;
      b += shift;
    }

    if (whites !== 0 || blacks !== 0) {
      const y = lumaOf(r, g, b);
      if (whites !== 0) {
        const t = clamp01((y - whiteEdge0) * whiteInv);
        const shift = whitesShift * t * t * (3 - 2 * t);
        r += shift;
        g += shift;
        b += shift;
      }
      if (blacks !== 0) {
        const t = clamp01((y - blackEdge0) * blackInv);
        const shift = blacksShift * t * t * (3 - 2 * t);
        r += shift;
        g += shift;
        b += shift;
      }
    }

    if (temperature !== 0) {
      r += temperatureShift;
      b -= temperatureShift;
    }

    if (tint !== 0) {
      g -= tintShift;
    }

    if (vibrance !== 0 || saturation !== 0) {
      // vibrance / saturation 都只改「围绕亮度的偏离」，而它们各自都保持亮度不变
      // （Σ 权重 = 1），所以这一对共用同一次亮度计算。
      const y = lumaOf(r, g, b);
      if (vibrance !== 0) {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        // 色度：本像素偏离灰的程度；满色度时 k = 1（不动），低色度提得多。
        const chroma = clamp01(max - min);
        const k = 1 + vibranceAmount * (1 - chroma);
        r = y + (r - y) * k;
        g = y + (g - y) * k;
        b = y + (b - y) * k;
      }
      if (saturation !== 0) {
        r = y + (r - y) * saturationGain;
        g = y + (g - y) * saturationGain;
        b = y + (b - y) * saturationGain;
      }
    }

    red[i] = r;
    green[i] = g;
    blue[i] = b;
  }
}

// --- 邻域链（固定顺序：clarity → sharpen → glamour → bloom） ----------------

/** 反锐化：x ← x + amount × (x − blur)。 */
function unsharpInPlace(
  planes: readonly [Float32Array, Float32Array, Float32Array],
  width: number,
  height: number,
  radius: number,
  amount: number,
): void {
  for (const plane of planes) {
    const blurred = boxBlurPlane(plane, width, height, radius);
    for (let i = 0; i < plane.length; i += 1) {
      plane[i] = plane[i]! + amount * (plane[i]! - blurred[i]!);
    }
  }
}

/** glamour：向模糊版靠拢（软化的幅度由 amount 定）。 */
function softenInPlace(
  planes: readonly [Float32Array, Float32Array, Float32Array],
  width: number,
  height: number,
  radius: number,
  amount: number,
): void {
  for (const plane of planes) {
    const blurred = boxBlurPlane(plane, width, height, radius);
    for (let i = 0; i < plane.length; i += 1) {
      plane[i] = plane[i]! + amount * (blurred[i]! - plane[i]!);
    }
  }
}

/** bloom：取高亮余量、模糊后加回去。 */
function bloomInPlace(
  planes: readonly [Float32Array, Float32Array, Float32Array],
  width: number,
  height: number,
  radius: number,
  amount: number,
): void {
  for (const plane of planes) {
    const excess = new Float32Array(plane.length);
    for (let i = 0; i < plane.length; i += 1) {
      const value = plane[i]! - BLOOM_THRESHOLD;
      excess[i] = value > 0 ? value : 0;
    }
    const blurred = boxBlurPlane(excess, width, height, radius);
    for (let i = 0; i < plane.length; i += 1) {
      plane[i] = plane[i]! + amount * blurred[i]!;
    }
  }
}

// --- 对外 API ----------------------------------------------------------------

/** 17 项是否全为 0（= 恒等）。 */
export function isZeroAdjust(params: AdjustParams): boolean {
  for (const id of ADJUST_PARAM_IDS) {
    if (params[id] !== 0) return false;
  }
  return true;
}

/**
 * 按固定顺序渲染一帧。**不改 `src`**，返回新缓冲。
 *
 * 17 项全为 0 时直接返回副本（恒等），这条与「逐项跳过」是同一个结果，只是省掉浮点往返。
 */
export function renderAdjust(src: PixelBuffer, params: AdjustParams): PixelBuffer {
  const { width, height, data } = src;
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);

  if (isZeroAdjust(params)) {
    out.set(data);
    return { width, height, data: out };
  }

  const red = new Float32Array(count);
  const green = new Float32Array(count);
  const blue = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const offset = i * 4;
    // 乘 1/255 而不是除 255：这一步跑 3×像素数次，除法在热路径上明显更慢
    red[i] = data[offset]! * BYTE_TO_UNIT;
    green[i] = data[offset + 1]! * BYTE_TO_UNIT;
    blue[i] = data[offset + 2]! * BYTE_TO_UNIT;
  }

  // 1~11：逐像素
  applyPerPixel(red, green, blue, count, params);

  const planes = [red, green, blue] as const;

  // 8 clarity
  if (params.clarity !== 0) {
    unsharpInPlace(
      planes,
      width,
      height,
      neighbourhoodRadius(NEIGHBOUR_RADIUS_K.clarity, width, height),
      (params.clarity / 100) * CLARITY_GAIN,
    );
  }
  // 9 sharpen
  if (params.sharpen !== 0) {
    unsharpInPlace(
      planes,
      width,
      height,
      neighbourhoodRadius(NEIGHBOUR_RADIUS_K.sharpen, width, height),
      (params.sharpen / 100) * SHARPEN_GAIN,
    );
  }
  // 10 glamour
  if (params.glamour !== 0) {
    softenInPlace(
      planes,
      width,
      height,
      neighbourhoodRadius(NEIGHBOUR_RADIUS_K.glamour, width, height),
      (params.glamour / 100) * GLAMOUR_GAIN,
    );
  }
  // 11 bloom
  if (params.bloom !== 0) {
    bloomInPlace(
      planes,
      width,
      height,
      neighbourhoodRadius(NEIGHBOUR_RADIUS_K.bloom, width, height),
      (params.bloom / 100) * BLOOM_GAIN,
    );
  }

  // 12 vignette：按坐标的距离场乘性压暗/提亮，中心 d² = 0 → 恒等
  if (params.vignette !== 0) {
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const strength = (params.vignette / 100) * VIGNETTE_GAIN;
    for (let y = 0; y < height; y += 1) {
      const dy = (y + 0.5 - halfHeight) / halfHeight;
      const dy2 = dy * dy;
      const rowStart = y * width;
      for (let x = 0; x < width; x += 1) {
        const dx = (x + 0.5 - halfWidth) / halfWidth;
        // 四角 dx² + dy² = 2，除以 2 归一化成 1
        const d2 = (dx * dx + dy2) / 2;
        const gain = 1 + strength * d2;
        const i = rowStart + x;
        red[i] = red[i]! * gain;
        green[i] = green[i]! * gain;
        blue[i] = blue[i]! * gain;
      }
    }
  }

  // 13 grain：坐标哈希，确定性
  if (params.grain !== 0) {
    const strength = (params.grain / 100) * GRAIN_GAIN;
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * width;
      for (let x = 0; x < width; x += 1) {
        const delta = strength * (grainNoise(x, y) - 0.5);
        const i = rowStart + x;
        red[i] = red[i]! + delta;
        green[i] = green[i]! + delta;
        blue[i] = blue[i]! + delta;
      }
    }
  }

  for (let i = 0; i < count; i += 1) {
    const offset = i * 4;
    out[offset] = Math.round(clamp01(red[i]!) * 255);
    out[offset + 1] = Math.round(clamp01(green[i]!) * 255);
    out[offset + 2] = Math.round(clamp01(blue[i]!) * 255);
    out[offset + 3] = data[offset + 3]!;
  }

  return { width, height, data: out };
}

/**
 * 面积加权的盒式降采样（预览用）。目标尺寸不整除时按覆盖面积加权，不做最近邻取样。
 *
 * alpha 同样按面积平均；`renderAdjust` 对 alpha 是原样透传的，所以预览的 alpha 也保持一致。
 */
export function downsample(src: PixelBuffer, width: number, height: number): PixelBuffer {
  const { width: sourceWidth, height: sourceHeight, data } = src;
  const out = new Uint8ClampedArray(width * height * 4);

  const columns = spanWeights(sourceWidth, width);
  const rows = spanWeights(sourceHeight, height);

  for (let y = 0; y < height; y += 1) {
    const rowSpans = rows[y]!;
    for (let x = 0; x < width; x += 1) {
      const columnSpans = columns[x]!;
      let totalWeight = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (const row of rowSpans) {
        const rowStart = row.index * sourceWidth;
        for (const column of columnSpans) {
          const weight = row.weight * column.weight;
          const offset = (rowStart + column.index) * 4;
          sumR += data[offset]! * weight;
          sumG += data[offset + 1]! * weight;
          sumB += data[offset + 2]! * weight;
          sumA += data[offset + 3]! * weight;
          totalWeight += weight;
        }
      }
      const target = (y * width + x) * 4;
      out[target] = Math.round(sumR / totalWeight);
      out[target + 1] = Math.round(sumG / totalWeight);
      out[target + 2] = Math.round(sumB / totalWeight);
      out[target + 3] = Math.round(sumA / totalWeight);
    }
  }

  return { width, height, data: out };
}

type Span = { index: number; weight: number };

/** 目标像素 `d` 覆盖到源像素上的区间与权重（源 4 个像素 → 目标 1 个像素时为 1:1:1:1）。 */
function spanWeights(sourceLength: number, targetLength: number): Span[][] {
  const scale = sourceLength / targetLength;
  const spans: Span[][] = [];
  for (let target = 0; target < targetLength; target += 1) {
    const start = target * scale;
    const end = (target + 1) * scale;
    const first = Math.floor(start);
    const last = Math.min(sourceLength - 1, Math.ceil(end) - 1);
    const list: Span[] = [];
    for (let index = first; index <= last; index += 1) {
      const weight = Math.min(end, index + 1) - Math.max(start, index);
      if (weight > 0) list.push({ index, weight });
    }
    spans.push(list);
  }
  return spans;
}
