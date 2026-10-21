import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { generationLedgerDescription } from "./ledger-description.js";

/**
 * BL-06 pins the wording of a generation charge on the credit ledger: the
 * Chinese kind, the model id, and the image count when there is one. The last
 * case guards the five charge sites themselves, because the wording can regress
 * there even while this module is correct.
 */
const ROUTE_SOURCES = [
  readFileSync(new URL("../../agent/runtime.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../http/jobs.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../http/generate.ts", import.meta.url), "utf8"),
];

describe("generationLedgerDescription", () => {
  it("BL-06: an image charge reads 图像生成 · model", () => {
    expect(generationLedgerDescription("image", "kwjm/gpt-image-2")).toBe(
      "图像生成 · kwjm/gpt-image-2",
    );
  });

  it("BL-06: a video charge reads 视频生成 · model", () => {
    expect(generationLedgerDescription("video", "kwjm/veo-3")).toBe(
      "视频生成 · kwjm/veo-3",
    );
  });

  it("BL-06: several images say how many", () => {
    expect(generationLedgerDescription("image", "m", { count: 2 })).toBe(
      "图像生成 · m · 2 张",
    );
    expect(generationLedgerDescription("image", "m", { count: 1 })).toBe(
      "图像生成 · m",
    );
    expect(generationLedgerDescription("video", "m", { count: 2 })).toBe(
      "视频生成 · m",
    );
  });

  it("BL-06: the routes no longer write English descriptions", () => {
    for (const source of ROUTE_SOURCES) {
      expect(source).not.toContain("`Image generation: ");
      expect(source).not.toContain("`Video generation: ");
    }
  });
});
