import type { FastifyInstance } from "fastify";

/**
 * 工单40Y / OP-17：API 安全响应头。
 *
 * 这个服务只回 JSON 和媒体字节（图片 / 视频 / 字体），不渲染任何子资源，
 * 所以用 `default-src 'none'` 起步 —— 浏览器即便被指到某个 API 响应，也加载不了
 * 脚本、样式、帧，拿不到任何跨源能力。前端页面的 CSP 是另一份，见
 * `apps/web/src/lib/content-security-policy.ts`（静态导出只能走 meta 标签）。
 */
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
  ["content-security-policy", "default-src 'none'; frame-ancestors 'none'"],
  ["cross-origin-opener-policy", "same-origin"],
];

/**
 * 给每个响应补上安全头。挂在 `onSend` 上而不是 `onRequest`，这样路由和插件
 * 在处理器里自己设的同名头已经就位，不会被这里覆盖（例如某个下载路由要
 * `X-Frame-Options: SAMEORIGIN` 允许自己嵌自己）。
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of SECURITY_HEADERS) {
      if (reply.hasHeader(name)) continue;
      reply.header(name, value);
    }

    return payload;
  });
}
