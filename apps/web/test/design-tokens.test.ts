import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

/**
 * 工单 45DN / BR-12：设计系统守卫。
 *
 * 七类组件（按钮 / 输入 / 面板 / 工具条 / 胶囊 / 占位 / toast）的颜色只能来自
 * `app/globals.css` 里的品牌色 token（`--accent` / `--primary` / `--muted` …），
 * 组件里不许再写裸色值，否则 BR-04 定的品牌色一改，这些地方就掉队了。
 *
 * 不渲染组件：颜色写在 className 和 inline style 里，渲染出来的 DOM 断言依赖
 * jsdom 的样式实现，读源码子串更稳（同 BR-04 的 `brand-theme.test.ts`）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");

function read(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

/** 七类组件各自的实现文件，逐个来自 BR-12 的审计表。 */
const CATEGORIES: { name: string; files: string[] }[] = [
  { name: "按钮", files: ["src/components/ui/button.tsx"] },
  {
    name: "输入",
    files: ["src/components/ui/input.tsx", "src/components/home-prompt.tsx"],
  },
  {
    name: "面板",
    files: [
      "src/components/canvas/tool-panel-host.tsx",
      "src/components/skills/marketplace-panel.tsx",
      "src/components/skills/skill-card.tsx",
    ],
  },
  {
    name: "工具条",
    files: [
      "src/components/canvas/image-toolbar.tsx",
      "src/components/canvas-tool-menu.tsx",
    ],
  },
  { name: "胶囊", files: ["src/components/chat/mention-pill.tsx"] },
  {
    name: "占位",
    files: [
      "src/components/media/generation-shimmer.tsx",
      "src/components/ui/skeleton.tsx",
    ],
  },
  { name: "toast", files: ["src/components/toast.tsx"] },
];

/** 裸十六进制色值：`#fff` / `#ffffff` / `#ffffff80` 都算。 */
const BARE_HEX = /#[0-9a-fA-F]{3,8}\b/;

/**
 * `rgb(` / `rgba(` / `hsl(` / `hsla(`：颜色函数。
 * 不加 `\b`：`shadow-[0_4px_8px_rgba(…)]` 里 `rgba` 前面是下划线，也算词内字符，
 * 加了边界就漏了（实测过）。
 */
const COLOUR_FUNCTION = /(?:rgba?|hsla?)\(/;

/** tailwind 任意值写色：`bg-[#123456]`、`text-[#fff]`、`shadow-[…rgba(…)]` 之类。 */
const ARBITRARY_COLOUR =
  /\b(?:bg|text|border|ring|outline|from|via|to|fill|stroke|decoration|shadow)-\[[^\]]*(?:#[0-9a-fA-F]|rgba?\(|hsla?\()/;

/**
 * 允许列表：这些色值在设计系统里**确实**没有对应 token，按工单第 4 条保持原值，
 * 由主 Agent 决定是否补语义 token。
 *
 * 规则：每条都必须写明理由；`literal` 必须原样出现在文件里，否则本条过期、测试
 * 直接失败 —— 只许一条条加，不许整文件放行。
 */
const ALLOWED: { file: string; literal: string; reason: string }[] = [
  {
    file: "src/components/home-prompt.tsx",
    literal: "shadow-[0_4px_8px_rgba(0,0,0,0.04)]",
    reason:
      "输入面板投影：globals.css 只有 shadow-subtle/card/card-hover/float 四个工具类，没有按透明黑分档的阴影 token（缺 --shadow-*），换 utility 会改变投影大小",
  },
  {
    file: "src/components/skills/marketplace-panel.tsx",
    literal: 'boxShadow: "0 4px 12px rgba(0,0,0,0.06)"',
    reason:
      "卡片 hover 投影：同上，设计系统没有 hover 阴影 token（缺 --shadow-hover），保持原值不改视觉",
  },
  {
    file: "src/components/skills/skill-card.tsx",
    literal: 'boxShadow: "0 4px 12px rgba(0,0,0,0.06)"',
    reason:
      "卡片 hover 投影：同上，设计系统没有 hover 阴影 token（缺 --shadow-hover），保持原值不改视觉",
  },
];

/**
 * 去掉注释（工单允许注释里出现说明性色值）。
 * 行注释里带 `://` 的是字符串里的 URL，不是注释，所以要求 `//` 前面不是冒号。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 返回该文件里所有裸色值行（`文件:行号: 源码`），空数组 = 干净。 */
function bareColours(relPath: string): string[] {
  let source = read(relPath);

  for (const entry of ALLOWED) {
    if (entry.file !== relPath) continue;

    expect(
      source,
      `${relPath} 的允许条目已过期，请删掉：${entry.literal}`,
    ).toContain(entry.literal);

    source = source.split(entry.literal).join("");
  }

  const found: string[] = [];

  stripComments(source)
    .split("\n")
    .forEach((line, index) => {
      if (
        BARE_HEX.test(line) ||
        COLOUR_FUNCTION.test(line) ||
        ARBITRARY_COLOUR.test(line)
      ) {
        found.push(`${relPath}:${index + 1}: ${line.trim()}`);
      }
    });

  return found;
}

it("BR-12: 七类组件里没有裸色值，颜色只从品牌色 token 取", () => {
  for (const category of CATEGORIES) {
    for (const file of category.files) {
      expect(bareColours(file), `${category.name} · ${file} 还有裸色值`).toEqual(
        [],
      );
    }
  }
});

it("BR-12: 守卫覆盖七类组件，允许列表每条都写了理由", () => {
  expect(CATEGORIES.map((category) => category.name)).toEqual([
    "按钮",
    "输入",
    "面板",
    "工具条",
    "胶囊",
    "占位",
    "toast",
  ]);

  for (const entry of ALLOWED) {
    expect(
      entry.reason.length,
      `${entry.file} 的允许条目没写清理由`,
    ).toBeGreaterThan(10);
  }
});

it("BR-12: 扫光的亮色来自主题 token，不是写死的白色", () => {
  const sweeps = [
    "src/components/media/generation-shimmer.tsx",
    "src/components/canvas-tool-menu.tsx",
  ];

  for (const file of sweeps) {
    const source = read(file);

    expect(source, `${file} 的扫光没用 --background`).toContain(
      "var(--background)",
    );
    expect(source, `${file} 的扫光还写死白色`).not.toContain(
      "rgba(255,255,255",
    );
  }
});
