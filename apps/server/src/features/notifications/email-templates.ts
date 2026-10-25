/**
 * BR-09: the three authentication emails, as pure functions.
 *
 * WHY PURE FUNCTIONS AND NOT A TEMPLATE ENGINE
 * The server has no mail code at all today (see `mailer.ts` for the sending
 * half). These functions take a structured object and return
 * `{ subject, html, text }`; nothing here reads the environment, the clock, the
 * database or the filesystem, so the content can be asserted in a unit test and
 * reused by the `mail:preview` CLI without a network or a provider account.
 *
 * CHINESE COPY, BRAND FROM `apps/web`
 * The brand colour is `#E4F23A`, taken from `apps/web/src/app/globals.css`
 * (`--accent` / `--ring`) and `apps/web/public/logo.svg` — not invented here.
 * The rights line mirrors the site footer's `© 2026 <brand>. All rights
 * reserved.` wording, in Chinese.
 *
 * EMAIL-CLIENT SAFETY
 * Inline styles only, a 600px centred table, no external stylesheet and no
 * `<script>`: every mail client strips `<head>` CSS link tags and scripts, and
 * Outlook's Word renderer ignores most modern layout, which is why this is
 * table-and-inline-style HTML rather than anything from `apps/web`.
 */

export type EmailContent = {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
};

export type VerifyEmailInput = {
  /** Shown as a salutation prefix; omitted → a generic greeting. */
  readonly displayName?: string;
  /** Absolute verification URL. */
  readonly link: string;
  readonly expiresInMinutes?: number;
};

export type LoginCodeInput = {
  readonly displayName?: string;
  /** The one-time login code. */
  readonly code: string;
  readonly expiresInMinutes?: number;
};

export type ResetPasswordInput = {
  readonly displayName?: string;
  /** Absolute password-reset URL. */
  readonly link: string;
  readonly expiresInMinutes?: number;
};

export type EmailTemplateName = "verifyEmail" | "loginCode" | "resetPassword";

/** The three templates, keyed by name, for callers that enumerate them. */
export const EMAIL_TEMPLATE_NAMES: readonly EmailTemplateName[] = [
  "verifyEmail",
  "loginCode",
  "resetPassword",
];

// Brand facts — the only place they are written down for email.
const BRAND_NAME = "HaHart";
const BRAND_ACCENT = "#E4F23A";
const BRAND_INK = "#111111";
const BRAND_MUTED = "#5A5A5A";
const PAGE_BACKGROUND = "#F4F4F4";
const RULE = "#E4E4E4";

/** How long each link / code claims to stay valid when the caller is silent. */
export const VERIFY_LINK_TTL_MINUTES = 60;
export const LOGIN_CODE_TTL_MINUTES = 10;
export const RESET_LINK_TTL_MINUTES = 30;

const RIGHTS_LINE = "© 2026 HaHart 保留所有权利。";
const SYSTEM_FOOTNOTE = "本邮件由系统自动发送，请勿直接回复。";

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function salutation(displayName: string | undefined): string {
  const name = displayName?.trim();

  return name === undefined || name === "" ? "你好：" : `你好，${name}：`;
}

type LayoutOptions = {
  readonly title: string;
  readonly heading: string;
  readonly greeting: string;
  /** Already-escaped body markup. */
  readonly bodyHtml: string;
  /** Already-escaped body lines, one array item per paragraph. */
  readonly bodyLines: readonly string[];
};

/**
 * The shared chrome: header wordmark, white card on grey page, rule, footer.
 * Both renderings are produced from one options object so the HTML and the
 * plain text can never drift apart in word order.
 */
function layout(options: LayoutOptions): EmailContent {
  const html = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(options.title)}</title>`,
    "</head>",
    `<body style="margin:0;padding:0;background-color:${PAGE_BACKGROUND};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${PAGE_BACKGROUND};margin:0;padding:24px 12px;">`,
    "<tr><td align=\"center\" style=\"padding:0;\">",
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;border-radius:12px;border:1px solid ${RULE};font-family:${FONT_STACK};color:${BRAND_INK};">`,
    // header
    "<tr><td style=\"padding:28px 32px 20px 32px;border-bottom:3px solid " + BRAND_ACCENT + ";\">",
    `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background-color:${BRAND_ACCENT};margin-right:8px;"></span>`,
    `<span style="font-size:20px;font-weight:700;letter-spacing:0.4px;color:${BRAND_INK};">${BRAND_NAME}</span>`,
    "</td></tr>",
    // body
    '<tr><td style="padding:28px 32px 8px 32px;">',
    `<h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.4;font-weight:700;color:${BRAND_INK};">${escapeHtml(options.heading)}</h1>`,
    `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.7;color:${BRAND_INK};">${escapeHtml(options.greeting)}</p>`,
    options.bodyHtml,
    "</td></tr>",
    // footer
    "<tr><td style=\"padding:20px 32px 28px 32px;border-top:1px solid " + RULE + ";\">",
    `<p style="margin:0 0 8px 0;font-size:12px;line-height:1.7;color:${BRAND_MUTED};">${escapeHtml(RIGHTS_LINE)}</p>`,
    `<p style="margin:0;font-size:12px;line-height:1.7;color:${BRAND_MUTED};">${escapeHtml(SYSTEM_FOOTNOTE)}</p>`,
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("\n");

  const text = [
    options.heading,
    "",
    options.greeting,
    "",
    ...options.bodyLines,
    "",
    RIGHTS_LINE,
    SYSTEM_FOOTNOTE,
  ].join("\n");

  return { subject: options.title, html, text };
}

function paragraph(html: string): string {
  return `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.7;color:${BRAND_INK};">${html}</p>`;
}

function button(label: string, url: string): string {
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">',
    "<tr>",
    `<td align="center" style="background-color:${BRAND_ACCENT};border-radius:8px;">`,
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 28px;font-family:${FONT_STACK};font-size:15px;font-weight:700;color:${BRAND_INK};text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>`,
    "</td>",
    "</tr>",
    "</table>",
  ].join("\n");
}

function codeBlock(code: string): string {
  return [
    `<div style="margin:0 0 20px 0;padding:16px 20px;background-color:#FAFAFA;border:1px solid ${RULE};border-radius:8px;text-align:center;">`,
    `<span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:8px;color:${BRAND_INK};">${escapeHtml(code)}</span>`,
    "</div>",
  ].join("\n");
}

/** 注册验证：link must be clicked. */
export function verifyEmail(input: VerifyEmailInput): EmailContent {
  const minutes = input.expiresInMinutes ?? VERIFY_LINK_TTL_MINUTES;
  const greeting = salutation(input.displayName);

  return layout({
    title: `${BRAND_NAME} 邮箱验证`,
    heading: "验证你的邮箱地址",
    greeting,
    bodyHtml: [
      paragraph(`感谢你注册 ${BRAND_NAME}。点击下面的按钮完成邮箱验证，即可开始使用。`),
      button("验证邮箱", input.link),
      paragraph(
        `<span style="color:${BRAND_MUTED};font-size:13px;">按钮无法点击时，请复制下面的链接到浏览器打开：<br><span style="word-break:break-all;">${escapeHtml(input.link)}</span></span>`,
      ),
      paragraph(`链接 ${minutes} 分钟内有效。若不是你本人注册，忽略本邮件即可，账号不会被启用。`),
    ].join("\n"),
    bodyLines: [
      `感谢你注册 ${BRAND_NAME}。点击下面的链接完成邮箱验证，即可开始使用：`,
      input.link,
      "",
      `链接 ${minutes} 分钟内有效。若不是你本人注册，忽略本邮件即可，账号不会被启用。`,
    ],
  });
}

/** 登录验证码：code is typed back into the login form. */
export function loginCode(input: LoginCodeInput): EmailContent {
  const minutes = input.expiresInMinutes ?? LOGIN_CODE_TTL_MINUTES;
  const greeting = salutation(input.displayName);

  return layout({
    title: `${BRAND_NAME} 登录验证码`,
    heading: "你的登录验证码",
    greeting,
    bodyHtml: [
      paragraph("有人正在使用这个邮箱登录 " + BRAND_NAME + "。验证码如下："),
      codeBlock(input.code),
      paragraph(`验证码 ${minutes} 分钟内有效，且只能使用一次。请勿把验证码转发给任何人。`),
      paragraph(
        `<span style="color:${BRAND_MUTED};font-size:13px;">若不是你本人操作，请立即修改密码，并忽略本邮件。</span>`,
      ),
    ].join("\n"),
    bodyLines: [
      `有人正在使用这个邮箱登录 ${BRAND_NAME}。验证码如下：`,
      input.code,
      "",
      `验证码 ${minutes} 分钟内有效，且只能使用一次。请勿把验证码转发给任何人。`,
      "若不是你本人操作，请立即修改密码，并忽略本邮件。",
    ],
  });
}

/** 找回密码：link opens the reset form. */
export function resetPassword(input: ResetPasswordInput): EmailContent {
  const minutes = input.expiresInMinutes ?? RESET_LINK_TTL_MINUTES;
  const greeting = salutation(input.displayName);

  return layout({
    title: `${BRAND_NAME} 密码重置`,
    heading: "重置你的密码",
    greeting,
    bodyHtml: [
      paragraph(`我们收到了重置 ${BRAND_NAME} 账号密码的请求。点击下面的按钮设置新密码。`),
      button("设置新密码", input.link),
      paragraph(
        `<span style="color:${BRAND_MUTED};font-size:13px;">按钮无法点击时，请复制下面的链接到浏览器打开：<br><span style="word-break:break-all;">${escapeHtml(input.link)}</span></span>`,
      ),
      paragraph(`链接 ${minutes} 分钟内有效，且只能使用一次。`),
      paragraph(
        `<span style="color:${BRAND_MUTED};font-size:13px;">若不是你本人操作，请忽略本邮件，你的密码不会被修改。</span>`,
      ),
    ].join("\n"),
    bodyLines: [
      `我们收到了重置 ${BRAND_NAME} 账号密码的请求。点击下面的链接设置新密码：`,
      input.link,
      "",
      `链接 ${minutes} 分钟内有效，且只能使用一次。`,
      "若不是你本人操作，请忽略本邮件，你的密码不会被修改。",
    ],
  });
}
