/**
 * ED-00h · 参数滑块的显示逻辑（纯函数，不碰 DOM）
 *
 * 内部值区间默认 0~100，滑块拖动的是**内部值**；对外提交的是**显示值**：
 * - `linear`：显示值 = a + v × k，按 `round` 位小数取整，提交取整后的数字
 * - `steps`：显示值 = 档位文字，提交该档位的文字
 * - `values`：显示值 = 最近的那个取值 + `unit`，提交该数字
 *
 * 档位吸附自己算，不依赖原语 `<input type="range">` 的 `step`：
 * 档位数不能整除 100 时 step 会变成小数，拖动过程中会漂移。
 */

export type ParamDisplay =
  | { kind: "linear"; a: number; k: number; round?: number; unit?: string }
  | { kind: "steps"; labels: readonly string[] }
  /**
   * 离散取值表（MD-03）：滑块只停在这些数上，显示值 = 数字 + `unit`。
   * 与 `steps` 的区别是「档位由数字给出」而不是「等距切分值域」——
   * 模型只支持 5s / 10s 时，等距切分会造出 7.5 这种模型不接受的中间值。
   */
  | { kind: "values"; values: readonly number[]; unit?: string };

export type ParamSliderConfig = {
  id: string;
  label: string;
  /** 内部值域下限，默认 0 */
  min?: number;
  /** 内部值域上限，默认 100 */
  max?: number;
  /** 内部值 */
  defaultValue: number;
  display: ParamDisplay;
};

/** 提交值：linear 是取整后的数字，steps 是档位文字 */
export type ParamSubmitValue = number | string;

const DEFAULT_MIN = 0;
const DEFAULT_MAX = 100;

function bounds(cfg: ParamSliderConfig): { min: number; max: number } {
  return { min: cfg.min ?? DEFAULT_MIN, max: cfg.max ?? DEFAULT_MAX };
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}

function roundTo(v: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(v * factor) / factor;
}

/**
 * 各档对应的内部值；linear 时返回空数组。
 * - `steps`：等距切分值域，首末为 min/max
 * - `values`：就是升序去重后的 `values` 本身
 */
export function stepValues(cfg: ParamSliderConfig): number[] {
  if (cfg.display.kind === "values") {
    return Array.from(new Set(cfg.display.values)).sort((left, right) => left - right);
  }
  if (cfg.display.kind !== "steps") return [];
  const { min, max } = bounds(cfg);
  const count = cfg.display.labels.length;
  if (count <= 1) return [min];
  const gap = (max - min) / (count - 1);
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) {
    values.push(i === count - 1 ? max : min + gap * i);
  }
  return values;
}

/** 离 v 最近的档位下标；档位为空时返回 -1 */
function nearestStepIndex(cfg: ParamSliderConfig, v: number): number {
  const values = stepValues(cfg);
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const distance = Math.abs((values[i] as number) - v);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** 离 v 最近的取值；距离相同取较小（与 shared `snapContinuous` 同口径） */
function nearestValue(values: readonly number[], v: number): number | null {
  if (values.length === 0) return null;
  let best = values[0] as number;
  let bestDistance = Math.abs(best - v);
  for (const value of values) {
    const distance = Math.abs(value - v);
    if (distance < bestDistance || (distance === bestDistance && value < best)) {
      best = value;
      bestDistance = distance;
    }
  }
  return best;
}

/** steps / values：吸附到最近档位对应的内部值；linear：夹到值域 */
export function snap(cfg: ParamSliderConfig, v: number): number {
  if (cfg.display.kind === "values") {
    const values = stepValues(cfg);
    return nearestValue(values, v) ?? bounds(cfg).min;
  }
  if (cfg.display.kind === "steps") {
    const values = stepValues(cfg);
    const index = nearestStepIndex(cfg, v);
    return values[index] ?? bounds(cfg).min;
  }
  const { min, max } = bounds(cfg);
  return clamp(v, min, max);
}

/** 显示值 = { text, value }；value 即提交值 */
export function toDisplay(
  cfg: ParamSliderConfig,
  v: number,
): { text: string; value: ParamSubmitValue } {
  if (cfg.display.kind === "values") {
    const value = nearestValue(stepValues(cfg), v) ?? v;
    return { text: `${value}${cfg.display.unit ?? ""}`, value };
  }
  if (cfg.display.kind === "steps") {
    const index = nearestStepIndex(cfg, v);
    const label = index < 0 ? "" : (cfg.display.labels[index] ?? "");
    return { text: label, value: label };
  }
  const shown = roundTo(cfg.display.a + v * cfg.display.k, cfg.display.round ?? 0);
  return { text: `${shown}${cfg.display.unit ?? ""}`, value: shown };
}
