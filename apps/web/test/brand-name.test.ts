import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BRAND } from "../src/lib/brand";

/**
 * BR-17 界面产品名统一为 HaHart（工单 37K T2；45D1-fixup1 改断言口径）
 *
 * 源码断言，不渲染组件：本组用例只关心「页面 chrome 上的品牌名从哪来」。
 *
 * 断言口径（为什么不再断言源码里含 `HaHart` 字面量）：
 *   - BR-19 把品牌名收敛到 `src/lib/brand.ts` 的 `BRAND`，`HaHart` 只在那一个
 *     文件里拼写。再要求组件源码里出现 `HaHart` 字面量，与「品牌名单一来源」
 *     直接互斥（与 45D0-fixup1 修的 `brand-copy.test.ts` 是同一类毛病）。
 *   - 所以这里改成断言「品牌名来自单一来源」，三件事合起来仍然锁住
 *     「每个页面 chrome 都叫 HaHart」：
 *       1. `BRAND.name` 就是 `HaHart` —— 唯一来源里的名字没被改坏；
 *       2. 7 个 chrome 文件都从 `lib/brand` 引入 `BRAND` 且真的用了 `BRAND.name`
 *          —— 名字确实是从唯一来源取的，不是各写各的；
 *       3. 这些文件里没有 `HaHart` 裸字面量（`HaHartLogo` 这类组件标识符不算）
 *          —— 没有第二处拼写品牌名的地方。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");

function read(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

/** 工单「现状」列出的 7 个源文件（页面 chrome）。 */
const CHROME_FILES: ReadonlyArray<string> = [
  "src/app/pricing/components/pricing-cta.tsx",
  "src/components/app-sidebar.tsx",
  "src/components/auth/auth-shell.tsx",
  "src/components/landing/feature-showcase.tsx",
  "src/components/landing/floating-nav.tsx",
  "src/components/landing/hero-section.tsx",
  "src/components/landing/how-it-works.tsx",
];

/** 品牌名的唯一来源引用：`from "@/lib/brand"` / `from "../lib/brand"` 之类。 */
const BRAND_IMPORT = /from\s+["'][^"']*\/lib\/brand["']/;

/** 真的用上了唯一来源里的名字（只 import 不用 = 名字没接上）。 */
const BRAND_REFERENCE = /\bBRAND\.name\b/;

/** 裸的品牌名字面量；`HaHartLogo` / `HaHartLogoInverted` 是标识符，不算。 */
const BARE_BRAND_LITERAL = /HaHart(?!Logo)/;

/**
 * 每一处 chrome 文案：旧文本（写死的旧名，必须消失）→ 走 `BRAND` 的新文本
 * （必须出现，且值来自唯一来源，不是又拷了一份字面量）。
 */
const RENAMED_CHROME: ReadonlyArray<{ file: string; before: string; after: string }> = [
  {
    file: "src/app/pricing/components/pricing-cta.tsx",
    before: "&copy; 2026 Loomic. All rights reserved.",
    after: "&copy; 2026 {BRAND.name}. All rights reserved.",
  },
  {
    file: "src/components/app-sidebar.tsx",
    before: 'title="Loomic"',
    after: "title={BRAND.name}",
  },
  {
    file: "src/components/auth/auth-shell.tsx",
    before: ">Loomic</h1>",
    after: ">{BRAND.name}</h1>",
  },
  {
    file: "src/components/landing/feature-showcase.tsx",
    before: "Loomic 理解你的设计需求",
    after: "${BRAND.name} 理解你的设计需求",
  },
  {
    file: "src/components/landing/feature-showcase.tsx",
    before: "Loomic 不只是生成工具",
    after: "${BRAND.name} 不只是生成工具",
  },
  {
    file: "src/components/landing/floating-nav.tsx",
    before: 'tracking-tight">Loomic</span>',
    after: 'tracking-tight">{BRAND.name}</span>',
  },
  {
    file: "src/components/landing/hero-section.tsx",
    before: 'alt="Loomic Canvas AI creative workspace"',
    after: "alt={`${BRAND.name} Canvas AI creative workspace`}",
  },
  {
    file: "src/components/landing/how-it-works.tsx",
    before: "Loomic 分析你的需求",
    after: "${BRAND.name} 分析你的需求",
  },
];

describe("BR-17 brand name", () => {
  it("BR-17: the product is called HaHart on every page chrome", () => {
    // 1) 唯一来源里的名字就是 HaHart（品牌名不能被悄悄改掉）。
    expect(BRAND.name, "BRAND.name 不是 HaHart").toBe("HaHart");

    // 2) + 3) 每个 chrome 文件都从唯一来源取名字，且不再自己拼一份字面量。
    for (const file of CHROME_FILES) {
      const source = read(file);
      expect(source, `${file} 没有从 lib/brand 引入 BRAND`).toMatch(BRAND_IMPORT);
      expect(source, `${file} 没有使用 BRAND.name（品牌名不来自单一来源）`).toMatch(
        BRAND_REFERENCE,
      );
      expect(source, `${file} 里又出现了 HaHart 裸字面量`).not.toMatch(BARE_BRAND_LITERAL);
    }

    for (const { file, before, after } of RENAMED_CHROME) {
      const source = read(file);
      expect(source, `${file} 仍含旧产品名：${before}`).not.toContain(before);
      expect(source, `${file} 缺走 BRAND 的文案：${after}`).toContain(after);
    }

    const heroSource = read("src/components/landing/hero-section.tsx");
    expect(heroSource, "hero-section 仍含旧标题：Loomic Canvas").not.toContain("Loomic Canvas");
    expect(heroSource, "hero-section 仍含旧正文：Loomic 是你的").not.toContain("Loomic 是你的");
  });

  it("BR-17: example seed prompts are content, not branding, and stay as written", () => {
    expect(read("src/lib/home-example-seeds.ts")).toContain("furniture shop called Loomic");
  });
});
