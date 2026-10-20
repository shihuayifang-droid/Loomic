import type { FastifyInstance, FastifyReply } from "fastify";

import {
  applicationErrorResponseSchema,
  skillCreateRequestSchema,
  skillDetailResponseSchema,
  skillListResponseSchema,
  skillUpdateRequestSchema,
  unauthenticatedErrorResponseSchema,
  workspaceSkillListResponseSchema,
  workspaceSkillToggleRequestSchema,
} from "@loomic/shared";

import { SkillRepositoryError } from "../db/skill-repository.js";

import type {
  SkillFileRecord,
  SkillPatch,
  SkillRepository,
} from "../db/skill-repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { sendValidationError } from "./validation-error.js";

type SkillErrorCode =
  | "feature_disabled"
  | "skill_not_found"
  | "skill_create_failed"
  | "skill_update_failed"
  | "skill_delete_failed"
  | "skill_query_failed"
  | "skill_file_query_failed"
  | "skill_import_failed"
  | "skill_install_failed"
  | "skill_uninstall_failed"
  | "skill_toggle_failed";

/**
 * The skill routes (workorder 21AE).
 *
 * Every table call of this file now runs through `SkillRepository`, a pure `pg`
 * repository built in `app.ts`. The routes themselves only swapped the CALL
 * TARGET: the status codes, error codes, messages, mappers and the six places
 * that swallow a failure on purpose are the ones this file published before, and
 * the four bug-level behaviours frozen as T-61 are untouched.
 *
 * The user-scoped Supabase client is no longer a parameter: nothing in this file
 * can reach PostgREST any more.
 */
export async function registerSkillRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    skillRepository: SkillRepository;
    viewerService: ViewerService;
  },
) {
  // =========================================================================
  // Skills Registry (public catalog)
  // =========================================================================

  // GET /api/skills — list all available skills
  app.get("/api/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const rows = await options.skillRepository.listVisibleSkills(user.id);

      const skills = rows.map(mapSkillRow);
      return reply.code(200).send(skillListResponseSchema.parse({ skills }));
    } catch (error) {
      request.log.error({ err: error }, "skills list error");
      return sendSkillError(reply, "skill_query_failed", "Unable to load skills.");
    }
  });

  // GET /api/skills/:id — get skill detail
  app.get("/api/skills/:id", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { id } = request.params as { id: string };
      const data = await options.skillRepository.findVisibleSkill(user.id, id);

      if (!data) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill not found.",
          404,
        );
      }

      // Fetch associated files. A failed read stays NON-FATAL here (workorder
      // 21AE §1 #3): the detail answer simply carries no files, which is what the
      // removed read did when it ignored its own error.
      const fileRows = await options.skillRepository
        .listVisibleSkillFiles(user.id, id)
        .catch((): SkillFileRecord[] => []);

      const skill = {
        ...mapSkillDetailRow(data),
        files: fileRows.map(mapSkillFileRow),
      };
      return reply.code(200).send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) {
      request.log.error({ err: error }, "skill detail error");
      return sendSkillError(reply, "skill_query_failed", "Unable to load skill.");
    }
  });

  // GET /api/skills/:id/files — list all files for a skill
  app.get("/api/skills/:id/files", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { id } = request.params as { id: string };

      const rows = await options.skillRepository.listVisibleSkillFiles(
        user.id,
        id,
      );

      // Not through a response schema — unchanged: this route answered the raw
      // `{ files }` object before the migration and still does.
      return reply.code(200).send({ files: rows.map(mapSkillFileRow) });
    } catch (error) {
      request.log.error({ err: error }, "skill files list error");
      return sendSkillError(reply, "skill_file_query_failed", "Unable to load skill files.");
    }
  });

  // POST /api/skills — create custom skill
  app.post("/api/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const payload = skillCreateRequestSchema.parse(request.body);
      const slug = generateSlug(payload.name);

      let data: SkillRow;
      try {
        data = await options.skillRepository.insertOwnSkill(user.id, {
          name: payload.name,
          slug,
          description: payload.description,
          category: payload.category,
          skillContent: payload.skillContent,
          iconName: payload.iconName ?? null,
        });
      } catch (error) {
        request.log.error({ err: error }, "skill create failed");
        // Check for unique slug conflict
        if (error instanceof SkillRepositoryError && error.sqlstate === "23505") {
          return sendSkillError(
            reply,
            "skill_create_failed",
            "A skill with a similar name already exists. Please choose a different name.",
            409,
          );
        }
        return sendSkillError(reply, "skill_create_failed", "Unable to create skill.");
      }

      // Insert associated files if provided
      if (payload.files?.length && data.id) {
        try {
          await options.skillRepository.insertOwnSkillFiles(
            user.id,
            data.id,
            payload.files.map((f) => ({
              filePath: f.filePath,
              content: f.content,
              mimeType: f.mimeType ?? "text/plain",
            })),
          );
        } catch (fileError) {
          // Non-fatal: skill was created but files failed — log and continue
          request.log.error({ err: fileError }, "skill file insert failed (non-fatal)");
        }
      }

      // Fetch files back so the response includes them. This read was swallowed
      // before the migration (§1 #7) and stays swallowed.
      const fileData = await options.skillRepository
        .listVisibleSkillFiles(user.id, data.id)
        .catch((): SkillFileRecord[] => []);

      const skill = {
        ...mapSkillDetailRow(data),
        files: fileData.map(mapSkillFileRow),
      };
      return reply.code(201).send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) {
      if (isZodError(error)) {
        return sendValidationError(reply, error.issues);
      }

      request.log.error({ err: error }, "skill create error");
      return sendSkillError(reply, "skill_create_failed", "Unable to create skill.");
    }
  });

  // POST /api/skills/import — disabled in this release (SK-16).
  //
  // Answered immediately after authentication, BEFORE the body is touched:
  // nothing about the request may influence what happens here, no URL is
  // parsed, and no request leaves the process. The importer implementation
  // (importSkillFromUrl) is deliberately kept for when the feature reopens.
  app.post("/api/skills/import", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    return sendSkillError(
      reply,
      "feature_disabled",
      "Importing skills from a link is disabled in this release.",
      410,
    );
  });

  // PUT /api/skills/:id — update custom skill
  app.put("/api/skills/:id", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { id } = request.params as { id: string };
      const payload = skillUpdateRequestSchema.parse(request.body);

      // Build the patch with only provided fields. `name` and `slug` are ONE edit:
      // a rename always rewrites the slug, exactly as before the migration.
      const patch: SkillPatch = {};
      if (payload.name !== undefined) {
        patch.name = payload.name;
        patch.slug = generateSlug(payload.name);
      }
      if (payload.description !== undefined) patch.description = payload.description;
      if (payload.category !== undefined) patch.category = payload.category;
      if (payload.skillContent !== undefined) patch.skill_content = payload.skillContent;
      if (payload.iconName !== undefined) patch.icon_name = payload.iconName;

      if (Object.keys(patch).length === 0) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "skill_update_failed",
              message: "No fields to update.",
            },
          }),
        );
      }

      let data: SkillRow | null;
      try {
        // The ownership predicate ("created_by = the actor") is the statement's own
        // WHERE clause now, which is what the removed `.eq` and the RLS policy
        // together enforced.
        data = await options.skillRepository.updateOwnSkill(user.id, id, patch);
      } catch (error) {
        request.log.error({ err: error }, "skill update failed");
        if (error instanceof SkillRepositoryError && error.sqlstate === "23505") {
          return sendSkillError(
            reply,
            "skill_update_failed",
            "A skill with a similar name already exists.",
            409,
          );
        }
        return sendSkillError(reply, "skill_update_failed", "Unable to update skill.");
      }

      if (!data) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill not found or you do not have permission to update it.",
          404,
        );
      }

      const skill = mapSkillDetailRow(data);
      return reply.code(200).send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) {
      if (isZodError(error)) {
        return sendValidationError(reply, error.issues);
      }

      request.log.error({ err: error }, "skill update error");
      return sendSkillError(reply, "skill_update_failed", "Unable to update skill.");
    }
  });

  // DELETE /api/skills/:id — delete custom skill
  app.delete("/api/skills/:id", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { id } = request.params as { id: string };

      const { deleted } = await options.skillRepository.deleteOwnSkill(
        user.id,
        id,
      );

      if (deleted === 0) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill not found or you do not have permission to delete it.",
          404,
        );
      }

      return reply.code(204).send();
    } catch (error) {
      request.log.error({ err: error }, "skill delete error");
      return sendSkillError(reply, "skill_delete_failed", "Unable to delete skill.");
    }
  });

  // =========================================================================
  // Workspace Skills (per-workspace installation)
  // =========================================================================

  // GET /api/workspaces/skills — list installed skills for current workspace
  app.get("/api/workspaces/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;

      // The install rows joined to their skill, with the install status. The join
      // carries the skill-visibility predicate and the WHERE carries the membership
      // one, so a private skill of somebody else — and a workspace the actor is not
      // a member of — contribute no row at all. That is the "invisible skills are
      // filtered out" answer the removed `.filter((row) => row.skills !== null)`
      // produced client-side, now done by the database.
      const data = await options.skillRepository.listWorkspaceInstalledSkills(
        user.id,
        workspaceId,
      );

      const skills = data.map((row) => ({
        ...mapSkillRow(row),
        installed: true,
        enabled: row.enabled,
        installedAt: row.installed_at,
      }));

      return reply
        .code(200)
        .send(workspaceSkillListResponseSchema.parse({ skills }));
    } catch (error) {
      request.log.error({ err: error }, "workspace skills list error");
      return sendSkillError(
        reply,
        "skill_query_failed",
        "Unable to load workspace skills.",
      );
    }
  });

  // POST /api/workspaces/skills — install a skill
  app.post("/api/workspaces/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const body = request.body as { skillId?: string };
      if (!body.skillId || typeof body.skillId !== "string") {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "skill_install_failed",
              message: "skillId is required.",
            },
          }),
        );
      }

      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;

      // Verify the skill exists AND is visible to the actor. This check is the only
      // thing that stops "install somebody else's private skill": the foreign key
      // does not run the RLS policy, so the check cannot be dropped.
      const skill = await options.skillRepository
        .findVisibleSkill(user.id, body.skillId)
        .catch(() => null);

      if (!skill) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill not found.",
          404,
        );
      }

      try {
        await options.skillRepository.upsertWorkspaceSkill(
          user.id,
          workspaceId,
          body.skillId,
          true,
        );
      } catch (error) {
        request.log.error({ err: error }, "skill install failed");
        return sendSkillError(
          reply,
          "skill_install_failed",
          "Unable to install skill.",
        );
      }

      return reply.code(204).send();
    } catch (error) {
      request.log.error({ err: error }, "skill install error");
      return sendSkillError(
        reply,
        "skill_install_failed",
        "Unable to install skill.",
      );
    }
  });

  // DELETE /api/workspaces/skills/:skillId — uninstall a skill
  app.delete("/api/workspaces/skills/:skillId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { skillId } = request.params as { skillId: string };
      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;

      // A non-admin deletes ZERO rows and the route answers 404 — never 403. That
      // is the behaviour this route published before the migration and it is kept.
      const { deleted } = await options.skillRepository.deleteWorkspaceSkill(
        user.id,
        workspaceId,
        skillId,
      );

      if (deleted === 0) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill is not installed in this workspace.",
          404,
        );
      }

      return reply.code(204).send();
    } catch (error) {
      request.log.error({ err: error }, "skill uninstall error");
      return sendSkillError(
        reply,
        "skill_uninstall_failed",
        "Unable to uninstall skill.",
      );
    }
  });

  // PATCH /api/workspaces/skills/:skillId — toggle enable/disable
  app.patch("/api/workspaces/skills/:skillId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { skillId } = request.params as { skillId: string };
      const payload = workspaceSkillToggleRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;

      // Verify the skill exists in the catalogue AND is visible to the actor — the
      // same "cannot reach somebody else's private skill" guard as the install route.
      const skill = await options.skillRepository
        .findVisibleSkill(user.id, skillId)
        .catch(() => null);

      if (!skill) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill not found.",
          404,
        );
      }

      // Upsert: create workspace_skills row if not installed, or update enabled state
      try {
        await options.skillRepository.upsertWorkspaceSkill(
          user.id,
          workspaceId,
          skillId,
          payload.enabled,
        );
      } catch (error) {
        request.log.error({ err: error }, "skill toggle failed");
        return sendSkillError(
          reply,
          "skill_toggle_failed",
          "Unable to toggle skill.",
        );
      }

      return reply.code(204).send();
    } catch (error) {
      if (isZodError(error)) {
        return sendValidationError(reply, error.issues);
      }

      request.log.error({ err: error }, "skill toggle error");
      return sendSkillError(
        reply,
        "skill_toggle_failed",
        "Unable to toggle skill.",
      );
    }
  });
}

// ===========================================================================
// Helpers
// ===========================================================================

/** Shape of a row from the `skills` table. */
type SkillRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  author: string;
  version: string;
  license: string | null;
  category: string;
  icon_name: string | null;
  source: string;
  skill_content: string;
  metadata: Record<string, unknown> | null;
  is_featured: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Added by 20260403100000_skill_files migration
  source_url?: string | null;
  package_name?: string | null;
};

/** Shape of a row from the `skill_files` table. */
type SkillFileRow = {
  id: string;
  skill_id: string;
  file_path: string;
  content: string;
  mime_type: string;
  created_at: string;
  updated_at: string;
};

function mapSkillRow(row: SkillRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    author: row.author,
    version: row.version,
    category: row.category,
    iconName: row.icon_name,
    source: row.source,
    isFeatured: row.is_featured,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSkillFileRow(row: SkillFileRow) {
  return {
    id: row.id,
    filePath: row.file_path,
    content: row.content,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSkillDetailRow(row: SkillRow) {
  return {
    ...mapSkillRow(row),
    license: row.license,
    skillContent: row.skill_content,
    createdBy: row.created_by,
    sourceUrl: row.source_url ?? null,
    packageName: row.package_name ?? null,
  };
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
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

function sendSkillError(
  reply: FastifyReply,
  code: SkillErrorCode,
  message: string,
  statusCode = 500,
) {
  return reply.code(statusCode).send(
    applicationErrorResponseSchema.parse({
      error: { code, message },
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
