import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerSecurityHeaders } from "./security-headers.js";

/** 工单40Y 期望的六个头，逐字相等 —— 故意不写成 toMatchObject，值改了要红。 */
const EXPECTED_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
} as const;

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("registerSecurityHeaders (40Y / OP-17)", () => {
  it("每个响应都带齐六个安全头，值逐字相等", async () => {
    app = Fastify();

    registerSecurityHeaders(app);

    app.get("/x", async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/x" });

    expect(response.statusCode).toBe(200);

    for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
      expect(response.headers[name]).toBe(value);
    }
  });

  it("路由自己设过的同名头不被覆盖", async () => {
    app = Fastify();

    registerSecurityHeaders(app);

    app.get("/x", async (_request, reply) => {
      reply.header("x-frame-options", "SAMEORIGIN");

      return { ok: true };
    });

    const response = await app.inject({ method: "GET", url: "/x" });

    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    // 其余五个仍然补上，不能因为有一个例外就整批跳过
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers["permissions-policy"]).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
  });
});
