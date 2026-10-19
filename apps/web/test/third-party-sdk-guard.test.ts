// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * X-04 第三方采集守卫。
 *
 * 三条断言：
 *   1. 依赖里不出现采集 / 埋点 SDK（装了就等于默认会上报）；
 *   2. 源码里不出现这些 SDK 的特征串（有人绕过依赖直接 hand-roll 也算）；
 *   3. 页面里能加载的第三方脚本 host 只有白名单那一个。
 *
 * 第 3 条的白名单是**这张测试里的唯一出处**：目前只有支付浮层的 lemon.js，
 * 它的去留取决于 payments 是否下线（待用户裁决），本单不动它。
 * 谁想再加一个外链脚本，必须同时改这一行 —— 那正是这条测试要拦的动作。
 */
/**
 * 从 cwd 往上找 `apps/web`：vitest 在 apps/web 里跑（`pnpm exec vitest run`），
 * 但同一条命令也可能从仓库根跑，所以两种都认，认不出来就直说。
 */
function findAppRoot(): string {
  const candidates = [process.cwd(), join(process.cwd(), "apps/web")];
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
      };
      if (pkg.name === "@loomic/web") return dir;
    } catch {
      // 这个候选目录不是 apps/web，试下一个
    }
  }
  throw new Error(`找不到 apps/web（从 ${process.cwd()} 起）`);
}

const APP_ROOT = findAppRoot();
const SRC_ROOT = join(APP_ROOT, "src");

/** 外部脚本 host 白名单：lemon.js（去留待 payments 裁决） */
const ALLOWED_SCRIPT_HOSTS: readonly string[] = ["app.lemonsqueezy.com"];

// ---------------------------------------------------------------------------
// 守卫本体（放在测试里，产品代码不需要为「证明自己干净」多一个模块）
// ---------------------------------------------------------------------------

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** 采集 / 埋点族的依赖名前缀，命中即违规 */
const SDK_NAME_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "posthog", pattern: /posthog/i },
  { name: "gtag", pattern: /\bgtag\b/i },
  { name: "google-analytics", pattern: /google-analytics/i },
  { name: "segment", pattern: /\bsegment\b/i },
  { name: "mixpanel", pattern: /mixpanel/i },
  { name: "@sentry", pattern: /^@sentry\//i },
  { name: "@vercel/analytics", pattern: /^@vercel\/analytics/i },
  { name: "speed-insights", pattern: /speed-insights/i },
  { name: "hotjar", pattern: /hotjar/i },
  { name: "clarity", pattern: /\bclarity\b/i },
  { name: "amplitude", pattern: /amplitude/i },
  { name: "heap", pattern: /\bheap\b/i },
  { name: "fbq", pattern: /\bfbq\b/i },
  { name: "tiktok", pattern: /tiktok/i },
  { name: "umami", pattern: /umami/i },
  { name: "plausible", pattern: /plausible/i },
];

/**
 * 返回命中的依赖名。抽成函数是为了第 4 条反向自检：
 * 喂一份假的 package.json，守卫必须能把它检出来 —— 否则这条守卫只是摆设。
 */
function findBlacklistedDependencies(pkg: PackageJson): string[] {
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
  return names.filter((name) =>
    SDK_NAME_PATTERNS.some(({ pattern }) => pattern.test(name)),
  );
}

/** 采集 SDK 的特征串：源码里出现任何一个都算违规 */
const SDK_SOURCE_SIGNATURES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "posthog", pattern: /\bposthog\b/i },
  { name: "googletagmanager", pattern: /googletagmanager/i },
  { name: "google-analytics", pattern: /google-analytics/i },
  { name: "segment", pattern: /segment\.(io|com)/i },
  { name: "mixpanel", pattern: /mixpanel/i },
  { name: "sentry", pattern: /\bsentry\b/i },
  { name: "vercel analytics", pattern: /@vercel\/analytics|speed-insights/i },
  { name: "hotjar", pattern: /hotjar/i },
  { name: "clarity", pattern: /clarity\.ms/i },
  { name: "amplitude", pattern: /amplitude/i },
  { name: "heap", pattern: /heapanalytics/i },
  { name: "fbq", pattern: /\bfbq\s*\(/i },
  { name: "tiktok", pattern: /tiktok/i },
  { name: "umami", pattern: /umami/i },
  { name: "plausible", pattern: /plausible/i },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `<Script src=` / `<script src=` 里的外链 host（相对路径不算，它不出网） */
function externalScriptHosts(dir: string): string[] {
  const tagPattern = /<\s*(?:Script|script)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g;
  const hosts = new Set<string>();
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(tagPattern)) {
      const src = match[1];
      if (!src || !/^https?:\/\//i.test(src)) continue;
      hosts.add(new URL(src).host);
    }
  }
  return [...hosts].sort();
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

describe("X-04 第三方采集守卫", () => {
  it("apps/web 的依赖名不命中采集 SDK 黑名单", () => {
    const pkg = JSON.parse(
      readFileSync(join(APP_ROOT, "package.json"), "utf8"),
    ) as PackageJson;
    expect(findBlacklistedDependencies(pkg)).toEqual([]);
  });

  it("src/**/*.{ts,tsx} 里没有采集 SDK 的特征串", () => {
    const files = sourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const { name, pattern } of SDK_SOURCE_SIGNATURES) {
        if (pattern.test(text)) hits.push(`${name} @ ${file}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("外链脚本 host 集合等于白名单（lemon.js 去留待 payments 裁决）", () => {
    expect(externalScriptHosts(SRC_ROOT)).toEqual([...ALLOWED_SCRIPT_HOSTS]);
  });

  it("反向自检：假 package.json 里放进 posthog-js，守卫必须检出来", () => {
    expect(
      findBlacklistedDependencies({ dependencies: { "posthog-js": "^1.0.0" } }),
    ).toEqual(["posthog-js"]);
    expect(
      findBlacklistedDependencies({
        dependencies: { react: "^19.0.0" },
        devDependencies: { "@sentry/nextjs": "^8.0.0" },
      }),
    ).toEqual(["@sentry/nextjs"]);
    // 干净的依赖表不许误报
    expect(
      findBlacklistedDependencies({
        dependencies: { react: "^19.0.0", next: "^15.0.0" },
        devDependencies: { vitest: "^3.0.0" },
      }),
    ).toEqual([]);
  });
});
