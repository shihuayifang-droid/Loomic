// Zero-dependency static server for the exported web build (apps/web/out).
// /api/* is always 404: every API call is intercepted by page.route in the tests.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../out", import.meta.url)));
const port = Number(process.env.E2E_PORT ?? 4317);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

function isFile(p) {
  return existsSync(p) && statSync(p).isFile();
}

function resolveFile(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const base = join(root, rel);
  if (!base.startsWith(root)) return null;
  for (const candidate of [base, `${base}.html`, join(base, "index.html")]) {
    if (isFile(candidate)) return candidate;
  }
  const fallback = join(root, "index.html");
  return isFile(fallback) ? fallback : null;
}

createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":{"code":"not_found","message":"no api in e2e static server"}}');
    return;
  }
  const file = resolveFile(pathname);
  if (!file) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": types[extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => {
  console.log(`e2e static server on http://127.0.0.1:${port} serving ${root}`);
});
