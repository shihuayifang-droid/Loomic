import type {
  ProjectCreateRequest,
  ProjectSummary,
  ProjectUpdateRequest,
} from "@loomic/shared";

import {
  BootstrapError,
  type ViewerService,
} from "../bootstrap/ensure-user-foundation.js";
import {
  FIND_READABLE_PROJECT_WORKSPACE_FOR_MUTATION,
  ProjectReadError,
  type PrimaryCanvasRow,
  type ProjectListRow,
  type ProjectReadRepository,
} from "../../db/project-read-repository.js";
import {
  ProjectWriteError,
  type ProjectWriteRepository,
} from "../../db/project-write-repository.js";
import {
  isTransportFailure,
  withTransportRetry,
} from "../../supabase/transport-retry.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { ObjectStoreError } from "../storage/object-store.js";
import {
  ProjectAssetUrlError,
  signProjectAssetUrl,
  signProjectAssetUrls,
  storageRenderTransformEnabled,
  withWebpFormat,
} from "../storage/project-asset-urls.js";
import { createSupabaseObjectStore } from "../storage/supabase-object-store.js";
import type { SupabaseStorageLike } from "../storage/supabase-object-store.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

const THUMBNAIL_BUCKET = "project-assets";
/** GN-14: a list card shows a thumbnail, never the stored original. */
const PROJECT_LIST_THUMBNAIL_PX = 400;
const PROJECT_QUERY_FAILED_MESSAGE = "Unable to load projects.";
const PROJECT_LOOKUP_FAILED_MESSAGE = "Unable to look up project.";
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
   * Workorder 20B / 20E: the project read paths — the two real reads and the
   * read-only lookups the write flows perform before writing — are the PostgreSQL
   * repository's. Optional only because unrelated call sites build this service
   * without one; calling without it is a wiring bug and answers exactly what a
   * failed lookup answers on that path (`project_query_failed` 500 for a read,
   * `project_delete_failed` 500 for `archiveProject`, `project_query_failed` 503
   * for the thumbnail lookup) instead of falling back to PostgREST.
   */
  projectReadRepository?: ProjectReadRepository;
  /**
   * Workorder 21AA: the three project WRITES — archive, the thumbnail reference
   * and the name / brand-kit patch — are the PostgreSQL repository's. Required,
   * not optional: every construction point passes one, and a service that could
   * be built without one would have to answer a write it cannot perform. The
   * repository's own predicate is the authorization (`projects_update_owner`
   * translated verbatim), so no call site here can widen a write.
   */
  projectWriteRepository: ProjectWriteRepository;
}): ProjectService {
  return {
    async archiveProject(user, projectId) {
      const repository = options.projectReadRepository;

      // ADR-0001 / workorder 20E: the existence (and visibility) check is the
      // repository's read. Its SQL requires membership in the project's workspace
      // plus author/admin/owner, and it filters `archived_at` exactly as the
      // PostgREST lookup it replaces did — which is what keeps "already archived"
      // and "not yours" one answer, the existing 404.
      //
      // ADR-0001 / workorder 21AA: the archive write is the write repository's now.
      // It is still a SECOND call and deliberately not merged with the lookup: the
      // two statements answer different questions (may this caller see it / may
      // this caller write it), and merging them would change which one produces the
      // 404. No lock, no CAS and no row-count check are added either.
      if (!repository) {
        throw new ProjectServiceError(
          "project_delete_failed",
          PROJECT_DELETE_FAILED_MESSAGE,
          500,
        );
      }

      let existing;
      try {
        existing = await repository.findReadableProject({
          actorId: user.id,
          projectId,
        });
      } catch {
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

      // The write repository's statement sets `archived_at` from the database
      // clock. The timestamp the removed write computed here was never read
      // anywhere else — it was bound into that one column and the route answers
      // 204 with no body — so the two are the same value with one less clock.
      //
      // Zero rows is NOT an error: an administrator who can read this project but
      // may not write it reaches exactly that answer, and the removed write
      // answered 204 for it too.
      try {
        await options.projectWriteRepository.archiveOwnProject({
          actorId: user.id,
          projectId,
        });
      } catch {
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

      // Resolve workspace_id — the object key's first segment is the workspace
      // UUID, so it has to come from the project row rather than from the client.
      //
      // LOCAL FORK: `error` used to be discarded here, so EVERY failure became
      // "Project not found." with a 404. A transport failure (the Supabase host
      // resolves through a local proxy, which intermittently resets the TLS
      // handshake) therefore reported that the project did not exist -- observed
      // in the logs as a 404 with responseTime=5003ms that succeeded on the very
      // next attempt. That answer sends whoever is debugging to look at project
      // rows and permissions, which are fine.
      //
      // "No row" and "the question was never answered" are still different
      // answers: the first is the existing 404, the second the existing 503. What
      // changed with workorder 20E is only WHERE the lookup runs: the repository
      // answers with the project's workspace, and its own failure is fixed text.
      //
      // …and it is still RETRIED rather than merely reported. It is a plain SELECT,
      // so replaying it cannot do damage, and without the retry one proxy blip made the
      // whole thumbnail upload answer 503 after a 5-second stall (observed
      // 2026-09-15).
      //
      // The retry predicate reads the DRIVER error (its `code` and `message`), so a
      // transport failure has to be unwrapped out of `ProjectReadError` before it
      // can be replayed; every other failure — a real SQL error, a row that is not
      // the promised shape — is rethrown wrapped and is therefore NOT retried.
      let proj: { workspace_id: string } | null;
      try {
        proj = await withTransportRetry(
          "projects.select(workspace_id)",
          async () => {
            const repository = options.projectReadRepository;

            if (!repository) {
              throw new ProjectReadError(
                FIND_READABLE_PROJECT_WORKSPACE_FOR_MUTATION,
                new Error("project read repository is not wired"),
              );
            }

            try {
              // The MUTATION variant on purpose: it does not filter
              // `archived_at`, so an archived project can still take a thumbnail
              // exactly as it could through the previous lookup.
              return await repository.findReadableProjectWorkspaceForMutation({
                actorId: user.id,
                projectId,
              });
            } catch (error) {
              if (
                error instanceof ProjectReadError &&
                isTransportFailure(error.cause)
              ) {
                throw error.cause;
              }

              throw error;
            }
          },
        );
      } catch {
        // Fixed text and no interpolation: the driver's message can name a host,
        // a statement or a credential, and none of that may reach the client.
        throw new ProjectServiceError(
          "project_query_failed",
          PROJECT_LOOKUP_FAILED_MESSAGE,
          503,
        );
      }
      if (!proj) {
        throw new ProjectServiceError("project_not_found", "Project not found.", 404);
      }

      const ext = mimeType === "image/webp" ? "webp" : "png";
      const objectPath = `${proj.workspace_id}/${projectId}/thumbnail.${ext}`;

      // 43H: the thumbnail write goes through the `ObjectStore` seam instead of
      // the raw SDK.
      try {
        await createSupabaseObjectStore(
          client as unknown as SupabaseStorageLike,
        ).put(
          { bucket: THUMBNAIL_BUCKET, key: objectPath },
          buffer,
          { contentType: mimeType, upsert: true },
        );
      } catch (err) {
        const detail =
          err instanceof ObjectStoreError
            ? (err.detail ?? err.message)
            : String(err);
        throw new ProjectServiceError(
          "project_create_failed",
          `Thumbnail upload failed: ${detail}`,
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

      // ADR-0001 / workorder 21AA: the reference write is the write repository's
      // now. The order of the three side effects is unchanged — object, metadata
      // row, reference — and so is the message: a failed reference is the existing
      // `project_create_failed` 500 with "Failed to save thumbnail reference.".
      // Zero rows stays silent: the object and the asset row are already in place,
      // and the removed write did not inspect the count either.
      // AG-35 §1: a fixed-patch UPDATE by id is safe to replay, so a transport
      // failure is retried like the lookup above; anything else is answered once.
      try {
        await withTransportRetry("projects.update(thumbnail_path)", async () => {
          try {
            await options.projectWriteRepository.setOwnProjectThumbnail({
              actorId: user.id,
              projectId,
              thumbnailPath: objectPath,
            });
          } catch (error) {
            if (
              error instanceof ProjectWriteError &&
              isTransportFailure(error.cause)
            ) {
              throw error.cause;
            }
            throw error;
          }
        });
      } catch {
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
      const patch: { name?: string; brand_kit_id?: string | null } = {};
      if (input.brand_kit_id !== undefined) patch.brand_kit_id = input.brand_kit_id;
      if (input.name !== undefined) patch.name = input.name;

      // Nothing to change: no statement is sent, which is what the removed code
      // did as well (it returned before building an empty update).
      if (Object.keys(patch).length === 0) {
        return;
      }

      // ADR-0001 / workorder 21AA: the patch is the write repository's now, as ONE
      // fixed statement whose shape does not depend on which keys are present.
      //
      // Zero rows stays a 204. The removed code wanted a 404 there, but the branch
      // could never run: the update asked for no row count, so `count` was always
      // null and `count === 0` was never true. The published contract is therefore
      // "a patch that touches nothing still answers 204", and this migration keeps
      // it rather than quietly turning a dead branch into a live 404.
      try {
        await options.projectWriteRepository.updateOwnProject({
          actorId: user.id,
          projectId,
          patch,
        });
      } catch {
        throw new ProjectServiceError(
          "project_update_failed",
          PROJECT_UPDATE_FAILED_MESSAGE,
          500,
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

  // GN-14: the renderer switch is the same one the canvas uses, with the same
  // meaning. Off, a deployment keeps the plain stored-object signature.
  const transformEnabled = storageRenderTransformEnabled();

  const signed = await signProjectAssetUrls(
    client,
    withThumbnail.map((project) => project.thumbnail_path),
    transformEnabled
      ? {
          bucket: THUMBNAIL_BUCKET,
          transform: {
            width: PROJECT_LIST_THUMBNAIL_PX,
            height: PROJECT_LIST_THUMBNAIL_PX,
            resize: "cover",
          },
        }
      : { bucket: THUMBNAIL_BUCKET },
  );

  for (const project of withThumbnail) {
    const url = signed.get(project.thumbnail_path);
    if (url) {
      urlMap.set(project.id, transformEnabled ? withWebpFormat(url) : url);
    }
  }

  return urlMap;
}
