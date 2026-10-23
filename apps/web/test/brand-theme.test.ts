import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

/**
 * 工单 40X：落地页 / 加载页 logo、logo.svg、主题状态色。
 *
 * 不渲染组件：纯 SVG 与 CSS 直接读源码子串 / 解析声明更稳。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");

function read(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

/** BR-05：仍在画旧花瓣图形的 3 个界面文件。 */
const LEGACY_LOGO_SOURCES = [
  "src/components/landing/floating-nav.tsx",
  "src/components/landing/landing-footer.tsx",
  "src/components/loading-screen.tsx",
];

const LEGACY_PETAL_PATH = "M50 4 C56 4";

/** BR-04：确认色板里浅色主题的 9 个状态色键。 */
const LIGHT_STATE_COLOURS: Record<string, string> = {
  "--destructive": "#C2261C",
  "--success": "#1F7A3D",
  "--warning": "#8A5A00",
  "--info": "#1D5FD1",
  "--success-foreground": "#FFFFFF",
  "--warning-foreground": "#FFFFFF",
  "--info-foreground": "#FFFFFF",
  "--accent": "#E4F23A",
  "--ring": "#E4F23A",
};

/** BR-04：确认色板里深色主题的 7 个状态色键。 */
const DARK_STATE_COLOURS: Record<string, string> = {
  "--destructive": "#F87171",
  "--success": "#4ADE80",
  "--warning": "#FBBF24",
  "--info": "#60A5FA",
  "--success-foreground": "#111111",
  "--warning-foreground": "#111111",
  "--info-foreground": "#111111",
};

const STATE_COLOUR_KEYS = ["--destructive", "--success", "--warning", "--info"];

/** 状态色作为文字时所在的底色。 */
const LIGHT_BACKGROUND = "#FFFFFF";
const DARK_BACKGROUND = "#111111";

function declarations(cssBlock: string): Record<string, string> {
  const found: Record<string, string> = {};
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(cssBlock)) !== null) {
    const key = match[1];
    const value = match[2];

    if (key !== undefined && value !== undefined) {
      found[key] = value.trim();
    }
  }

  return found;
}

function themeBlock(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`^${escaped}\\s*\\{([\\s\\S]*?)^\\}`, "m").exec(css);
  const body = block?.[1];

  if (body === undefined) {
    throw new Error(`globals.css 中找不到 ${selector} 块`);
  }

  return declarations(body);
}

/** 从解析出的主题声明里取一个键，缺失直接失败而不是静默 undefined。 */
function declaredColour(table: Record<string, string>, key: string): string {
  const value = table[key];

  if (value === undefined) {
    throw new Error(`主题里没有 ${key}`);
  }

  return value;
}

function channelToLinear(value: number): number {
  const channel = value / 255;

  return channel <= 0.03928
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x 相对亮度。 */
function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = channelToLinear(parseInt(value.slice(0, 2), 16));
  const g = channelToLinear(parseInt(value.slice(2, 4), 16));
  const b = channelToLinear(parseInt(value.slice(4, 6), 16));

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x 对比度。 */
function contrastRatio(foreground: string, background: string): number {
  const one = relativeLuminance(foreground);
  const two = relativeLuminance(background);
  const lighter = Math.max(one, two);
  const darker = Math.min(one, two);

  return (lighter + 0.05) / (darker + 0.05);
}

it("BR-05: no screen draws the old petal logo", () => {
  for (const relPath of LEGACY_LOGO_SOURCES) {
    const source = read(relPath);

    expect(source, `${relPath} 仍含旧花瓣路径`).not.toContain(LEGACY_PETAL_PATH);
    expect(source, `${relPath} 未使用 HaHartLogo`).toContain("HaHartLogo");
  }

  const logoSvg = read("public/logo.svg");

  expect(logoSvg, "logo.svg 仍含旧花瓣路径").not.toContain(LEGACY_PETAL_PATH);
  expect(logoSvg, "logo.svg 未使用品牌绿").toContain("#E4F23A");
});

it("BR-04: the theme uses the approved state colours", () => {
  const css = read("src/app/globals.css");
  const light = themeBlock(css, ":root");
  const dark = themeBlock(css, ".dark");

  for (const [key, value] of Object.entries(LIGHT_STATE_COLOURS)) {
    expect(light[key], `浅色 ${key}`).toBe(value);
  }

  for (const [key, value] of Object.entries(DARK_STATE_COLOURS)) {
    expect(dark[key], `深色 ${key}`).toBe(value);
  }
});

it("BR-04: every state colour passes WCAG AA as text on its background", () => {
  const css = read("src/app/globals.css");
  const light = themeBlock(css, ":root");
  const dark = themeBlock(css, ".dark");

  for (const key of STATE_COLOUR_KEYS) {
    const lightHex = declaredColour(light, key);
    const lightRatio = contrastRatio(lightHex, LIGHT_BACKGROUND);

    expect(
      lightRatio,
      `浅色 ${key} (${lightHex}) 对 ${LIGHT_BACKGROUND} 的对比度 ${lightRatio.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(4.5);

    const darkHex = declaredColour(dark, key);
    const darkRatio = contrastRatio(darkHex, DARK_BACKGROUND);

    expect(
      darkRatio,
      `深色 ${key} (${darkHex}) 对 ${DARK_BACKGROUND} 的对比度 ${darkRatio.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});
