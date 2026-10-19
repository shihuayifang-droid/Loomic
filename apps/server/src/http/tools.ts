import type { FastifyInstance, FastifyReply } from "fastify";

import {
  toolListResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { TOOL_DEFINITIONS } from "../features/tools/tool-definitions.js";
import type { RequestAuthenticator } from "../supabase/user.js";

/**
 * `GET /api/tools` — the ED-00k tool definition table (workorder 21AB).
 *
 * The 401 is the same reply `http/brand-kits.ts` sends, so a client that knows
 * one authenticated route already knows this one. Everything else is a constant:
 * the table is static configuration (ED-00k: 定义存配置，非数据库也可), so this
 * route has no service, no repository and no failure path of its own.
 *
 * `availability: "unavailable"` tools are shipped too, on purpose. ED-00k says
 * the definition carries the switch and the client/Agent decide whether to show
 * it (未到位的工具不显示、Agent 看不到); filtering here would turn "flip a switch
 * in the back office" into "ship a release", which is the outcome the spec's
 * X-11 note rules out.
 */
export async function registerToolRoutes(
  app: FastifyInstance,
  options: { auth: RequestAuthenticator },
) {
  // GET /api/tools — the whole table
  app.get("/api/tools", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
      return sendUnauthenticated(reply);
    }

    return reply
      .code(200)
      .send(toolListResponseSchema.parse({ tools: TOOL_DEFINITIONS }));
  });
}

function sendUnauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}
