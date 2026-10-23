import { describe, expect, it } from "vitest";

import { OpenAIImageProvider } from "../generation/providers/openai-image.js";
import { ReplicateImageProvider } from "../generation/providers/replicate-image.js";
import { toImageModelListItem } from "./image-models.js";

const replicate = new ReplicateImageProvider("test-token");

function listedModel(id: string) {
  const model = replicate.models.find((m) => m.id === id);
  if (!model) throw new Error(`replicate provider does not declare ${id}`);
  return { ...model, provider: replicate.name };
}

const imagen4 = listedModel("google/imagen-4");
const fluxKontext = listedModel("black-forest-labs/flux-kontext-pro");

// MD-03: 面板上的档位文案写实际产出，没有档位的模型不出现质量选择。
describe("MD-03 image model list items", () => {
  it("MD-03: Imagen 4 is listed with a top tier labelled 超清（实际 2K）", () => {
    expect(toImageModelListItem(imagen4, null).quality).toEqual([
      { key: "standard", output: "1K", label: "标准 1K" },
      { key: "hd", output: "2K", label: "高清 2K" },
      { key: "ultra", output: "2K", label: "超清（实际 2K）" },
    ]);
  });

  it("MD-03: flux-kontext is listed without a quality key", () => {
    expect("quality" in toImageModelListItem(fluxKontext, null)).toBe(false);
  });

  it("MD-03: the rest of the list item is unchanged", () => {
    const item = toImageModelListItem(imagen4, null);
    expect(item).toMatchObject({
      id: "google/imagen-4",
      modality: "image",
      visibility: {
        listed: true,
        agent_callable: true,
        generator_visible: true,
        in_preference: true,
      },
      accessible: false,
      minTier: "starter",
      limits: imagen4.limits,
    });
  });
});

describe("AG-07 image model params", () => {
  const openai = new OpenAIImageProvider("test-key");
  const gpt = { ...openai.models.find((m) => m.id === "kwjm/gpt-image-2")!, provider: openai.name };

  it("AG-07: GPT Image 2 lists its 7 size options with a billing tier", () => {
    const group = toImageModelListItem(gpt, null).params!.params[0]!;
    expect(group.id).toBe("size");
    if (group.type !== "discrete") throw new Error("size must be discrete");
    expect(group.options).toHaveLength(7);
    expect(group.options.every((o) => o.tier !== undefined)).toBe(true);
  });

  it("AG-07: Flux Kontext lists exactly one aspectRatio group with 5 options", () => {
    const params = toImageModelListItem(fluxKontext, null).params!;
    expect(params.params).toHaveLength(1);
    const group = params.params[0]!;
    expect(group.id).toBe("aspectRatio");
    if (group.type !== "discrete") throw new Error("aspectRatio must be discrete");
    expect(group.options.map((o) => o.value)).toEqual(["1:1", "16:9", "9:16", "4:3", "3:4"]);
  });

  it("AG-07: a model without params has no params key", () => {
    expect("params" in toImageModelListItem(imagen4, null)).toBe(false);
  });
});
