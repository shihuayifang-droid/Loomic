import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * BR-05 logo 资源落地（工单 40W）
 *
 * 源码断言，不渲染组件：组件是纯 SVG，直接读源码子串更稳。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");

const LOGO_COMPONENT = "src/components/icons/hahart-logo.tsx";

/** 部署了 logo 的 5 个引用文件（工单 40W 白名单）。 */
const LOGO_CONSUMERS = [
  "src/app/(workspace)/home/page.tsx",
  "src/app/pricing/components/pricing-nav.tsx",
  "src/components/app-sidebar.tsx",
  "src/components/auth/auth-shell.tsx",
  "src/components/canvas-logo-menu.tsx",
];

function read(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(WEB_ROOT, relPath));
}

describe("BR-05 logo", () => {
  it("the logo component is HaHart's", () => {
    expect(exists(LOGO_COMPONENT), `${LOGO_COMPONENT} 不存在`).toBe(true);

    const source = read(LOGO_COMPONENT);

    expect(source).toContain("#E4F23A");
    expect(source).toContain("M18 16 h7 v13");
    expect(exists("src/components/icons/loomic-logo.tsx")).toBe(false);
  });

  it("no screen imports the old logo", () => {
    for (const relPath of LOGO_CONSUMERS) {
      const source = read(relPath);

      expect(source, `${relPath} 仍引用 LoomicLogo`).not.toContain("LoomicLogo");
      expect(source, `${relPath} 仍引用 loomic-logo`).not.toContain("loomic-logo");
      expect(source, `${relPath} 未使用 HaHartLogo`).toContain("HaHartLogo");
    }
  });

  it("the dark variant swaps the colours", () => {
    const source = read(LOGO_COMPONENT);
    const start = source.indexOf("export function HaHartLogoInverted");
    const inverted = source.slice(start);

    expect(start).toBeGreaterThan(-1);
    expect(inverted).toContain('fill="#111111"');
    expect(inverted).toContain('fill="#E4F23A"');
  });
});
