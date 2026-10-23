/**
 * 工单40Y / OP-17：前端 CSP。
 *
 * 前端是 Next **静态导出**（`next.config.ts` 里 `output: "export"`），没有服务端
 * 渲染阶段可以挂响应头 —— `headers()` 在静态导出下不生效，所以唯一能下发的
 * 位置是 `layout.tsx` 里的 `<meta http-equiv="Content-Security-Policy">`。
 *
 * 生成规则：第三方来源一律收敛到 origin（丢掉路径 / query），因为 CSP 里写
 * `https://a.example/base` 只会匹配该路径下的资源，写 origin 才是「整站放行」。
 * 非法或空的地址直接跳过，宁可少放行也不让 `undefined` 字符串进策略 ——
 * 一条含 `undefined` 的 CSP 会被浏览器整条丢弃。
 */

type CspInput = {
  serverBaseUrl: string;
  supabaseUrl?: string | undefined;
};

/** `new URL(x).origin`；空串 / 非法 URL 返回 null。 */
function toOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();

  if (!trimmed) return null;

  try {
    const { origin } = new URL(trimmed);

    // `new URL("file:///x")` 之类的 origin 是 "null"，放进 CSP 没有意义
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** 把 http(s) origin 换成 WebSocket 对应的 ws(s) origin。 */
function toWebSocketOrigin(origin: string): string | null {
  if (origin.startsWith("https://")) return `wss://${origin.slice(8)}`;
  if (origin.startsWith("http://")) return `ws://${origin.slice(7)}`;

  return null;
}

/** 去空、去重，保持传入顺序（`'self'` 永远在最前面，便于读）。 */
function unique(sources: ReadonlyArray<string | null>): string[] {
  const out: string[] = [];

  for (const source of sources) {
    if (!source) continue;
    if (out.includes(source)) continue;
    out.push(source);
  }

  return out;
}

export function buildContentSecurityPolicy(input: CspInput): string {
  const server = toOrigin(input.serverBaseUrl);
  const serverWebSocket = server ? toWebSocketOrigin(server) : null;
  const supabase = toOrigin(input.supabaseUrl);

  // 源列表里允许 null（服务端 / Supabase 配缺失就是 null），由 unique 过滤掉
  const directives: ReadonlyArray<readonly [string, ReadonlyArray<string | null>]> = [
    ["default-src", ["'self'"]],
    // Next 静态导出的启动脚本是内联的；去掉 'unsafe-inline' 页面直接白屏
    ["script-src", ["'self'", "'unsafe-inline'"]],
    // fonts.googleapis.com 是品牌套件的字体预览样式表
    ["style-src", ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]],
    ["font-src", ["'self'", "data:", "https://fonts.gstatic.com"]],
    // 画布上的图片既有本地 blob，也有服务端媒体与 Supabase 签名的存储 URL
    ["img-src", ["'self'", "data:", "blob:", server, supabase]],
    ["media-src", ["'self'", "blob:", server, supabase]],
    // fetch / XHR / WebSocket 走这三处：同源、服务端 API（含 ws）、Supabase
    ["connect-src", ["'self'", server, serverWebSocket, supabase]],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["object-src", ["'none'"]],
  ];

  return directives
    .map(([name, sources]) => `${name} ${unique(sources).join(" ")}`)
    .join("; ");
}
