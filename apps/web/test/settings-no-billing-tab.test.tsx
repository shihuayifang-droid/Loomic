import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * BL-40（工单 40H）源码级断言：设置页不再出现订阅页签。
 *
 * 读文件的写法照 `test/pricing-retired.test.ts`（`import.meta.url` + `node:fs`）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(HERE, "..", "src");

const settingsSource = fs.readFileSync(
  path.join(SRC_ROOT, "app", "(workspace)", "settings", "page.tsx"),
  "utf8",
);
const insufficientDialogSource = fs.readFileSync(
  path.join(SRC_ROOT, "components", "credits", "credit-insufficient-dialog.tsx"),
  "utf8",
);

describe("BL-40 settings has no billing tab", () => {
  it("BL-40: the settings page has no Billing tab", () => {
    expect(settingsSource).not.toContain('label: "Billing"');
    expect(settingsSource).not.toContain("BillingSection");
  });

  it("BL-40: an old billing deep link opens usage", () => {
    expect(settingsSource).toMatch(/"billing"\s*\?\s*"usage"/);
  });

  it("BL-40: the top-up link lands on usage", () => {
    expect(insufficientDialogSource).toContain('href="/settings?tab=usage"');
    expect(insufficientDialogSource).not.toContain("tab=billing");
  });
});
