import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { agentLedgerDescription, generationLedgerDescription } from "./ledger-description.js";

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

/**
 * BL-06: an Agent charge carries the user's request, not the serialised prompt
 * the model receives — the ledger is read by the person who typed the words.
 */
describe("agentLedgerDescription", () => {
  it("BL-06: an Agent charge reads the user's words, not the serialized prompt", () => {
    expect(
      agentLedgerDescription("把这张图 [@image:#1] 改成蓝色背景", "image", "kwjm/gpt-image-2"),
    ).toBe("「把这张图 改成蓝色背景」 · 图像生成 · kwjm/gpt-image-2");
  });

  it("BL-06: the reference tail never reaches the ledger", () => {
    const serialized =
      "把这张图改成蓝色背景\n\n<references>Image #1: asset-1</references>";
    const description = agentLedgerDescription(serialized, "image", "kwjm/gpt-image-2");

    expect(description).not.toContain("<");
    expect(description).not.toContain("Image #1");
    expect(description).not.toContain("asset-1");
  });

  it("BL-06: a long request is cut to 30 characters", () => {
    const longRequest = "一二三四五六七八九十".repeat(4);
    expect([...longRequest]).toHaveLength(40);

    const description = agentLedgerDescription(longRequest, "image", "m");
    expect(description).toBe(`「${longRequest.slice(0, 30)}…」 · 图像生成 · m`);

    const quoted = description.slice(1, description.indexOf("」"));
    // 30 characters plus the ellipsis.
    expect([...quoted]).toHaveLength(31);
  });

  it("BL-06: an empty request falls back to the generator line", () => {
    const modelId = "kwjm/gpt-image-2";
    const fallback = generationLedgerDescription("image", modelId);

    for (const empty of ["", null, "   ", "[@image:#1]", "[/skill:#2]"]) {
      expect(agentLedgerDescription(empty, "image", modelId)).toBe(fallback);
    }
  });
});
