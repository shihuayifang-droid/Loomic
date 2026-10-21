import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { redirect } from "next/navigation";

import PricingPage from "@/app/pricing/page";

/**
 * BL-40（工单 38S）源码级断言：订阅价格页下线。
 *
 * `/pricing` 整个替换为服务端重定向到 `/home`；落地页不再挂价格预览。
 * 读文件的写法照 `test/no-upgrade-entry.test.ts`（`import.meta.url` + `node:fs`）。
 */

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(HERE, "..", "src", "app");

describe("BL-40 pricing retired", () => {
  it("BL-40: /pricing redirects home", () => {
    expect(() => PricingPage()).toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/home");
  });

  it("BL-40: the landing page no longer shows the pricing preview", () => {
    const source = fs.readFileSync(path.join(APP_ROOT, "page.tsx"), "utf8");
    expect(source).not.toContain("PricingPreview");
    expect(source).not.toContain("pricing-preview");
  });
});
