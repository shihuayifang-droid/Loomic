import { z } from "zod";

/**
 * MD-03 / AG-07 — the parameter contract every generator model ships with.
 *
 * The server owns the table (which parameters a model has, their type, their
 * options, defaults and limits); the web panel and the Agent both render from
 * this payload, so neither side hard-codes a slider range, a size cap or a
 * count limit. Three parameter shapes are required by MD-03 — continuous
 * numbers (min / max / step / display), discrete steps (options + labels) and
 * free text — plus AG-07 (c) `custom_size`, the width × height entry with its
 * own legal range.
 *
 * Kept separate from `tool-definitions.ts` on purpose: that table describes the
 * per-image toolbar, this one describes generation requests.
 */

/** One selectable value of a `discrete` parameter, plus the label the UI shows. */
export const generatorParamOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  /** Billing tier of this option; the client quotes the price with it as `quality`. */
  tier: z.enum(["standard", "hd", "ultra"]).optional(),
});
export type GeneratorParamOption = z.infer<typeof generatorParamOptionSchema>;

/**
 * MD-03 — a continuous number. `min` / `max` / `step` drive the slider, and the
 * optional `values` turns it into a slider that may only stop on those numbers
 * (a model that supports 5s and 10s but nothing between).
 */
const continuousParamSchema = z.object({
  type: z.literal("continuous"),
  id: z.string().min(1),
  label: z.string().min(1),
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
  /** When present, only these values are legal (still inside [min, max]). */
  values: z.array(z.number()).min(1).optional(),
  default: z.number(),
  unit: z.string().optional(),
});

/** MD-03 — a discrete parameter: the value is the chosen option's `value`. */
const discreteParamSchema = z.object({
  type: z.literal("discrete"),
  id: z.string().min(1),
  label: z.string().min(1),
  options: z.array(generatorParamOptionSchema).min(1),
  default: z.string(),
});

/** MD-03 — free text (a prompt suffix, a negative prompt, a seed as a string). */
const textParamSchema = z.object({
  type: z.literal("text"),
  id: z.string().min(1),
  label: z.string().min(1),
  maxLength: z.number().int().positive().optional(),
  default: z.string().optional(),
});

/**
 * AG-07 (c) — width × height entry. `maxEdge` / `multiple` / `maxRatio` /
 * megapixel bounds are the legal box; `snapCustomSize` is the only place that
 * bends a user's number back into it, so both sides agree on the correction.
 */
const customSizeParamSchema = z.object({
  type: z.literal("custom_size"),
  id: z.string().min(1),
  label: z.string().min(1),
  maxEdge: z.number().int().positive(),
  multiple: z.number().int().positive(),
  maxRatio: z.number().positive(),
  minMegapixels: z.number().positive(),
  maxMegapixels: z.number().positive(),
});

/**
 * The four shapes. `z.discriminatedUnion` needs plain objects, so the cross-field
 * checks live in the `superRefine` below instead of on each branch.
 */
const generatorParamBranchSchema = z.discriminatedUnion("type", [
  discreteParamSchema,
  continuousParamSchema,
  textParamSchema,
  customSizeParamSchema,
]);

export const generatorParamSchema = generatorParamBranchSchema.superRefine((param, ctx) => {
  if (param.type === "discrete") {
    if (!param.options.some((option) => option.value === param.default)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: `default "${param.default}" is not one of the options`,
      });
    }
    return;
  }

  if (param.type === "continuous") {
    if (!(param.min <= param.default && param.default <= param.max)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: `default ${param.default} is outside [${param.min}, ${param.max}]`,
      });
    }
    if (param.values) {
      const outside = param.values.filter((value) => value < param.min || value > param.max);
      if (outside.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["values"],
          message: `values ${outside.join(", ")} are outside [${param.min}, ${param.max}]`,
        });
      }
      if (!param.values.includes(param.default)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["default"],
          message: `default ${param.default} is not one of the allowed values`,
        });
      }
    }
    return;
  }

  if (param.type === "custom_size") {
    if (!(param.minMegapixels < param.maxMegapixels)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxMegapixels"],
        message: "minMegapixels must be smaller than maxMegapixels",
      });
    }
  }
});

/**
 * One model's generator parameters plus how many images / shots the model may
 * produce per request (MD-03: 1–10).
 */
export const generatorParamsSchema = z
  .object({
    params: z.array(generatorParamSchema),
    maxCount: z.number().int().min(1).max(10),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.params.forEach((param, index) => {
      if (seen.has(param.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["params", index, "id"],
          message: `duplicate parameter id "${param.id}"`,
        });
      }
      seen.add(param.id);
    });
  });

export type GeneratorParam = z.infer<typeof generatorParamSchema>;
export type GeneratorParams = z.infer<typeof generatorParamsSchema>;
export type DiscreteGeneratorParam = z.infer<typeof discreteParamSchema>;
export type ContinuousGeneratorParam = z.infer<typeof continuousParamSchema>;
export type TextGeneratorParam = z.infer<typeof textParamSchema>;
export type CustomSizeGeneratorParam = z.infer<typeof customSizeParamSchema>;

/**
 * MD-03 — snap a raw slider / keyboard number onto what the model accepts.
 *
 * With `values` the nearest allowed value wins (a tie goes to the smaller one,
 * so dragging one way never flips back and forth); without it the value is
 * rounded onto the `step` grid starting at `min` and clamped into `[min, max]`.
 */
export function snapContinuous(
  param: Extract<GeneratorParam, { type: "continuous" }>,
  raw: number,
): number {
  if (param.values && param.values.length > 0) {
    let best = param.values[0]!;
    let bestDistance = Math.abs(best - raw);
    for (const value of param.values) {
      const distance = Math.abs(value - raw);
      if (distance < bestDistance || (distance === bestDistance && value < best)) {
        best = value;
        bestDistance = distance;
      }
    }
    return best;
  }

  const steps = Math.round((raw - param.min) / param.step);
  const snapped = param.min + steps * param.step;
  return clamp(snapped, param.min, param.max);
}

/** Result of {@link snapCustomSize}: the legal pair, and whether it moved. */
export type CustomSizeSnap = {
  width: number;
  height: number;
  adjusted: boolean;
  notice: string | null;
};

const PIXELS_PER_MEGAPIXEL = 1_000_000;

/**
 * AG-07 (c) — bend a user-entered width × height back into the legal box.
 *
 * Order (each step only moves what the previous one left out of range):
 * ① clamp each edge into `[multiple, maxEdge]`;
 * ② shorten the long edge to `short × maxRatio` when the pair is too elongated;
 * ③ scale both edges to the nearest megapixel boundary when the total is too
 *    small or too large (keeping the aspect ratio);
 * ④ floor each edge onto the `multiple` grid (never below `multiple`).
 *
 * Steps ③/④ can fight each other (flooring a pair that was just scaled up to the
 * minimum megapixels drops it back under), so ⑤ re-applies the ratio and the
 * megapixel bounds on the grid. That keeps the invariants AG-07 states even
 * though ④ is the last step that may move a number down.
 */
export function snapCustomSize(
  param: Extract<GeneratorParam, { type: "custom_size" }>,
  width: number,
  height: number,
): CustomSizeSnap {
  const { maxEdge, multiple, maxRatio, minMegapixels, maxMegapixels } = param;
  const minPixels = minMegapixels * PIXELS_PER_MEGAPIXEL;
  const maxPixels = maxMegapixels * PIXELS_PER_MEGAPIXEL;

  // ① each edge into [multiple, maxEdge]; a size parameter must always start
  // from a usable pair, so a non-finite entry falls back to `multiple`.
  let w = clamp(Number.isFinite(width) ? width : multiple, multiple, maxEdge);
  let h = clamp(Number.isFinite(height) ? height : multiple, multiple, maxEdge);

  // ② aspect ratio.
  ({ width: w, height: h } = applyMaxRatio(w, h, maxRatio, multiple));

  // ③ megapixels, scaled proportionally so the shape survives.
  const pixels = w * h;
  if (pixels < minPixels) {
    const scale = Math.sqrt(minPixels / pixels);
    w *= scale;
    h *= scale;
  } else if (pixels > maxPixels) {
    const scale = Math.sqrt(maxPixels / pixels);
    w *= scale;
    h *= scale;
  }
  w = clamp(w, multiple, maxEdge);
  h = clamp(h, multiple, maxEdge);

  // ④ every edge on the `multiple` grid, never below `multiple`.
  w = alignEdge(w, multiple, maxEdge);
  h = alignEdge(h, multiple, maxEdge);

  // ⑤ the bounds ③/④ pulled against each other.
  ({ width: w, height: h } = applyMaxRatio(w, h, maxRatio, multiple));
  const finalPixels = w * h;
  if (finalPixels < minPixels) {
    const scale = Math.sqrt(minPixels / finalPixels);
    w = alignEdge(ceilTo(w * scale, multiple), multiple, maxEdge);
    h = alignEdge(ceilTo(h * scale, multiple), multiple, maxEdge);
  } else if (finalPixels > maxPixels) {
    const scale = Math.sqrt(maxPixels / finalPixels);
    w = alignEdge(w * scale, multiple, maxEdge);
    h = alignEdge(h * scale, multiple, maxEdge);
  }
  ({ width: w, height: h } = applyMaxRatio(w, h, maxRatio, multiple));

  const adjusted = w !== width || h !== height;
  return {
    width: w,
    height: h,
    adjusted,
    notice: adjusted ? `已修正为 ${w}×${h}` : null,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Put one edge on the `multiple` grid (flooring) and never leave the box. */
function alignEdge(value: number, multiple: number, maxEdge: number): number {
  const onGrid = floorTo(Math.min(value, maxEdge), multiple);
  return Math.max(multiple, onGrid);
}

/** ② — shorten the long edge to `short × maxRatio`, keeping it on the grid. */
function applyMaxRatio(
  width: number,
  height: number,
  maxRatio: number,
  multiple: number,
): { width: number; height: number } {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (long <= short * maxRatio) return { width, height };
  const target = Math.max(multiple, floorTo(short * maxRatio, multiple));
  return width >= height ? { width: target, height } : { width, height: target };
}

function floorTo(value: number, multiple: number): number {
  return Math.floor(value / multiple) * multiple;
}

function ceilTo(value: number, multiple: number): number {
  return Math.ceil(value / multiple) * multiple;
}
