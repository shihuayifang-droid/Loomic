import type { FastifyInstance, FastifyReply } from "fastify";

import {
  applicationErrorResponseSchema,
  projectCreateRequestSchema,
  projectCreateResponseSchema,
  projectListResponseSchema,
  projectUpdateRequestSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import {
  ProjectServiceError,
  type ProjectService,
} from "../features/projects/project-service.js";
import type { TeamAdminService } from "../features/team/team-admin.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { sendValidationError } from "./validation-error.js";

export async function registerProjectRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    projectService: ProjectService;
    teamAdminService: TeamAdminService;
  },
) {
  app.get("/api/projects/:projectId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);

      if (!user) {
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "Missing or invalid bearer token.",
            },
          }),
        );
      }

      const { projectId } = request.params as { projectId: string };
      const project = await options.projectService.getProject(user, projectId);

      // PJ-07 验收 4: an admin reading someone else's project leaves a trail.
      // Recorded through the database function (never a direct table write), and
      // only AFTER the read succeeded — auditing a failed read would leak
      // whether the id exists. If the audit cannot be written we do not return
      // the data: the trail is the condition for the access.
      try {
        await options.teamAdminService.recordForeignRead(user.id, "project", {
          projectId,
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

      return reply.code(200).send({ project });
    } catch (error) {
      return sendProjectError(error, reply, "project_query_failed");
    }
  });

  app.get("/api/projects", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);

      if (!user) {
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "Missing or invalid bearer token.",
            },
          }),
        );
      }

      const projects = await options.projectService.listProjects(user);
      return reply.code(200).send(projectListResponseSchema.parse({ projects }));
    } catch (error) {
      return sendProjectError(error, reply, "project_query_failed");
    }
  });

  app.delete("/api/projects/:projectId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);

      if (!user) {
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "Missing or invalid bearer token.",
            },
          }),
        );
      }

      const { projectId } = request.params as { projectId: string };
      await options.projectService.archiveProject(user, projectId);
      return reply.code(204).send();
    } catch (error) {
      return sendProjectError(error, reply, "application_error");
    }
  });

  app.post("/api/projects", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);

      if (!user) {
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "Missing or invalid bearer token.",
            },
          }),
        );
      }

      const payload = projectCreateRequestSchema.parse(request.body);
      const project = await options.projectService.createProject(user, payload);

      return reply.code(201).send(
        projectCreateResponseSchema.parse({
          project,
        }),
      );
    } catch (error) {
      if (isZodError(error)) {
        return sendValidationError(reply, error.issues);
      }

      return sendProjectError(error, reply, "project_create_failed");
    }
  });

  app.patch("/api/projects/:projectId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);

      if (!user) {
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "Missing or invalid bearer token.",
            },
          }),
        );
      }

      const { projectId } = request.params as { projectId: string };
      const payload = projectUpdateRequestSchema.parse(request.body);
      await options.projectService.updateProject(user, projectId, payload);

      return reply.code(204).send();
    } catch (error) {
      if (isZodError(error)) {
        return sendValidationError(reply, error.issues);
      }

      return sendProjectError(error, reply, "project_update_failed");
    }
  });

  app.put<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/thumbnail",
    { bodyLimit: 2 * 1024 * 1024 }, // 2 MB for thumbnails
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) {
          return reply.code(401).send(
            unauthenticatedErrorResponseSchema.parse({
              error: {
                code: "unauthorized",
                message: "Missing or invalid bearer token.",
              },
            }),
          );
        }

        const file = await request.file();
        if (!file) {
          return reply.code(400).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "upload_failed",
                message: "No file uploaded.",
              },
            }),
          );
        }

        const buffer = await file.toBuffer();
        const mimeType = file.mimetype || "image/webp";

        const result = await options.projectService.saveThumbnail(
          user,
          request.params.projectId,
          buffer,
          mimeType,
        );

        return reply.code(200).send(result);
      } catch (error) {
        request.log.error({ err: error }, "thumbnail upload error");
        return sendProjectError(error, reply, "project_create_failed");
      }
    },
  );
}

function sendProjectError(
  error: unknown,
  reply: FastifyReply,
  fallbackCode:
    | "application_error"
    | "project_create_failed"
    | "project_query_failed"
    | "project_update_failed",
) {
  if (error instanceof ProjectServiceError) {
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
        code: fallbackCode,
        message:
          fallbackCode === "project_query_failed"
            ? "Unable to load projects."
            : fallbackCode === "project_update_failed"
              ? "Unable to update project."
              : "Unable to create project.",
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
