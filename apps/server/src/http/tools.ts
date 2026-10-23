import type { FastifyInstance, FastifyReply } from "fastify";

import {
  DEFAULT_TOOL_SEARCH_KEY,
  TOOL_MODEL_ID_PREFIX,
  applicationErrorResponseSchema,
  runToolRequestSchema,
  runToolResponseSchema,
  toolListResponseSchema,
  unauthenticatedErrorResponseSchema,
  type ApplicationErrorCode,
  type ToolDefinition,
} from "@loomic/shared";

import type { CreditLedgerWriteRepository } from "../db/credit-ledger-write-repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import { CreditServiceError } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import { TierGuardError } from "../features/credits/tier-guard.js";
import { withBilling } from "../features/credits/with-billing.js";
import type { JobService } from "../features/jobs/job-service.js";
import { JobServiceError } from "../features/jobs/job-service.js";
import { watchJob } from "../features/jobs/job-watcher.js";
import type { PriceQuoter } from "../features/pricing/price-quoter.js";
import { TOOL_DEFINITIONS } from "../features/tools/tool-definitions.js";
import type { AuthenticatedUser, RequestAuthenticator } from "../supabase/user.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";
import type { ConnectionManager } from "../ws/connection-manager.js";

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
  options: {
    auth: RequestAuthenticator;
    /**
     * Everything below is only needed by `POST /api/tools/:toolId/run`. They are
     * passed straight through to `withBilling`, exactly as the generate routes
     * do, so a deployment that wires billing for generation wires it for tools.
     */
    creditService?: CreditService;
    jobService?: JobService;
    tierGuard?: TierGuard;
    priceQuoter?: PriceQuoter;
    creditLedgerWriteRepository?: CreditLedgerWriteRepository;
    viewerService?: ViewerService;
    connectionManager?: ConnectionManager;
    /** The table both routes read; defaults to the static one. Tests inject theirs. */
    tools?: readonly ToolDefinition[];
  },
) {
  const tools = options.tools ?? TOOL_DEFINITIONS;

  // GET /api/tools — the whole table
  app.get("/api/tools", async (request, reply) => {
    const user = await options.auth.authenticate(request);

    if (!user) {
      return sendUnauthenticated(reply);
    }

    return reply
      .code(200)
      .send(toolListResponseSchema.parse({ tools }));
  });

  // POST /api/tools/:toolId/run - ED-00m / GN-05
  //
  // One click on a direct-execution tool. Same three steps as the generate-job
  // routes: a charged job (carrying the tool's execution model), a detached
  // watcher, a 202. The price is asked of the price table with EXACTLY the triple
  // `POST /api/pricing/quote` uses for a tool (`tool:<id>`, entry point `tool`,
  // the caller's search key or `*`), so quote and charge cannot disagree.
  //
  // `client_request_id` makes three clicks one task: `withBilling` answers a
  // repeat with the existing job and charges nothing.
  app.post<{ Params: { toolId: string } }>(
    "/api/tools/:toolId/run",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);

      if (!user) {
        return sendUnauthenticated(reply);
      }

      const parsed = runToolRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return sendError(reply, 400, "invalid_request", "Invalid request body.");
      }

      const body = parsed.data;
      const tool = tools.find((candidate) => candidate.id === request.params.toolId);

      if (!tool) {
        // `applicationErrorCodeSchema` has no not-found code for tools; the status
        // carries the meaning and the shared enum is not widened by this ticket.
        return sendError(
          reply,
          404,
          "application_error",
          `Unknown tool "${request.params.toolId}".`,
        );
      }

      if (tool.availability !== "enabled") {
        // `tool_disabled` is the closest existing code to "tool_unavailable".
        return sendError(
          reply,
          409,
          "tool_disabled",
          `Tool "${tool.id}" is not available.`,
        );
      }

      if (!options.jobService || !options.viewerService) {
        return sendError(
          reply,
          503,
          "service_unavailable",
          "Tools are not available (job service not configured).",
        );
      }

      try {
        const viewer = await options.viewerService.ensureViewer(user);

        const refs = {
          ...(body.project_id ? { projectId: body.project_id } : {}),
          ...(body.canvas_id ? { canvasId: body.canvas_id } : {}),
        };
        const model = tool.execution_model ?? null;

        const job = await withBilling(
          options,
          {
            user: user as AuthenticatedUser,
            workspaceId: viewer.workspace.id,
            modelId: `${TOOL_MODEL_ID_PREFIX}${tool.id}`,
            entryPoint: "tool",
            guard: {
              jobType: "tool_execution",
              searchKey: body.search_key ?? DEFAULT_TOOL_SEARCH_KEY,
            },
            description: tool.label,
            job: {
              payload: {
                tool_id: tool.id,
                artifact_id: body.artifact_id,
                model,
                params: body.params ?? {},
                file_prefix: tool.file_prefix ?? tool.id,
              },
              refs,
              clientRequestId: body.client_request_id,
            },
          },
          async ({ job }) => job!,
        );

        watchJob(
          {
            jobService: options.jobService,
            ...(options.connectionManager
              ? { connectionManager: options.connectionManager }
              : {}),
          },
          { jobId: job.id, userId: user.id, jobType: "tool_execution" },
        );

        return reply
          .code(202)
          .send(
            runToolResponseSchema.parse({
              jobId: job.id,
              status: job.status,
              model,
            }),
          );
      } catch (error) {
        if (
          error instanceof TierGuardError ||
          error instanceof CreditServiceError ||
          error instanceof JobServiceError
        ) {
          return reply.code(error.statusCode).send(
            applicationErrorResponseSchema.parse({
              error: { code: error.code, message: error.message },
            }),
          );
        }

        return sendError(
          reply,
          502,
          "generation_failed",
          sanitizeErrorForClient(error),
        );
      }
    },
  );
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: ApplicationErrorCode,
  message: string,
) {
  return reply
    .code(status)
    .send(applicationErrorResponseSchema.parse({ error: { code, message } }));
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
