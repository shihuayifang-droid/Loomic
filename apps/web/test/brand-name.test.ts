import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * BR-17 界面产品名统一为 HaHart（工单 37K T2）
 *
 * 源码断言，不渲染组件：本单只替换文案里的产品名词，不涉及逻辑。
 *
 * 断言口径（为什么不是「整份源码里一个 Loomic 都不许有」）：
 *   - 工单「现状」列出的待改处是 8 处，且「目标 1」要求其余字符一字不改、
 *     验收第 5 条要求每个文件只有 1 行增删（feature-showcase 2 行）。
 *   - `app-sidebar.tsx` / `auth-shell.tsx` / `floating-nav.tsx` 里还有
 *     `LoomicLogo` / `LoomicLogoInverted` 组件标识符（其中两个从
 *     `src/components/icons/loomic-logo.tsx` 导入，该文件不在本单白名单内），
 *     `hero-section.tsx` 还有 L111 `Loomic Canvas`、L271 正文里的名字，
 *     这两处不在工单列出的 8 处内。
 * 所以这里断言的是「8 处旧文本全部消失 + 7 个文件都出现新名」。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");

function read(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

/** 工单「现状」列出的 7 个源文件（共 8 处待改）。 */
const CHROME_FILES: ReadonlyArray<string> = [
  "src/app/pricing/components/pricing-cta.tsx",
  "src/components/app-sidebar.tsx",
  "src/components/auth/auth-shell.tsx",
  "src/components/landing/feature-showcase.tsx",
  "src/components/landing/floating-nav.tsx",
  "src/components/landing/hero-section.tsx",
  "src/components/landing/how-it-works.tsx",
];

/** 每一处替换：旧文本 → 新文本，名字之外的字符不动。 */
const RENAMED_CHROME: ReadonlyArray<{ file: string; before: string; after: string }> = [
  {
    file: "src/app/pricing/components/pricing-cta.tsx",
    before: "&copy; 2026 Loomic. All rights reserved.",
    after: "&copy; 2026 HaHart. All rights reserved.",
  },
  {
    file: "src/components/app-sidebar.tsx",
    before: 'title="Loomic"',
    after: 'title="HaHart"',
  },
  {
    file: "src/components/auth/auth-shell.tsx",
    before: ">Loomic</h1>",
    after: ">HaHart</h1>",
  },
  {
    file: "src/components/landing/feature-showcase.tsx",
    before: "Loomic 理解你的设计需求",
    after: "HaHart 理解你的设计需求",
  },
  {
    file: "src/components/landing/feature-showcase.tsx",
    before: "Loomic 不只是生成工具",
    after: "HaHart 不只是生成工具",
  },
  {
    file: "src/components/landing/floating-nav.tsx",
    before: 'tracking-tight">Loomic</span>',
    after: 'tracking-tight">HaHart</span>',
  },
  {
    file: "src/components/landing/hero-section.tsx",
    before: 'alt="Loomic Canvas AI creative workspace"',
    after: 'alt="HaHart Canvas AI creative workspace"',
  },
  {
    file: "src/components/landing/how-it-works.tsx",
    before: "Loomic 分析你的需求",
    after: "HaHart 分析你的需求",
  },
];

describe("BR-17 brand name", () => {
  it("BR-17: the product is called HaHart on every page chrome", () => {
    for (const file of CHROME_FILES) {
      expect(read(file), `${file} 里没有 HaHart`).toContain("HaHart");
    }

    for (const { file, before, after } of RENAMED_CHROME) {
      const source = read(file);
      expect(source, `${file} 仍含旧产品名：${before}`).not.toContain(before);
      expect(source, `${file} 缺新文本：${after}`).toContain(after);
    }

    const heroSource = read("src/components/landing/hero-section.tsx");
    expect(heroSource, "hero-section 仍含旧标题：Loomic Canvas").not.toContain("Loomic Canvas");
    expect(heroSource, "hero-section 仍含旧正文：Loomic 是你的").not.toContain("Loomic 是你的");
  });

  it("BR-17: example seed prompts are content, not branding, and stay as written", () => {
    expect(read("src/lib/home-example-seeds.ts")).toContain("furniture shop called Loomic");
  });
});
