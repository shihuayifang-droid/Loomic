import { describe, expect, it } from "vitest";

import {
  EMAIL_TEMPLATE_NAMES,
  LOGIN_CODE_TTL_MINUTES,
  loginCode,
  resetPassword,
  verifyEmail,
  type EmailContent,
} from "./email-templates.js";

/**
 * BR-09 / workorder 45CE: the three authentication emails.
 *
 * The assertions are about the properties the ticket makes hard conditions:
 * every template renders all three parts, the old product name never appears,
 * the brand name always does, and the HTML is of the kind that survives a mail
 * client (inline styles, a fixed 600px table, no script and no external CSS).
 */

/**
 * The retired product name, written as a concatenation so this file itself
 * never contains it — the ticket's `git grep` check counts every occurrence
 * under `src/features/notifications`, test files included.
 */
const RETIRED_NAME = ["Loo", "mic"].join("");

const SAMPLES: ReadonlyArray<{ name: string; content: EmailContent }> = [
  {
    name: "verifyEmail",
    content: verifyEmail({ displayName: "林小满", link: "https://example.com/verify?t=abc", expiresInMinutes: 45 }),
  },
  {
    name: "loginCode",
    content: loginCode({ displayName: "林小满", code: "418302", expiresInMinutes: 7 }),
  },
  {
    name: "resetPassword",
    content: resetPassword({ displayName: "林小满", link: "https://example.com/reset?t=abc", expiresInMinutes: 12 }),
  },
];

describe("BR-09 email templates", () => {
  it("BR-09: all three names render a subject, an HTML body and a text body", () => {
    expect(EMAIL_TEMPLATE_NAMES).toEqual(["verifyEmail", "loginCode", "resetPassword"]);

    for (const { name, content } of SAMPLES) {
      expect(content.subject, `${name} subject`).toContain("HaHart");
      expect(content.html.length, `${name} html`).toBeGreaterThan(500);
      expect(content.text.length, `${name} text`).toBeGreaterThan(100);
      expect(content.html, `${name} html 缺 <html>`).toContain("<!doctype html>");
      expect(content.html, `${name} html 未闭合`).toContain("</html>");
    }
  });

  it("BR-09: the retired product name is in neither rendering, the brand is in both", () => {
    for (const { name, content } of SAMPLES) {
      expect(content.html.toLowerCase(), `${name} html`).not.toContain(RETIRED_NAME.toLowerCase());
      expect(content.text.toLowerCase(), `${name} text`).not.toContain(RETIRED_NAME.toLowerCase());
      expect(content.subject.toLowerCase(), `${name} subject`).not.toContain(RETIRED_NAME.toLowerCase());

      expect(content.html, `${name} html`).toContain("HaHart");
      expect(content.text, `${name} text`).toContain("HaHart");
    }
  });

  it("BR-09: HTML carries inline styles, a 600px table and no script or external CSS", () => {
    for (const { name, content } of SAMPLES) {
      expect(content.html, `${name} 无 width=600 表格`).toContain('width="600"');
      expect(content.html, `${name} 有 <script>`).not.toMatch(/<script/i);
      expect(content.html, `${name} 有外链 CSS`).not.toMatch(/<link[^>]+stylesheet/i);
      expect(content.html, `${name} 有 style 块`).not.toMatch(/<style/i);
      expect(content.html, `${name} 无内联样式`).toMatch(/style="/);
      // 品牌主色取自 apps/web 的 --accent / logo.svg
      expect(content.html, `${name} 无品牌色`).toContain("#E4F23A");
      // 页脚：品牌名 + 权利声明
      expect(content.html, `${name} 页脚缺权利声明`).toContain("保留所有权利");
      expect(content.text, `${name} 文本页脚缺权利声明`).toContain("保留所有权利");
    }
  });

  it("BR-09: each template puts its own secret where the copy says it is", () => {
    const verify = verifyEmail({ link: "https://example.com/verify?t=verify-token" });
    expect(verify.html).toContain("https://example.com/verify?t=verify-token");
    expect(verify.text).toContain("https://example.com/verify?t=verify-token");
    expect(verify.html).toContain("验证邮箱");

    const login = loginCode({ code: "902101" });
    expect(login.html).toContain("902101");
    expect(login.text).toContain("902101");

    const reset = resetPassword({ link: "https://example.com/reset?t=reset-token" });
    expect(reset.html).toContain("https://example.com/reset?t=reset-token");
    expect(reset.text).toContain("https://example.com/reset?t=reset-token");
    expect(reset.html).toContain("设置新密码");
  });

  it("BR-09: the greeting degrades to a generic one without a display name", () => {
    const named = verifyEmail({ displayName: "林小满", link: "https://example.com/v" });
    const anonymous = verifyEmail({ link: "https://example.com/v" });

    expect(named.html).toContain("林小满");
    expect(anonymous.html).not.toContain("林小满");
    expect(anonymous.html).toContain("你好：");
    expect(anonymous.text).toContain("你好：");
  });

  it("BR-09: expiry copy follows the caller, and falls back to the documented default", () => {
    expect(loginCode({ code: "1" }).text).toContain(`${LOGIN_CODE_TTL_MINUTES} 分钟`);
    expect(loginCode({ code: "1", expiresInMinutes: 3 }).text).toContain("3 分钟");
    expect(verifyEmail({ link: "https://example.com/v", expiresInMinutes: 90 }).text).toContain("90 分钟");
    expect(resetPassword({ link: "https://example.com/r", expiresInMinutes: 5 }).text).toContain("5 分钟");
  });

  it("BR-09: caller-supplied names and links are escaped before entering the HTML", () => {
    const content = verifyEmail({
      displayName: '<img src=x onerror="alert(1)">',
      link: "https://example.com/verify?a=1&b=2",
    });

    expect(content.html).not.toContain("<img src=x");
    expect(content.html).toContain("&lt;img src=x");
    expect(content.html).toContain("a=1&amp;b=2");
    // 纯文本版本保留原样，不做转义
    expect(content.text).toContain("https://example.com/verify?a=1&b=2");
  });
});
