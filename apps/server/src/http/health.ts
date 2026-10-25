import type { FastifyInstance } from "fastify";

import { healthResponseSchema } from "@loomic/shared";

import type { ServerEnv } from "../config/env.js";

/** Whole seconds this process has been up; the liveness body's only variable. */
export function uptimeSeconds(): number {
  return Math.floor(process.uptime());
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  env: ServerEnv,
) {
  // OP-14 liveness. Deliberately NOT readiness: no database, no queue, no
  // outbound call -- a liveness probe that consults a dependency restarts a
  // healthy container whenever that dependency blips. `/api/health` stays the
  // readiness probe beside it (unchanged, it keeps reporting the build version).
  app.get("/healthz", async (_request, reply) => {
    return reply.code(200).send({
      ok: true,
      service: "hahart-server",
      uptimeSeconds: uptimeSeconds(),
    });
  });

  app.get("/api/health", async (_request, reply) => {
    const payload = healthResponseSchema.parse({
      ok: true,
      service: "hahart-server",
      version: env.version,
    });

    return reply.code(200).send(payload);
  });
}
