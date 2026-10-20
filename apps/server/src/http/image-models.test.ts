import { describe, expect, it } from "vitest";

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
