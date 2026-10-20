import { describe, expect, it } from "vitest";

import type { ImageModelInfo } from "../types.js";
import { GoogleImageProvider } from "./google-image.js";
import { GoogleVertexImageProvider } from "./google-vertex-image.js";
import { OpenAIImageProvider } from "./openai-image.js";
import { ReplicateImageProvider } from "./replicate-image.js";

/**
 * MD-03: a model must declare what each quality tier ACTUALLY produces, and a
 * model that is never sent a resolution parameter must declare nothing at all.
 * Every expectation below is a literal, so the declared tiers cannot drift from
 * the maps the providers send from without a test turning red.
 */

function modelOf(models: readonly ImageModelInfo[], id: string): ImageModelInfo {
  const found = models.find((model) => model.id === id);
  if (!found) throw new Error(`model not declared by its provider: ${id}`);
  return found;
}

describe("image model quality tiers", () => {
  const replicate = new ReplicateImageProvider("test-token");
  const openai = new OpenAIImageProvider("test-key");
  const google = new GoogleImageProvider("test-key");
  const googleVertex = new GoogleVertexImageProvider({
    project: "test-project",
    location: "us-central1",
  });

  it("MD-03: Imagen 4 declares its top tier as 2K, not 4K", () => {
    expect(modelOf(replicate.models, "google/imagen-4").qualityTiers).toEqual([
      { quality: "standard", output: "1K" },
      { quality: "hd", output: "2K" },
      { quality: "ultra", output: "2K" },
    ]);
  });

  it("MD-03: flux-kontext models declare no quality tiers", () => {
    expect(
      modelOf(replicate.models, "black-forest-labs/flux-kontext-pro")
        .qualityTiers,
    ).toBeUndefined();
    expect(
      modelOf(replicate.models, "black-forest-labs/flux-kontext-max")
        .qualityTiers,
    ).toBeUndefined();
  });

  it("MD-03: Seedream 5 Lite tops out at 3K", () => {
    expect(
      modelOf(replicate.models, "bytedance/seedream-5-lite").qualityTiers,
    ).toEqual([
      { quality: "standard", output: "2K" },
      { quality: "hd", output: "2K" },
      { quality: "ultra", output: "3K" },
    ]);
  });

  it("MD-03: every Gemini model on both Google providers declares 1K / 2K / 4K", () => {
    const cases: ReadonlyArray<[readonly ImageModelInfo[], string]> = [
      [google.models, "google-official/gemini-3-pro-image-preview"],
      [google.models, "google-official/gemini-3.1-flash-image-preview"],
      [google.models, "google-official/gemini-2.5-flash-image"],
      [googleVertex.models, "google-vertex/gemini-3-pro-image-preview"],
      [googleVertex.models, "google-vertex/gemini-3.1-flash-image-preview"],
      [googleVertex.models, "google-vertex/gemini-2.5-flash-image"],
    ];

    expect(cases).toHaveLength(6);
    for (const [models, id] of cases) {
      expect({ id, tiers: modelOf(models, id).qualityTiers }).toEqual({
        id,
        tiers: [
          { quality: "standard", output: "1K" },
          { quality: "hd", output: "2K" },
          { quality: "ultra", output: "4K" },
        ],
      });
    }
  });

  it("MD-03: kwjm GPT Image tiers follow the size table's longest edge", () => {
    expect(modelOf(openai.models, "kwjm/gpt-image-2").qualityTiers).toEqual([
      { quality: "standard", output: "1.5K" },
      { quality: "hd", output: "2K" },
      { quality: "ultra", output: "4K" },
    ]);

    // The inpaint entry has its own limits but the same resolution tiers.
    expect(
      openai.models.map((model) => (model.qualityTiers ? model.id : null)),
    ).toEqual([
      "kwjm/gpt-image-2",
      "kwjm/gpt-image-1.5",
      "kwjm/gpt-image-2-inpaint",
    ]);
  });

  it("MD-03: a replicate model is tiered exactly when the provider sends it a resolution", () => {
    expect(replicate.models).toHaveLength(11);
    expect(
      replicate.models
        .filter((model) => model.qualityTiers)
        .map((model) => model.id)
        .sort(),
    ).toEqual([
      "bytedance/seedream-4",
      "bytedance/seedream-4.5",
      "bytedance/seedream-5-lite",
      "google/imagen-4",
      "google/nano-banana-2",
      "google/nano-banana-pro",
    ]);
  });
});
