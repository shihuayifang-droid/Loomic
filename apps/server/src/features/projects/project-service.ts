import type {
  ProjectCreateRequest,
  ProjectSummary,
  ProjectUpdateRequest,
} from "@loomic/shared";

import {
  BootstrapError,
  type ViewerService,
} from "../bootstrap/ensure-user-foundation.js";
import type {
  PrimaryCanvasRow,
  ProjectListRow,
  ProjectReadRepository,
} from "../../db/project-read-repository.js";
import { withTransportRetry } from "../../supabase/transport-retry.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import {
  ProjectAssetUrlError,
  signProjectAssetUrl,
  signProjectAssetUrls,
} from "../storage/project-asset-urls.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

const THUMBNAIL_BUCKET = "project-assets";
const PROJECT_QUERY_FAILED_MESSAGE = "Unable to load projects.";
const PROJECT_CREATE_FAILED_MESSAGE = "Unable to create project.";
const PROJECT_DELETE_FAILED_MESSAGE = "Unable to delete project.";
const PROJECT_NOT_FOUND_MESSAGE = "Project not found.";
const PROJECT_UPDATE_FAILED_MESSAGE = "Unable to update project.";
const PROJECT_SLUG_TAKEN_MESSAGE =
  "Project slug is already taken in this workspace.";
const NOT_TEAM_MEMBER_MESSAGE =
  "Not a member of the HaHart team workspace.";

export type ProjectService = {
  archiveProject(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<void>;
  createProject(
    user: AuthenticatedUser,
    input: ProjectCreateRequest,
  ): Promise<ProjectSummary>;
  getProject(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    workspace_id: string;
    brand_kit_id: string | null;
    created_at: string;
    updated_at: string;
  }>;
  listProjects(user: AuthenticatedUser): Promise<ProjectSummary[]>;
  saveThumbnail(
    user: AuthenticatedUser,
    projectId: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ thumbnailUrl: string }>;
  updateProject(
    user: AuthenticatedUser,
    projectId: string,
    input: ProjectUpdateRequest,
  ): Promise<void>;
};

export class ProjectServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "not_team_member"
    | "project_create_failed"
    | "project_delete_failed"
    | "project_not_found"
    | "project_query_failed"
    | "project_slug_taken"
    | "project_update_failed";

  constructor(
    code:
      | "not_team_member"
      | "project_create_failed"
      | "project_delete_failed"
      | "project_not_found"
      | "project_query_failed"
      | "project_slug_taken"
      | "project_update_failed",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createProjectService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  viewerService: ViewerService;
  getAdminClient: () => AdminSupabaseClient;
  /**
   * Workorder 20B: the project READ paths moved to the PostgreSQL repository.
   * Optional only because unrelated call sites build this service for the write
   * paths alone; a read without one is a wiring bug and answers the existing
   * `project_query_failed` 500 instead of falling back to PostgREST.
   */
  projectReadRepository?: ProjectReadRepository;
}): ProjectService {
  return {
    async archiveProject(user, projectId) {
      const client = options.createUserClient(user.accessToken);

      const { data: existing, error: findError } = await client
        .from("projects")
        .select("id")
        .eq("id", projectId)
        .is("archived_at", null)
        .maybeSingle();

      if (findError) {
        throw new ProjectServiceError(
          "project_delete_failed",
          PROJECT_DELETE_FAILED_MESSAGE,
          500,
        );
      }

      if (!existing) {
        throw new ProjectServiceError(
          "project_not_found",
          PROJECT_NOT_FOUND_MESSAGE,
          404,
        );
      }

      const { error: updateError } = await client
        .from("projects")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", projectId);

      if (updateError) {
        throw new ProjectServiceError(
          "project_delete_failed",
          PROJECT_DELETE_FAILED_MESSAGE,
          500,
        );
      }
    },
    async getProject(user, projectId) {
      // ADR-0001: the read is the repository's, and the repository's SQL is the
      // authorization — a plain "select by id" would hand an admin's row to
      // anyone who guessed an id. Missing, archived and forbidden are one answer
      // (null → the existing 404), so the route cannot be used to enumerate ids.
      const repository = options.projectReadRepository;

      if (!repository) {
        throw new ProjectServiceError("project_query_failed", "Failed to load project.", 500);
      }

      let project;
      try {
        project = await repository.findReadableProject({
          actorId: user.id,
          projectId,
        });
      } catch {
        throw new ProjectServiceError("project_query_failed", "Failed to load project.", 500);
      }

      if (!project) throw new ProjectServiceError("project_not_found", "Project not found.", 404);
      return project;
    },
    async createProject(user, input) {
      const viewer = await ensureFoundation(
        options.viewerService,
        user,
        "project_create_failed",
      );

      const client = options.createUserClient(user.accessToken);
      const workspace = requireTeamWorkspace(viewer, "project_create_failed");
      const normalizedName = input.name.trim();
      const slug = slugify(normalizedName);

      const { data, error } = await client.rpc(
        "create_project_with_canvas",
        {
          p_workspace_id: workspace.id,
          p_name: normalizedName,
          p_slug: slug,
          p_description: (normalizeDescription(input.description) ?? "") as string,
          p_canvas_name: "Main Canvas",
        },
      );

      if (error) {
        throw mapProjectCreateError(error);
      }

      const result = data as {
        project: {
          id: string;
          name: string;
          slug: string;
          description: string | null;
          created_at: string;
          updated_at: string;
          workspace_id: string;
        };
        canvas: {
          id: string;
          name: string;
          is_primary: boolean;
        };
      } | null;

      if (!result?.project?.id || !result?.canvas?.id) {
        throw new ProjectServiceError(
          "project_create_failed",
          PROJECT_CREATE_FAILED_MESSAGE,
          500,
        );
      }

      return mapProjectSummary({
        canvas: result.canvas,
        project: result.project,
        workspace,
      });
    },
    async listProjects(user) {
      // Content is team-scoped (Q1), so the team workspace comes from the viewer
      // rather than a personal-workspace lookup. The viewer call is also what
      // bootstraps the foundation for a first-time user.
      const viewer = await ensureFoundation(
        options.viewerService,
        user,
        "project_query_failed",
      );
      const client = options.createUserClient(user.accessToken);
      const workspace = requireTeamWorkspace(viewer, "project_query_failed");
      const repository = options.projectReadRepository;

      if (!repository) {
        throw new ProjectServiceError(
          "project_query_failed",
          PROJECT_QUERY_FAILED_MESSAGE,
          500,
        );
      }

      // PJ-11: the project page lists only the caller's own projects, and that
      // rule now lives in the repository SQL (workspace + membership +
      // created_by + not archived). An admin's list therefore cannot be widened
      // here even by accident.
      let projects: ProjectListRow[];
      let canvases: PrimaryCanvasRow[];

      try {
        projects = await repository.listOwnProjects({
          actorId: user.id,
          workspaceId: workspace.id,
        });

        if (!projects.length) {
          return [];
        }

        // The ids come from the list above, but the canvas read re-applies the
        // same ACL rather than trusting them.
        canvases = await repository.listReadablePrimaryCanvases({
          actorId: user.id,
          workspaceId: workspace.id,
          projectIds: projects.map((project) => project.id),
        });
      } catch {
        throw new ProjectServiceError(
          "project_query_failed",
          PROJECT_QUERY_FAILED_MESSAGE,
          500,
        );
      }

      const primaryCanvasByProjectId = new Map(
        canvases.map((canvas) => [canvas.project_id, canvas]),
      );

      // Signed thumbnail URLs for projects that have them (X-52). Signing stays
      // on the user client: the storage signature is not a table read.
      const thumbnailUrls = await generateThumbnailUrls(
        client,
        projects.filter((p) => p.thumbnail_path),
      );

      return projects.map((project) => {
        const canvas = primaryCanvasByProjectId.get(project.id);

        if (!canvas) {
          throw new ProjectServiceError(
            "project_query_failed",
            PROJECT_QUERY_FAILED_MESSAGE,
            500,
          );
        }

        return mapProjectSummary({
          canvas,
          project,
          thumbnailUrl: thumbnailUrls.get(project.id) ?? null,
          workspace,
        });
      });
    },

    async saveThumbnail(user, projectId, buffer, mimeType) {
      const client = options.createUserClient(user.accessToken);

      // Resolve workspace_id — RLS requires first path segment to be the workspace UUID
      //
      // LOCAL FORK: `error` used to be discarded here, so EVERY failure became
      // "Project not found." with a 404. A transport failure (the Supabase host
      // resolves through a local proxy, which intermittently resets the TLS
      // handshake) therefore reported that the project did not exist -- observed
      // in the logs as a 404 with responseTime=5003ms that succeeded on the very
      // next attempt. That answer sends whoever is debugging to look at project
      // rows and permissions, which are fine.
      //
      // PGRST116 is PostgREST's "single() matched no rows"; that alone is a real
      // 404. Anything else means the question never got answered, which is a 503.
      //
      // …and it is now RETRIED rather than merely reported. It is a plain SELECT, so
      // replaying it cannot do damage, and without the retry one proxy blip made the
      // whole thumbnail upload answer 503 after a 5-second stall (observed
      // 2026-09-15). The throw inside is what the retry sees — supabase-js returns
      // `{data, error}` and never rejects, so a wrapper around the raw call would
      // never fire.
      let proj: { workspace_id: string } | null;
      try {
        proj = await withTransportRetry(
          "projects.select(workspace_id)",
          async () => {
            const { data, error } = await client
              .from("projects")
              .select("workspace_id")
              .eq("id", projectId)
              .single();
            if (error && error.code !== "PGRST116") throw error;
            return (data as { workspace_id: string } | null) ?? null;
          },
        );
      } catch (error) {
        const e = error as { code?: string; message?: string };
        throw new ProjectServiceError(
          "project_query_failed",
          `Could not look up project ${projectId}: ${e.message}` +
            (e.code ? ` (code ${e.code})` : ""),
          503,
        );
      }
      if (!proj) {
        throw new ProjectServiceError("project_not_found", "Project not found.", 404);
      }

      const ext = mimeType === "image/webp" ? "webp" : "png";
      const objectPath = `${proj.workspace_id}/${projectId}/thumbnail.${ext}`;

      const { error: uploadError } = await client.storage
        .from(THUMBNAIL_BUCKET)
        .upload(objectPath, buffer, { contentType: mimeType, upsert: true });

      if (uploadError) {
        throw new ProjectServiceError(
          "project_create_failed",
          `Thumbnail upload failed: ${uploadError.message}`,
          500,
        );
      }

      // The thumbnail is a project asset like any other: once the bucket is
      // private, an object with no asset row has no owner to authorise it.
      // Recorded BEFORE the reference is saved, so a metadata failure cannot
      // leave the project pointing at an object nobody owns.
      const { error: recordError } = await options.getAdminClient().rpc(
        "record_project_asset",
        {
          p_bucket: THUMBNAIL_BUCKET,
          p_object_path: objectPath,
          p_created_by: user.id,
          p_fallback_workspace_id: proj.workspace_id,
          p_project_id: projectId,
          p_canvas_id: null,
          p_mime_type: mimeType,
          p_byte_size: buffer.length,
        },
      );

      if (recordError) {
        throw new ProjectServiceError(
          "project_create_failed",
          "Failed to record thumbnail metadata.",
          500,
        );
      }

      const { error: updateError } = await client
        .from("projects")
        .update({ thumbnail_path: objectPath })
        .eq("id", projectId);

      if (updateError) {
        throw new ProjectServiceError(
          "project_create_failed",
          "Failed to save thumbnail reference.",
          500,
        );
      }

      // Signed like every other project asset (X-52). A failure here throws: the
      // caller gets an error for the thumbnail, not a permanent public URL.
      let thumbnailUrl: string;
      try {
        thumbnailUrl = await signProjectAssetUrl(client, objectPath, {
          bucket: THUMBNAIL_BUCKET,
        });
      } catch (error) {
        throw new ProjectServiceError(
          "project_create_failed",
          error instanceof ProjectAssetUrlError
            ? error.message
            : "Failed to sign the thumbnail URL.",
          500,
        );
      }

      return { thumbnailUrl };
    },

    async updateProject(user, projectId, input) {
      const client = options.createUserClient(user.accessToken);

      const payload: Record<string, unknown> = {};
      if (input.brand_kit_id !== undefined) payload.brand_kit_id = input.brand_kit_id;
      if (input.name !== undefined) payload.name = input.name;

      if (Object.keys(payload).length === 0) {
        return;
      }

      const { error: updateError, count } = await client
        .from("projects")
        .update(payload)
        .eq("id", projectId);

      if (updateError) {
        throw new ProjectServiceError(
          "project_update_failed",
          PROJECT_UPDATE_FAILED_MESSAGE,
          500,
        );
      }

      if (count === 0) {
        throw new ProjectServiceError(
          "project_not_found",
          PROJECT_NOT_FOUND_MESSAGE,
          404,
        );
      }
    },
  };
}

async function ensureFoundation(
  viewerService: ViewerService,
  user: AuthenticatedUser,
  errorCode: "project_create_failed" | "project_query_failed",
) {
  try {
    return await viewerService.ensureViewer(user);
  } catch (error) {
    if (error instanceof BootstrapError) {
      throw new ProjectServiceError(
        errorCode,
        errorCode === "project_create_failed"
          ? PROJECT_CREATE_FAILED_MESSAGE
          : PROJECT_QUERY_FAILED_MESSAGE,
        500,
      );
    }
    throw error;
  }
}

/**
 * Content lives in the team workspace (Q1): projects are created and listed
 * there, while credits / generation / skills / settings keep using the personal
 * `viewer.workspace`. A null team workspace means "not a team member" — the
 * gate already rejects that, so this is the second line of defence.
 */
function requireTeamWorkspace(
  viewer: { teamWorkspace?: { id: string; name: string; ownerUserId: string; type: "personal" | "team" } | null | undefined },
  errorCode: "project_create_failed" | "project_query_failed",
) {
  const teamWorkspace = viewer.teamWorkspace;

  if (!teamWorkspace) {
    throw new ProjectServiceError(
      "not_team_member",
      NOT_TEAM_MEMBER_MESSAGE,
      403,
    );
  }

  return teamWorkspace;
}

function mapProjectCreateError(error: { code?: string; message?: string }) {
  if (error.code === "23505") {
    return new ProjectServiceError(
      "project_slug_taken",
      PROJECT_SLUG_TAKEN_MESSAGE,
      409,
    );
  }

  return new ProjectServiceError(
    "project_create_failed",
    PROJECT_CREATE_FAILED_MESSAGE,
    500,
  );
}

function mapProjectSummary(options: {
  canvas: {
    id: string;
    is_primary: boolean;
    name: string;
  };
  project: {
    created_at: string;
    description: string | null;
    id: string;
    name: string;
    slug: string;
    updated_at: string;
  };
  thumbnailUrl?: string | null;
  workspace: {
    id: string;
    name: string;
    ownerUserId: string;
    type: "personal" | "team";
  };
}): ProjectSummary {
  return {
    createdAt: options.project.created_at,
    description: options.project.description,
    id: options.project.id,
    name: options.project.name,
    primaryCanvas: {
      id: options.canvas.id,
      isPrimary: options.canvas.is_primary,
      name: options.canvas.name,
    },
    slug: options.project.slug,
    ...(options.thumbnailUrl ? { thumbnailUrl: options.thumbnailUrl } : {}),
    updatedAt: options.project.updated_at,
    workspace: {
      id: options.workspace.id,
      name: options.workspace.name,
      ownerUserId: options.workspace.ownerUserId,
      type: options.workspace.type,
    },
  };
}

function normalizeDescription(description: string | undefined) {
  const normalized = description?.trim();
  return normalized || null;
}

function slugify(value: string) {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const suffix = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${suffix}` : `project-${suffix}`;
}

/**
 * Signed thumbnail URLs for a project list (X-52).
 *
 * Signed in one batch, and a thumbnail that CANNOT be signed is simply absent
 * from the map. That is the important half: the caller then reports no URL for
 * that project rather than falling back to a public address the viewer may not be
 * entitled to. One unreadable thumbnail must not cost the whole list either.
 */
async function generateThumbnailUrls(
  client: UserSupabaseClient,
  projects: Array<{ id: string; thumbnail_path: string | null }>,
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>();
  const withThumbnail = projects.filter(
    (project): project is { id: string; thumbnail_path: string } =>
      Boolean(project.thumbnail_path),
  );
  if (withThumbnail.length === 0) return urlMap;

  const signed = await signProjectAssetUrls(
    client,
    withThumbnail.map((project) => project.thumbnail_path),
    { bucket: THUMBNAIL_BUCKET },
  );

  for (const project of withThumbnail) {
    const url = signed.get(project.thumbnail_path);
    if (url) urlMap.set(project.id, url);
  }

  return urlMap;
}
