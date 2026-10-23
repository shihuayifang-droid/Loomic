import { describe, expect, it } from "vitest";

import { GPT_IMAGE_2_SIZES, gptImage2SizeOption, OpenAIImageProvider } from "./openai-image.js";

const GATEWAY_PIXELS = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
];

describe("GPT Image 2 size table", () => {
  it("AG-07: has exactly the 7 sizes the gateway supports", () => {
    expect(GPT_IMAGE_2_SIZES.map((s) => s.value)).toEqual([
      "1:1",
      "3:2",
      "2:3",
      "1:1-2k",
      "16:9-2k",
      "16:9-4k",
      "9:16-4k",
    ]);
    expect(GPT_IMAGE_2_SIZES).toHaveLength(7);
  });

  it("AG-07: every size is a pixel string the gateway accepts", () => {
    for (const s of GPT_IMAGE_2_SIZES) {
      expect(GATEWAY_PIXELS).toContain(`${s.width}x${s.height}`);
    }
  });

  it("AG-07: no 3:2-4k and no 4:3 option exists", () => {
    const values = GPT_IMAGE_2_SIZES.map((s) => s.value) as string[];
    expect(values).not.toContain("3:2-4k");
    expect(values).not.toContain("4:3");
    expect(gptImage2SizeOption("3:2-4k")).toBeUndefined();
    expect(gptImage2SizeOption("4:3")).toBeUndefined();
  });

  it("AG-07: the billing tier follows the long edge", () => {
    for (const s of GPT_IMAGE_2_SIZES) {
      const longEdge = Math.max(s.width, s.height);
      const expected = longEdge <= 1536 ? "standard" : longEdge === 2048 ? "hd" : "ultra";
      expect(s.tier).toBe(expected);
    }
  });

  it("AG-07: the catalogue options are derived from the table", () => {
    const model = new OpenAIImageProvider("k").models.find((m) => m.id === "kwjm/gpt-image-2")!;
    const param = model.params!.params[0]!;
    expect(param.type).toBe("discrete");
    if (param.type !== "discrete") return;
    expect(param.options.map((o) => o.value)).toEqual(GPT_IMAGE_2_SIZES.map((s) => s.value));
    expect(param.default).toBe("1:1");
    expect(model.params!.maxCount).toBe(10);
  });
});