/**
 * ED-01 · 自动调整的建议值（工单 30K T2）
 *
 * 纯函数：读一帧的亮度直方图与色度统计，给出 5 个参数的建议值，**不调用 `renderAdjust`**。
 * 只返回 exposure / contrast / whites / blacks / vibrance 五项 —— 其余 12 项由面板保留原值
 * （工单 §2 裁决 5）。值一律是整数并夹在 [−100, +100]。
 *
 * ## 口径
 *
 * 五个建议值都是「一次到位」的反解：按渲染的固定顺序（exposure → contrast → 四个色调 →
 * vibrance）**预测**各步之后的直方图，再在预测值上反解下一项 —— 这样把建议值真的代入
 * `renderAdjust` 之后，第二轮建议应当接近 0（工单 §3-T4 的收敛要求）。
 *
 * - `exposure`：把平均亮度推到 0.5 的指数校正，`100·log2(0.5 / 平均亮度)`。
 * - `contrast`：按曝光后的分位跨度算，把跨度拉到 1 的线性斜率，`100·(1/span − 1)`。
 * - `whites` / `blacks`：在曝光与对比度之后的预测分位上，把上限/下限平移到 1/0；
 *   幅度按 `TONE_EDGE` 的权重反解 —— 权重函数与渲染共用 `toneWeight()`。
 * - `vibrance`：把（曝光后的）平均色度推向 `AUTO_VIBRANCE_TARGET`；反解用的是渲染里那条
 *   `k = 1 + t·(1 − 色度)`，同时乘上「有色像素占比」，全灰的图因此建议 0
 *   （对灰图提色度没有意义，而且那些像素的色度本来就是 0）。
 */

import {
  LUMA_WEIGHTS,
  TONE_SHIFT_GAIN,
  type AdjustParams,
  type PixelBuffer,
  type ToneKind,
  toneWeight,
} from "./adjust-render";

export type AutoAdjustResult = Pick<
  AdjustParams,
  "exposure" | "contrast" | "whites" | "blacks" | "vibrance"
>;

/** 直方图分箱数（亮度量化为 256 档，足够算 0.5% 分位）。 */
const HISTOGRAM_BINS = 256;
/** 分位点：0.5% 与 99.5%。 */
const LOW_QUANTILE = 0.005;
const HIGH_QUANTILE = 0.995;
/** exposure 的目标平均亮度。 */
const TARGET_MEAN_LUMA = 0.5;
/** 平均亮度再低也当作这个值，避免 log2 发散。 */
const MIN_MEAN_LUMA = 0.02;
/** vibrance 的目标平均色度，以及「算作有色」的色度门槛。 */
const TARGET_CHROMA = 0.3;
const CHROMA_FLOOR = 0.1;

function clampParam(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(-100, Math.round(value)));
}

/** 直方图上的分位点，返回 [0,1] 的量化亮度（取所在箱的中点）。 */
function quantile(histogram: Uint32Array, total: number, fraction: number): number {
  const target = Math.max(1, Math.ceil(total * fraction));
  let seen = 0;
  for (let bin = 0; bin < histogram.length; bin += 1) {
    seen += histogram[bin]!;
    if (seen >= target) return (bin + 0.5) / HISTOGRAM_BINS;
  }
  return 1;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 反解「要把 `from` 拉到 `to`，某个色调权重需要多大的 t」。
 *
 * 渲染里这一项是 `x += TONE_SHIFT_GAIN × t × 权重`，所以 `t = 目标位移 / (幅度 × 权重)`。
 * 权重太小（该分位落在过渡区间之外）时返回 null —— 这一项给不出建议，交给 contrast。
 */
function toneParam(kind: ToneKind, from: number, to: number): number | null {
  const weight = toneWeight(kind, from);
  const gain = TONE_SHIFT_GAIN[kind];
  if (weight < 0.05 || gain <= 0) return null;
  return clampParam((((to - from) / (gain * weight)) * 100));
}

/**
 * 根据一帧算出 5 个建议值。只看像素统计，**不跑渲染**。
 *
 * 中间量都按渲染的固定顺序向前预测：先曝光（乘性，分位与均值同比例缩放），
 * 再对比度（绕 0.5 线性拉伸），最后才是四个色调权重与 vibrance。
 */
export function autoAdjust(src: PixelBuffer): AutoAdjustResult {
  const { width, height, data } = src;
  const count = Math.max(1, width * height);
  const histogram = new Uint32Array(HISTOGRAM_BINS);

  let lumaSum = 0;
  let chromaSum = 0;
  let chromaPixels = 0;

  for (let i = 0; i < count; i += 1) {
    const offset = i * 4;
    const r = data[offset]!;
    const g = data[offset + 1]!;
    const b = data[offset + 2]!;
    const luma = (LUMA_WEIGHTS.r * r + LUMA_WEIGHTS.g * g + LUMA_WEIGHTS.b * b) / 255;
    lumaSum += luma;

    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const chroma = (max - min) / 255;
    chromaSum += chroma;
    if (chroma > CHROMA_FLOOR) chromaPixels += 1;

    let bin = Math.floor(luma * HISTOGRAM_BINS);
    if (bin < 0) bin = 0;
    else if (bin >= HISTOGRAM_BINS) bin = HISTOGRAM_BINS - 1;
    histogram[bin] = histogram[bin]! + 1;
  }

  const meanLuma = lumaSum / count;
  const low = quantile(histogram, count, LOW_QUANTILE);
  const high = quantile(histogram, count, HIGH_QUANTILE);
  const meanChroma = chromaSum / count;
  const chromaShare = chromaPixels / count;

  // ① exposure：把平均亮度推到 0.5（乘性，指数校正可直接反解）
  const exposure = clampParam(
    100 * Math.log2(TARGET_MEAN_LUMA / Math.max(meanLuma, MIN_MEAN_LUMA)),
  );
  const exposureGain = 2 ** (exposure / 100);

  // ② contrast：按曝光之后的分位跨度算（k = 1 + t，CONTRAST_GAIN = 1 → t = 1/span − 1）
  const scaledLow = clamp01(low * exposureGain);
  const scaledHigh = clamp01(high * exposureGain);
  const scaledSpan = scaledHigh - scaledLow;
  const contrast = scaledSpan <= 0 ? 100 : clampParam(100 * (1 / scaledSpan - 1));
  const contrastGain = 1 + contrast / 100;

  // ③ whites / blacks：在曝光与对比度之后的预测分位上，把上限/下限推到 1/0
  const predictedHigh = clamp01(0.5 + (scaledHigh - 0.5) * contrastGain);
  const predictedLow = clamp01(0.5 + (scaledLow - 0.5) * contrastGain);
  const whites = toneParam("whites", predictedHigh, 1) ?? 0;
  const blacks = toneParam("blacks", predictedLow, 0) ?? 0;

  // ④ vibrance：色度随曝光与对比度同比例放大（未溢出时），再按 k = 1 + t·(1 − 色度) 反解
  //    target/current 的偏差对应 t = (目标/当前 − 1) / (1 − 当前色度)
  const scaledChroma = clamp01(meanChroma * exposureGain * contrastGain);
  const vibrance =
    chromaShare <= 0 || scaledChroma <= 0
      ? 0
      : clampParam(
          ((TARGET_CHROMA / scaledChroma - 1) / Math.max(1 - scaledChroma, 0.05)) *
            100 *
            chromaShare,
        );

  return { exposure, contrast, whites, blacks, vibrance };
}
