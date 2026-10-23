// BL-07 (workorder 35N): the ledger records what a job was charged for, so the
// generation request has to be issued at that same tier.
//
// The bug this pins: the billing guard quoted and charged the requested tier
// (`quality` is "hd" by default, "ultra" for 4K), but the executor never put that
// tier into the job payload and never passed it to the provider. A request billed
// as `ultra` was therefore generated at whatever the provider's own default is —
// charged for 4K, delivered at less.
//
// The mapping from payload to provider parameters is asserted here as a pure
// function. Importing the executor module registers its executor as a side
// effect, which is harmless: registration only writes an entry into the executor
// map, and no job is ever run from this file.
import { describe, expect, it, vi } from "vitest";

import { imageJobGenerateParams } from "./image-generation.js";

describe("image job generate params", () => {
  it("BL-07: the image job generates at the quality it was billed for", () => {
    const params = imageJobGenerateParams(
      { prompt: "a cat", model: "m", quality: "ultra" },
      "m",
    );

    expect(params.quality).toBe("ultra");
  });

  it("BL-07: an unknown quality is not passed on", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const params = imageJobGenerateParams(
        { prompt: "a cat", model: "m", quality: "8k" },
        "m",
      );

      expect(Object.prototype.hasOwnProperty.call(params, "quality")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("BL-07: no quality keeps the provider default", () => {
    const params = imageJobGenerateParams(
      {
        prompt: "a cat",
        aspect_ratio: "16:9",
        input_images: ["https://example.test/in.png"],
      },
      "m",
    );

    expect(Object.prototype.hasOwnProperty.call(params, "quality")).toBe(false);
    expect(params.aspectRatio).toBe("16:9");
    expect(params.inputImages).toEqual(["https://example.test/in.png"]);
  });
});

describe("image job size", () => {
  it("AG-07: a catalogue size becomes explicit pixels", () => {
    const params = imageJobGenerateParams({ prompt: "a cat", size: "9:16-4k" }, "kwjm/gpt-image-2");
    expect(params.size).toEqual({ width: 2160, height: 3840 });
  });

  it("AG-07: an unknown size is ignored with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const params = imageJobGenerateParams({ prompt: "a cat", size: "3:2-4k" }, "kwjm/gpt-image-2");
      expect(params.size).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
