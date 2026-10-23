import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "../src/lib/content-security-policy";

/**
 * 工单40Y / OP-17 前端 CSP
 *
 * 断言策略字符串本身就够了 —— 静态导出没有运行时，`layout.tsx` 里的 meta 标签
 * 只是把这里的结果贴进 HTML，所以同时校对一眼源码，防止有人把 meta 又删掉。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");

const POLICY = buildContentSecurityPolicy({
  serverBaseUrl: "https://api.hahart.test/base",
  supabaseUrl: "https://abc.supabase.co",
});

/** 取出单条 directive 的源列表 */
function sourcesOf(directive: string): string[] {
  const match = POLICY.split("; ")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `));

  expect(match).toBeDefined();

  return (match ?? "").split(/\s+/).slice(1);
}

describe("buildContentSecurityPolicy", () => {
  it("connect-src 只放行 origin：服务端、它的 wss 形式、Supabase", () => {
    const sources = sourcesOf("connect-src");

    expect(sources).toContain("https://api.hahart.test");
    expect(sources).toContain("wss://api.hahart.test");
    expect(sources).toContain("https://abc.supabase.co");
    // 路径不许泄漏进策略：CSP 里带 /base 只会放行该路径下的请求
    expect(sources).not.toContain("/base");
    expect(POLICY).not.toContain("/base");
  });

  it("frame-ancestors / object-src 收紧到 'none'", () => {
    expect(sourcesOf("frame-ancestors")).toEqual(["'none'"]);
    expect(sourcesOf("object-src")).toEqual(["'none'"]);
    expect(sourcesOf("default-src")).toEqual(["'self'"]);
    expect(sourcesOf("base-uri")).toEqual(["'self'"]);
    expect(sourcesOf("form-action")).toEqual(["'self'"]);
  });

  it("supabaseUrl 缺省时策略里不出现 undefined", () => {
    const policy = buildContentSecurityPolicy({
      serverBaseUrl: "https://api.hahart.test",
    });

    expect(policy).not.toContain("undefined");
    expect(policy).toContain("https://api.hahart.test");
  });

  it("非法 URL 被跳过，不产生空源也不产生 undefined", () => {
    const policy = buildContentSecurityPolicy({
      serverBaseUrl: "not a url",
      supabaseUrl: "",
    });

    expect(policy).not.toContain("undefined");
    expect(policy).not.toContain("  ");
    expect(policy).toContain("connect-src 'self'");
  });

  it("layout.tsx 带 CSP meta 标签，且不再引用 lemonsqueezy", () => {
    const layout = fs.readFileSync(
      path.join(WEB_ROOT, "src/app/layout.tsx"),
      "utf8",
    );

    expect(layout).toContain('httpEquiv="Content-Security-Policy"');
    expect(layout).not.toContain("lemonsqueezy");
  });
});
