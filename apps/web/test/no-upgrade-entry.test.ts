import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * BL-40（工单 38R）源码级断言：全站不再出现订阅档位 / 升级入口。
 *
 * 三个入口原来都指向 `/pricing`：
 *   1) 顶栏 `credit-header-button.tsx` 的「升级」Link；
 *   2) 侧栏 `credit-balance.tsx` 弹层里的「Upgrade Plan」Link；
 *   3) 账单页 `billing-section.tsx` 的「Upgrade Plan / Change Plan」按钮。
 *
 * 读源码文本而不渲染：这类断言要的是「入口不在源码里」，渲染级用例只能看到当前分支。
 * 读文件的写法照 `testid-lint.test.ts`（`import.meta.url` + `node:fs`）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS_ROOT = path.join(HERE, "..", "src", "components");

function readComponent(...segments: string[]): string {
  return fs.readFileSync(path.join(COMPONENTS_ROOT, ...segments), "utf8");
}

describe("BL-40 no upgrade entry", () => {
  it("BL-40: the top bar has no upgrade link", () => {
    const source = readComponent("credits", "credit-header-button.tsx");
    expect(source).not.toContain('href="/pricing"');
    expect(source).not.toContain(">升级<");
    expect(source).not.toContain("<span>升级</span>");
  });

  it("BL-40: the sidebar balance has no upgrade link", () => {
    const source = readComponent("credits", "credit-balance.tsx");
    expect(source).not.toContain('href="/pricing"');
    expect(source).not.toContain("Upgrade Plan");
  });

  it("BL-40: the billing section has no plan change button", () => {
    const source = readComponent("billing-section.tsx");
    expect(source).not.toContain("account-billing-plan-change");
    expect(source).not.toContain('href="/pricing"');
  });

  it("BL-40: the top bar popover shows no plan badge", () => {
    const source = readComponent("credits", "credit-header-button.tsx");
    expect(source).not.toContain("PLAN_COLORS");
    expect(source).not.toContain("{plan}</span>");
  });

  it("BL-40: the sidebar popover shows no plan badge", () => {
    const source = readComponent("credits", "credit-balance.tsx");
    expect(source).not.toContain("PLAN_COLORS");
    expect(source).not.toContain("{plan}</span>");
  });
});
