import { describe, expect, it } from "vitest";

import { generateSkillSlug } from "./skill-slug.js";

describe("generateSkillSlug", () => {
  it("T-61: an English name keeps its slug", () => {
    expect(generateSkillSlug("Canvas Design")).toBe("canvas-design");
  });

  it("T-61: a Chinese-only name gets a stable non-empty slug", () => {
    const slug = generateSkillSlug("海报设计");

    expect(slug.startsWith("skill-")).toBe(true);
    expect(slug.length).toBe(18);
    expect(generateSkillSlug("海报设计")).toBe(slug);
    expect(/^[a-z0-9-]+$/.test(slug)).toBe(true);
  });

  it("T-61: two different Chinese names get different slugs", () => {
    expect(generateSkillSlug("海报设计")).not.toBe(generateSkillSlug("图标设计"));
  });

  it("T-61: a mixed name keeps its ASCII part", () => {
    expect(generateSkillSlug("海报 v2")).toBe("v2");
  });
});
