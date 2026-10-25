import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BRAND } from "../src/lib/brand";

/**
 * BR-17 品牌文案（工单 40I）
 *
 * 45CQ 把 layout.tsx 的字面量换成了 `BRAND`，契约随之从「源码里出现几次
 * HaHart」变成「文案来自 BRAND 这个唯一来源」：文案本身断言 BRAND 的值，
 * layout 只断言它引用了 BRAND（不再复制一份字面量）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..", "..");

function read(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

/** 用户 2026-10-22 确认的站点描述（T-103）。 */
const SITE_DESCRIPTION = "HaHart · AI 创意画布";

/** 用户 2026-10-22 确认的产品一句话介绍（T-103）。 */
const ONE_LINE_PITCH = "对话即可出图、改图的 AI 设计画布";

describe("BR-17 brand copy", () => {
  it("BR-17: the site description is the confirmed copy", () => {
    // 文案的唯一来源是 BRAND（BR-19）；layout.tsx 只负责把它交给 metadata。
    expect(BRAND.name, "BRAND.name 不是确认的品牌名").toBe("HaHart");
    expect(BRAND.description, "BRAND.description 不是确认的站点描述").toBe(
      SITE_DESCRIPTION,
    );

    const source = read("src/app/layout.tsx");
    expect(source, "layout.tsx 没把 title 交给 BRAND").toContain("title: BRAND.name");
    expect(source, "layout.tsx 没把 description 交给 BRAND").toContain(
      "description: BRAND.description",
    );
    // metadata / openGraph / twitter 三处都要走 BRAND，漏一处就会有一处文案漂移。
    expect(
      source.split("title: BRAND.name").length - 1,
      "layout.tsx 的 title 引用 BRAND.name 不是 3 处",
    ).toBe(3);
    expect(
      source.split("description: BRAND.description").length - 1,
      "layout.tsx 的 description 引用 BRAND.description 不是 3 处",
    ).toBe(3);
    expect(source, "layout.tsx 仍含旧描述").not.toContain(
      "AI-powered creative workspace",
    );
  });

  it("BR-17: the footer carries the brand and the one-line pitch", () => {
    const source = read("src/components/landing/landing-footer.tsx");

    expect(source, "页脚缺一句话介绍").toContain(ONE_LINE_PITCH);
    expect(source, "页脚缺品牌名版权栏").toContain("HaHart. All rights reserved.");
    expect(source, "页脚仍含旧品牌名").not.toContain("Loomic");
    expect(source, "页脚仍含旧一句话介绍").not.toContain("AI 驱动的创意设计平台");
  });

  it("BR-17: skill docs no longer name the old brand", () => {
    for (const relPath of ["../../skills/canvas-design/SKILL.md", "../../skills/json-image-prompt/SKILL.md"]) {
      const source = read(relPath);
      expect(source.toLowerCase(), `${relPath} 仍含旧品牌名`).not.toContain("loomic");
    }
    expect(readRepo("skills/canvas-design/SKILL.md"), "canvas-design 缺新品牌名").toContain(
      "adapted-for: hahart",
    );
    expect(readRepo("skills/json-image-prompt/SKILL.md"), "json-image-prompt 缺新品牌名").toContain(
      "author: hahart",
    );
  });
});
