import type { FastifyInstance, FastifyReply } from "fastify";

import {
  applicationErrorResponseSchema,
  canvasConflictResponseSchema,
  canvasGetResponseSchema,
  canvasRecoverRequestSchema,
  canvasRecoverResponseSchema,
  canvasRecoverableResponseSchema,
  canvasSaveRequestSchema,
  canvasSaveResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import {
  CanvasServiceError,
  type CanvasService,
} from "../features/canvas/canvas-service.js";
import { CanvasVersionConflictError } from "../features/canvas/canvas-version.js";
import type { TeamAdminService } from "../features/team/team-admin.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { sendValidationError } from "./validation-error.js";

export async function registerCanvasRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    canvasService: CanvasService;
    teamAdminService: TeamAdminService;
  },
) {
  app.get<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const canvas = await options.canvasService.getCanvas(
          user,
          request.params.canvasId,
        );

        // PJ-07 验收 4 — see projects.ts for the ordering rationale.
        try {
          await options.teamAdminService.recordForeignRead(user.id, "canvas", {
            canvasId: request.params.canvasId,
          });
        } catch {
          return reply.code(503).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "application_error",
                message: "Unable to record this access.",
              },
            }),
          );
        }

        return reply
          .code(200)
          .send(canvasGetResponseSchema.parse({ canvas }));
      } catch (error) {
        return sendCanvasError(error, reply);
      }
    },
  );

  app.put<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId",
    { bodyLimit: 50 * 1024 * 1024 }, // 50 MB — canvas content includes base64 image data
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const payload = canvasSaveRequestSchema.parse(request.body);
        const saved = await options.canvasService.saveCanvasContent(
          user,
          request.params.canvasId,
          payload.content,
          payload.baseVersion,
        );
        const bodySize = JSON.stringify(request.body).length;
        request.log.info(
          {
            canvasId: request.params.canvasId,
            bodyBytes: bodySize,
            baseVersion: payload.baseVersion ?? null,
            newVersion: saved?.version ?? null,
          },
          "canvas.save OK",
        );
        return reply.code(200).send(
          canvasSaveResponseSchema.parse({
            ok: true,
            ...(saved ? { version: saved.version } : {}),
          }),
        );
      } catch (error) {
        // A version conflict is not a server fault — it means someone else wrote
        // first, and the client has to merge. Answer 409 with the current state
        // so it can do that without another round trip.
        if (error instanceof CanvasVersionConflictError) {
          request.log.warn(
            {
              canvasId: request.params.canvasId,
              currentVersion: error.currentVersion,
            },
            "canvas.save CONFLICT",
          );
          return reply.code(409).send(
            canvasConflictResponseSchema.parse({
              error: {
                code: "canvas_version_conflict",
                message: error.message,
              },
              currentVersion: error.currentVersion,
              currentContent: error.currentContent,
            }),
          );
        }
        request.log.error(
          { canvasId: request.params.canvasId, err: error },
          "canvas.save FAILED",
        );
        return sendCanvasError(error, reply);
      }
    },
  );

  // Generated images whose file is still in Storage but which nothing on the
  // canvas references any more. See canvas-recovery.ts for why that can happen.
  app.get<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId/recoverable",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const artifacts = await options.canvasService.listRecoverableArtifacts(
          user,
          request.params.canvasId,
        );

        // PJ-07 验收 4 — see projects.ts for the ordering rationale.
        try {
          await options.teamAdminService.recordForeignRead(user.id, "recoverable", {
            canvasId: request.params.canvasId,
          });
        } catch {
          return reply.code(503).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "application_error",
                message: "Unable to record this access.",
              },
            }),
          );
        }

        return reply
          .code(200)
          .send(canvasRecoverableResponseSchema.parse({ artifacts }));
      } catch (error) {
        request.log.error(
          { canvasId: request.params.canvasId, err: error },
          "canvas.recoverable FAILED",
        );
        return sendCanvasError(error, reply);
      }
    },
  );

  app.post<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId/recover",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const payload = canvasRecoverRequestSchema.parse(request.body);
        const outcome = await options.canvasService.recoverArtifacts(
          user,
          request.params.canvasId,
          payload.jobIds,
        );
        request.log.info(
          {
            canvasId: request.params.canvasId,
            requested: payload.jobIds.length,
            recovered: outcome.recovered,
            skipped: outcome.skipped.length,
          },
          "canvas.recover OK",
        );
        return reply.code(200).send(canvasRecoverResponseSchema.parse(outcome));
      } catch (error) {
        request.log.error(
          { canvasId: request.params.canvasId, err: error },
          "canvas.recover FAILED",
        );
        return sendCanvasError(error, reply);
      }
    },
  );
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendCanvasError(error: unknown, reply: FastifyReply) {
  if (error instanceof CanvasServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: error.code,
          message: error.message,
        },
      }),
    );
  }

  if (isZodError(error)) {
    return sendValidationError(reply, error.issues);
  }

  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "application_error",
        message: "Internal server error.",
      },
    }),
  );
}

function isZodError(
  error: unknown,
): error is { issues: unknown[]; name: string } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}
