import type { FastifyInstance, FastifyReply } from "fastify";

import {
  applicationErrorResponseSchema,
  assetSignedUrlResponseSchema,
  checkUploadConstraint,
  unauthenticatedErrorResponseSchema,
  uploadResponseSchema,
} from "@loomic/shared";

import {
  UploadServiceError,
  type UploadService,
} from "../features/uploads/upload-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { TeamAdminService } from "../features/team/team-admin.js";
import type { RequestAuthenticator } from "../supabase/user.js";

export async function registerUploadRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    teamAdminService: TeamAdminService;
    uploadService: UploadService;
    viewerService: ViewerService;
  },
) {
  // Upload a file
  app.post("/api/uploads", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const file = await request.file();
      if (!file) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "upload_failed",
              message: "No file provided.",
            },
          }),
        );
      }

      const mimeType = file.mimetype;

      const fileBuffer = await file.toBuffer();

      // AS-02: the shared table decides which types are accepted and how big
      // each of them may be. A refusal carries the concrete Chinese reason.
      const constraint = checkUploadConstraint({
        mimeType,
        byteSize: fileBuffer.length,
      });
      if (!constraint.ok) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "upload_failed", message: constraint.message },
          }),
        );
      }

      // Content is team-scoped (Q1): uploads land in the team workspace, while
      // credits / generation keep using the personal `viewer.workspace`.
      const viewer = await options.viewerService.ensureViewer(user);
      const teamWorkspace = viewer.teamWorkspace;

      if (!teamWorkspace) {
        return reply.code(403).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "not_team_member",
              message: "Not a member of the HaHart team workspace.",
            },
          }),
        );
      }

      const workspaceId = teamWorkspace.id;

      // Extract projectId from fields if provided
      const projectId =
        typeof file.fields.projectId === "object" &&
        file.fields.projectId !== null &&
        "value" in file.fields.projectId
          ? String(file.fields.projectId.value)
          : undefined;

      const result = await options.uploadService.uploadFile(user, {
        bucket: "project-assets",
        fileName: file.filename,
        fileBuffer,
        mimeType,
        workspaceId,
        ...(projectId ? { projectId } : {}),
      });

      return reply
        .code(201)
        .send(uploadResponseSchema.parse(result));
    } catch (error) {
      return sendUploadError(error, reply);
    }
  });

  // Get signed URL for an asset
  app.get<{ Params: { assetId: string } }>(
    "/api/uploads/:assetId/url",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);

        // ED-05: `?download=1` asks for the signed URL that makes the browser save
        // the object under the name the user gave the file. Anything else is the
        // plain view signature this route always answered with.
        const query = request.query as { download?: string } | undefined;
        const url = await options.uploadService.getAssetUrl(
          user,
          request.params.assetId,
          query?.download === "1" ? { download: true } : undefined,
        );

        // PJ-07 验收 4 — see projects.ts for the ordering rationale.
        try {
          await options.teamAdminService.recordForeignRead(user.id, "asset", {
            assetId: request.params.assetId,
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
          .send(assetSignedUrlResponseSchema.parse({ url }));
      } catch (error) {
        return sendUploadError(error, reply);
      }
    },
  );

  // Delete an asset
  app.delete<{ Params: { assetId: string } }>(
    "/api/uploads/:assetId",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);

        await options.uploadService.deleteAsset(
          user,
          request.params.assetId,
        );

        return reply.code(200).send({ ok: true });
      } catch (error) {
        return sendUploadError(error, reply);
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

function sendUploadError(error: unknown, reply: FastifyReply) {
  if (error instanceof UploadServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: error.code,
          message: error.message,
        },
      }),
    );
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
