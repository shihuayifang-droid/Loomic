import { describe, expect, it } from "vitest";

import {
  type GeneratorParam,
  generatorParamSchema,
  generatorParamsSchema,
  snapContinuous,
  snapCustomSize,
} from "./generator-params.js";

// MD-03 / AG-07 — the parameter contract each generator model ships.

/** The seven sizes the image models offer (AG-07 (a)). */
const SIZE_OPTIONS = [
  { value: "1024x1024", label: "1:1 1024" },
  { value: "1536x1024", label: "3:2 1536" },
  { value: "1024x1536", label: "2:3 1536" },
  { value: "1280x720", label: "16:9 720p" },
  { value: "720x1280", label: "9:16 720p" },
  { value: "1920x1080", label: "16:9 1080p" },
  { value: "1080x1920", label: "9:16 1080p" },
];

const discreteParam: GeneratorParam = {
  type: "discrete",
  id: "size",
  label: "尺寸",
  options: SIZE_OPTIONS,
  default: "1024x1024",
};

const durationParam: GeneratorParam = {
  type: "continuous",
  id: "duration",
  label: "时长",
  min: 5,
  max: 10,
  step: 1,
  values: [5, 10],
  default: 5,
  unit: "s",
};

const freeRangeParam: GeneratorParam = {
  type: "continuous",
  id: "guidance",
  label: "引导",
  min: 1,
  max: 10,
  step: 1,
  default: 1,
};

const textParam: GeneratorParam = {
  type: "text",
  id: "negative",
  label: "负向",
  maxLength: 200,
  default: "",
};

const customSizeParam: GeneratorParam = {
  type: "custom_size",
  id: "custom",
  label: "自定义宽高",
  maxEdge: 3840,
  multiple: 16,
  maxRatio: 3,
  minMegapixels: 0.6,
  maxMegapixels: 8,
};

describe("generatorParamsSchema", () => {
  it("accepts the four parameter shapes MD-03 requires", () => {
    expect(generatorParamSchema.safeParse(discreteParam).success).toBe(true);
    expect(generatorParamSchema.safeParse(durationParam).success).toBe(true);
    expect(generatorParamSchema.safeParse(textParam).success).toBe(true);
    expect(generatorParamSchema.safeParse(customSizeParam).success).toBe(true);

    const parsed = generatorParamsSchema.safeParse({
      params: [discreteParam, durationParam, textParam, customSizeParam],
      maxCount: 4,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const continuous = parsed.data.params.find((param) => param.id === "duration");
      expect(continuous).toEqual(durationParam);
    }
  });

  it("keeps maxCount inside 1..10", () => {
    expect(
      generatorParamsSchema.safeParse({ params: [discreteParam], maxCount: 0 }).success,
    ).toBe(false);
    expect(
      generatorParamsSchema.safeParse({ params: [discreteParam], maxCount: 11 }).success,
    ).toBe(false);
    expect(
      generatorParamsSchema.safeParse({ params: [discreteParam], maxCount: 1 }).success,
    ).toBe(true);
    expect(
      generatorParamsSchema.safeParse({ params: [discreteParam], maxCount: 10 }).success,
    ).toBe(true);
  });

  it("rejects a discrete default that is not one of its options", () => {
    const parsed = generatorParamSchema.safeParse({ ...discreteParam, default: "4096x4096" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a continuous default that is not one of its values", () => {
    const parsed = generatorParamSchema.safeParse({ ...durationParam, default: 7 });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate parameter ids", () => {
    const parsed = generatorParamsSchema.safeParse({
      params: [discreteParam, { ...textParam, id: "size" }],
      maxCount: 2,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("snapContinuous", () => {
  const discreteValues = durationParam as Extract<GeneratorParam, { type: "continuous" }>;
  const slider = freeRangeParam as Extract<GeneratorParam, { type: "continuous" }>;

  it("nearest allowed value wins, a tie goes to the smaller one", () => {
    expect(snapContinuous(discreteValues, 6)).toBe(5);
    expect(snapContinuous(discreteValues, 8)).toBe(10);
    expect(snapContinuous(discreteValues, 7.5)).toBe(5);
    expect(snapContinuous(discreteValues, 100)).toBe(10);
  });

  it("rounds onto the step grid and clamps into [min, max]", () => {
    expect(snapContinuous(slider, 3.6)).toBe(4);
    expect(snapContinuous(slider, -5)).toBe(1);
    expect(snapContinuous(slider, 99)).toBe(10);
  });
});

describe("snapCustomSize", () => {
  const size = customSizeParam as Extract<GeneratorParam, { type: "custom_size" }>;

  it("leaves a legal pair untouched", () => {
    const snapped = snapCustomSize(size, 1024, 1024);
    expect(snapped.width).toBe(1024);
    expect(snapped.height).toBe(1024);
    expect(snapped.adjusted).toBe(false);
    expect(snapped.notice).toBeNull();
  });

  it("clamps an oversized edge and shortens the long one to maxRatio", () => {
    const snapped = snapCustomSize(size, 3850, 1000);
    expect(snapped.width).toBeLessThanOrEqual(3840);
    expect(snapped.height).toBeLessThanOrEqual(3840);
    expect(snapped.width % 16).toBe(0);
    expect(snapped.height % 16).toBe(0);
    expect(Math.max(snapped.width, snapped.height) / Math.min(snapped.width, snapped.height))
      .toBeLessThanOrEqual(3);
    expect(snapped.adjusted).toBe(true);
    expect(snapped.notice?.startsWith("已修正为")).toBe(true);
  });

  it("scales a too-small pair up to the megapixel floor", () => {
    const snapped = snapCustomSize(size, 500, 500);
    expect((snapped.width * snapped.height) / 1_000_000).toBeGreaterThanOrEqual(0.6);
    expect(snapped.width % 16).toBe(0);
    expect(snapped.height % 16).toBe(0);
    expect(snapped.adjusted).toBe(true);
  });

  it("scales a too-large pair down to the megapixel ceiling and the edge cap", () => {
    const snapped = snapCustomSize(size, 4000, 4000);
    expect(snapped.width).toBeLessThanOrEqual(3840);
    expect(snapped.height).toBeLessThanOrEqual(3840);
    expect((snapped.width * snapped.height) / 1_000_000).toBeLessThanOrEqual(8);
    expect(snapped.width % 16).toBe(0);
    expect(snapped.height % 16).toBe(0);
  });
});
