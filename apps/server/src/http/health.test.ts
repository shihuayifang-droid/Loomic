import { readFileSync } from "node:fs";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { healthResponseSchema } from "@loomic/shared";

import type { ServerEnv } from "../config/env.js";

import { registerHealthRoutes, uptimeSeconds } from "./health.js";

/**
 * OP-14: `/healthz` is liveness, `/api/health` is readiness. The liveness route
 * must stay answerable with nothing else wired -- these tests boot it on a bare
 * Fastify instance, so a route that reached for a pool or a queue would fail
 * here instead of taking a production container down with its dependency.
 */
const TEST_VERSION = "9.9.9-health-test";
const ENV = { version: TEST_VERSION } as ServerEnv;

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerHealthRoutes(app, ENV);
  await app.ready();
  return app;
}

describe("OP-14 GET /healthz (liveness)", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("answers 200 with exactly ok / service / uptimeSeconds", async () => {
    app = await buildTestApp();

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "service", "uptimeSeconds"]);
    expect(body.ok).toBe(true);
    expect(body.service).toBe("hahart-server");
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
    expect(body.uptimeSeconds as number).toBeGreaterThanOrEqual(0);
  });

  it("keeps uptimeSeconds monotonic between two probes", async () => {
    app = await buildTestApp();

    const first = await app.inject({ method: "GET", url: "/healthz" });
    const second = await app.inject({ method: "GET", url: "/healthz" });

    const firstBody = first.json() as { uptimeSeconds: number };
    const secondBody = second.json() as { uptimeSeconds: number };
    expect(secondBody.uptimeSeconds).toBeGreaterThanOrEqual(firstBody.uptimeSeconds);
    expect(firstBody.uptimeSeconds).toBe(uptimeSeconds());
  });

  it("does not reach for a database or a queue", () => {
    // Structural guard: the liveness answers must never grow a dependency. The
    // route module may only know Fastify, the shared health contract and the
    // server env type.
    const source = readFileSync(new URL("./health.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)].map(
      (match) => match[1],
    );

    expect(imports).toEqual([
      "fastify",
      "@loomic/shared",
      "../config/env.js",
    ]);
    expect(source).not.toMatch(/db\/pool|createQueueClient|pgmq|getTransactionPool/);
  });
});

describe("OP-14 GET /api/health (readiness, unchanged)", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("still answers 200 with the build version and no uptimeSeconds", async () => {
    app = await buildTestApp();

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(healthResponseSchema.parse(body)).toEqual({
      ok: true,
      service: "hahart-server",
      version: TEST_VERSION,
    });
    expect(Object.keys(body).sort()).toEqual(["ok", "service", "version"]);
  });

  it("keeps the readiness route registered under the same path", async () => {
    app = await buildTestApp();

    const healthz = await app.inject({ method: "GET", url: "/healthz" });
    const readiness = await app.inject({ method: "GET", url: "/api/health" });

    expect(healthz.statusCode).toBe(200);
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).not.toEqual(healthz.json());
  });
});
