import { afterEach, describe, expect, it } from "vitest";

import { generateImage } from "./image-generation.js";
import { clearProviders, registerImageProvider } from "./providers/registry.js";
import type { ImageProvider } from "./types.js";
import { GenerationError } from "./utils.js";

/** A provider that only answers — enough for `generateImage`, which routes on it. */
function stubProvider(name: string, generate: ImageProvider["generate"]): ImageProvider {
  return { name, models: [], generate };
}

const PARAMS = { prompt: "a cat on a wall", model: "stub-model" };

describe("generateImage: the upstream reference-image refusal (工单40B / MD-03)", () => {
  afterEach(() => {
    // The registry is a module-level map, so a stub left behind would be visible
    // to every test that runs after this file.
    clearProviders();
  });

  it("MD-03: 'too many images' becomes reference_image_limit with the ticket's copy", async () => {
    registerImageProvider(
      stubProvider("stub-too-many", async () => {
        throw new Error("Invalid request: too many images (max 4)");
      }),
    );

    const error = await generateImage("stub-too-many", PARAMS).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GenerationError);
    expect((error as GenerationError).code).toBe("reference_image_limit");
    expect((error as GenerationError).message).toBe("该模型参考图数量超限");
    expect((error as GenerationError).provider).toBe("stub-too-many");
  });

  it("MD-03: any other upstream failure is rethrown as the same object", async () => {
    const original = new Error("rate limited");
    registerImageProvider(
      stubProvider("stub-other", async () => {
        throw original;
      }),
    );

    const error = await generateImage("stub-other", PARAMS).catch((thrown: unknown) => thrown);

    // Identity, not just equality: the ticket promises the other failures pass
    // through unchanged, so nothing may wrap, clone or re-code them.
    expect(error).toBe(original);
  });

  it("MD-03: a successful generation is returned untouched", async () => {
    const generated = { url: "https://example.test/a.png", mimeType: "image/png", width: 1, height: 1 };
    registerImageProvider(stubProvider("stub-ok", async () => generated));

    await expect(generateImage("stub-ok", PARAMS)).resolves.toBe(generated);
  });
});
