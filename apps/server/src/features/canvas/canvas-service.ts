import type { CanvasContent, CanvasDetail } from "@loomic/shared";

import type { RecoverableArtifact } from "@loomic/shared";

import type { AuthenticatedUser } from "../../supabase/user.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import {
  CanvasReadError,
  type CanvasReadRepository,
} from "../../db/canvas-read-repository.js";
import type { AssetRecordRepository } from "../../db/asset-record-repository.js";
import { ObjectStoreError, type ObjectStore } from "../storage/object-store.js";
import {
  signProjectAssetUrl,
  storageRenderTransformEnabled,
  withWebpFormat,
} from "../storage/project-asset-urls.js";
import {
  listRecoverableArtifacts as listRecoverable,
  recoverArtifacts as restoreArtifacts,
  type RecoveryReadAccess,
} from "./canvas-recovery.js";
// Shared with canvas-element-writer.ts so the save path and the agent's direct
// insert path cannot drift apart on bucket name or marker format.
import {
  CANVAS_FILES_BUCKET,
  OSS_MARKER_PREFIX,
} from "./canvas-element-writer.js";
import { isTransportFailure } from "../../supabase/transport-retry.js";
import type { CanvasContentRepository } from "../../db/canvas-content-repository.js";
import {
  CanvasNotFoundError,
  CanvasUnavailableError,
  CanvasVersionConflictError,
  createRepositoryCanvasStore,
  readCanvasRow,
  replaceCanvasContent,
} from "./canvas-version.js";

/**
 * `service_unavailable` (503) means the database could not answer — distinct from
 * `canvas_not_found` (404), which means the row is genuinely absent. Keeping them
 * apart is what lets the client retry instead of telling the user their canvas is
 * gone. The string is one of the codes `applicationErrorCodeSchema` already
 * accepts, so no wire contract changes.
 */
type CanvasErrorCode =
  | "canvas_not_found"
  | "canvas_save_failed"
  | "service_unavailable";

export class CanvasServiceError extends Error {
  readonly statusCode: number;
  readonly code: CanvasErrorCode;

  constructor(
    code: CanvasErrorCode,
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type CanvasService = {
  getCanvas(user: AuthenticatedUser, canvasId: string): Promise<CanvasDetail>;
  /**
   * Replaces the whole canvas content.
   *
   * `baseVersion` is the version the caller last read. When supplied and stale,
   * this throws CanvasVersionConflictError (409) instead of overwriting whatever
   * landed in between — that overwrite is what used to erase generated images.
   * Omitting it keeps the old unconditional behaviour for clients that have not
   * been updated yet.
   */
  saveCanvasContent(
    user: AuthenticatedUser,
    canvasId: string,
    content: CanvasContent,
    baseVersion?: number,
  ): Promise<{ version: number }>;
  /**
   * Generated images whose file is still in Storage but which no element on the
   * canvas references — see canvas-recovery.ts. Read-only.
   */
  listRecoverableArtifacts(
    user: AuthenticatedUser,
    canvasId: string,
  ): Promise<RecoverableArtifact[]>;
  recoverArtifacts(
    user: AuthenticatedUser,
    canvasId: string,
    jobIds: string[],
  ): Promise<{ recovered: number; skipped: string[]; version?: number }>;
};

export function createCanvasService(options: {
  /**
   * 45AJ / T-133 (4th slice), re-shaped by 45BC / T-133 (10a): a FACTORY keyed
   * on the CALLER's access token, not a single shared store and no longer a
   * Supabase-shaped client.
   *
   * Canvas files are uploaded for the caller who is saving the canvas, so the
   * store is built from THAT caller's token and Storage answers under that user's
   * RLS — the same per-user scoping this service applied itself when it wrapped
   * the caller's client inline, and the same form brand-kit (45AH / 45BB) and
   * uploads (45AI / 45BC) take. Handing the service one store built from the
   * server's/admin's client would widen the permission on this feature: 45D
   * pinned that a canvas marker is only signed or written when it belongs to this
   * canvas's workspace or project, and that check is meaningless if the write
   * itself bypasses RLS.
   */
  createObjectStore: (accessToken: string) => ObjectStore;
  /**
   * Ticket 44D onward this service no longer uses it; kept optional only so
   * existing callers keep compiling. A later cleanup ticket removes it.
   */
  getAdminClient?: () => AdminSupabaseClient;
  /**
   * Records the stored canvas file as a project asset (ticket 44D). Optional
   * like the read repository: when absent the extraction takes the same path
   * as a failed record - the base64 is kept and nothing throws.
   */
  assetRecordRepository?: Pick<AssetRecordRepository, "recordProjectAsset">;
  /**
   * Canvas read repository (workorder 20C). The canvas inherits its project's
   * ACL, so the asset-identity projection and the recovery job list are read
   * through explicit, actor-carrying SQL instead of the caller's PostgREST
   * client.
   *
   * It is optional so that constructing the service stays free of database
   * infrastructure — the same reason the repository itself resolves its pool
   * lazily. Its absence is not silent for recovery: an empty job list would read
   * as "nothing to recover" when the truth is "nobody asked the database", so
   * that path refuses (see recoveryAccess). The asset-identity projection
   * degrades instead, because "no assetId" is already a legal answer (a legacy
   * object with no metadata row) while "no recoverable images" is not.
   */
  canvasReadRepository?: CanvasReadRepository;
  /**
   * Canvas content repository (ticket 44V). The canvas row read and the whole
   * content save go through it. When absent both fail with the same 503 as an
   * unreachable database; there is no fallback to the user client. The client
   * stays only for Storage signing and uploads.
   */
  canvasContentRepository?: Pick<
    CanvasContentRepository,
    "readCanvasRow" | "writeIfUnchanged"
  >;
}): CanvasService {
  return {
    async getCanvas(user, canvasId) {
      const contentRepository = options.canvasContentRepository;
      if (!contentRepository) {
        throw asCanvasServiceError(
          new CanvasUnavailableError(
            canvasId,
            new Error("canvas content repository is not configured"),
          ),
        );
      }
      // Reads go through readCanvasRow so a dead connection cannot arrive as
      // "canvas not found" — see canvas-version.ts. It also retries the transport
      // failures the local proxy produces, which is why loading a canvas no longer
      // dies on a single blip.
      let data: {
        id: string;
        name: string;
        project_id: string;
        content?: unknown;
        version?: unknown;
      };
      try {
        data = await readCanvasRow(
          createRepositoryCanvasStore(contentRepository, user.id),
          canvasId,
          "id, name, project_id, content, version",
        );
      } catch (error) {
        throw asCanvasServiceError(error);
      }

      const content = (data.content as CanvasContent) ?? { elements: [], appState: {} };

      // T-133 (9th slice), re-keyed by 45BC (10a): the READ path signs through
      // the same per-request store the SAVE path uploads with — built by the
      // injected factory from THIS caller's access token, so the signature
      // carries their JWT and the whole feature has exactly one storage seam.
      // Nothing about which request the store belongs to changed; only who ends
      // up asking Storage.
      const objectStore = options.createObjectStore(user.accessToken);

      // Resolve OSS-stored files back to base64 dataURLs for the frontend
      const resolvedContent = await resolveFilesFromStorage(
        objectStore,
        canvasId,
        content,
        options.canvasReadRepository,
        user.id,
      );

      // CV-01: attach a playable URL for video markers. Read-time only — the
      // persisted `link` keeps its oss:// marker (see the function's notes).
      const projectedContent = await resolveVideoElementsFromStorage(
        objectStore,
        resolvedContent,
        options.canvasReadRepository,
        user.id,
        canvasId,
      );

      return {
        id: data.id,
        name: data.name,
        projectId: data.project_id,
        content: projectedContent,
        // The client sends this back on save so a stale write is rejected rather
        // than silently overwriting newer content.
        version: (data.version as number) ?? 0,
      };
    },

    async saveCanvasContent(user, canvasId, content, baseVersion) {
      const contentRepository = options.canvasContentRepository;
      if (!contentRepository) {
        throw asCanvasServiceError(
          new CanvasUnavailableError(
            canvasId,
            new Error("canvas content repository is not configured"),
          ),
        );
      }
      const contentStore = createRepositoryCanvasStore(contentRepository, user.id);

      // 45AJ / T-133 (4th slice), re-keyed by 45BC (10a): the store is built by
      // the injected factory from THIS user's access token, right before the
      // bytes are written — not once at construction and not from the admin
      // client. Every upload below therefore carries the saver's JWT and answers
      // under that user's RLS.
      const objectStore = options.createObjectStore(user.accessToken);

      // Extract base64 files to Storage, replacing dataURLs with oss:// markers
      const leanContent = await extractFilesToStorage(
        objectStore,
        options.canvasReadRepository,
        options.assetRecordRepository,
        canvasId,
        content,
        user.id,
      );

      // LOCAL FORK: retry transport-level failures.
      //
      // Every Supabase hostname here resolves into the local proxy's fake-ip
      // range, so all database traffic is proxied. When that proxy switches or
      // stalls a node, the TLS handshake is reset mid-flight and supabase-js
      // reports `TypeError: fetch failed` with NO Postgres code. Observed
      // repeatedly with an 897-byte payload, i.e. nothing to do with size.
      // Without a retry, one such blip silently discards whatever the user just
      // put on the canvas: the save 500s, the row keeps its old value, and the
      // loss only becomes visible on the next reload.
      //
      // Deliberately narrow: a missing `code` plus a fetch/socket message means
      // the request never reached Postgres, so replaying it is safe. Anything
      // carrying a pg code (a statement timeout, an RLS denial, a constraint
      // violation) is a real answer from the database and will fail again
      // identically -- retrying those just multiplies the wait.
      //
      // NOTE ON THE INTERACTION WITH OPTIMISTIC CONCURRENCY (P2):
      // Replaying is still safe here even though the write is now conditional on
      // `version`. A transport failure means Postgres never saw the statement, so
      // the version has not moved and the replay carries the same expected
      // version. If the row HAD been updated, the replay's version check fails
      // and we surface a 409 instead of overwriting — which is the correct answer,
      // not a false conflict.
      type SaveError = {
        code?: string;
        message?: string;
        details?: string;
        hint?: string;
      };
      let error: SaveError | null = null;
      let saved: { version: number } | null = null;
      for (let attempt = 1; ; attempt++) {
        error = null;
        try {
          saved = await replaceCanvasContent(
            contentStore,
            canvasId,
            leanContent,
            baseVersion,
          );
          break;
        } catch (e) {
          if (e instanceof CanvasVersionConflictError) throw e;
          // Both already carry the right status; asCanvasServiceError maps them.
          // CanvasUnavailableError means the read inside replaceCanvasContent
          // already exhausted its own retries, so retrying here would only stack
          // waits.
          if (e instanceof CanvasNotFoundError || e instanceof CanvasUnavailableError) {
            throw asCanvasServiceError(e);
          }
          error = e as SaveError;
        }

        // One definition of "safe to replay", shared with the read path. It used
        // to be inlined here, which is how a second copy could have drifted.
        if (!isTransportFailure(error) || attempt >= 3) break;

        const backoffMs = attempt * 400;
        console.log(
          `[canvas-service] transport failure on save, retrying ` +
            `canvasId=${canvasId} attempt=${attempt} in=${backoffMs}ms ` +
            `message=${error?.message}`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }

      if (error) {
        // LOCAL FORK: upstream swallowed the Postgres error and surfaced only
        // "Unable to save canvas.", which says nothing about the cause. Payload
        // size is logged too because the failure mode we actually hit was a
        // statement timeout from multi-MB base64 content.
        const elementCount = Array.isArray(
          (leanContent as { elements?: unknown[] }).elements,
        )
          ? (leanContent as { elements: unknown[] }).elements.length
          : 0;
        let payloadBytes = -1;
        try {
          payloadBytes = JSON.stringify(leanContent).length;
        } catch {
          // Non-serialisable content is itself the diagnosis; keep -1.
        }
        // console.log, not console.error: stderr goes through PowerShell's error
        // record formatting in a tee'd dev log, which wraps and TRUNCATES the
        // line — the pgCode/payloadBytes we log here were being cut off, making
        // the diagnostic useless. The marker prefix is what the log reader greps.
        console.log(
          `[canvas-service] saveCanvasContent failed canvasId=${canvasId} ` +
            `elements=${elementCount} payloadBytes=${payloadBytes} ` +
            `pgCode=${error.code ?? "?"} message=${error.message} ` +
            `details=${error.details ?? ""} hint=${error.hint ?? ""}`,
        );
        throw new CanvasServiceError("canvas_save_failed", "Unable to save canvas.", 500);
      }

      // Unreachable unless the loop above changes: it either sets `saved` or
      // leaves `error` set. Asserting instead of returning a fake version, so a
      // future edit that breaks the invariant fails loudly.
      if (!saved) {
        throw new CanvasServiceError(
          "canvas_save_failed",
          "Unable to save canvas.",
          500,
        );
      }
      return saved;
    },

    async listRecoverableArtifacts(user, canvasId) {
      const contentRepository = options.canvasContentRepository;
      if (!contentRepository) {
        throw asCanvasServiceError(
          new CanvasUnavailableError(
            canvasId,
            new Error("canvas content repository is not configured"),
          ),
        );
      }
      const store = createRepositoryCanvasStore(contentRepository, user.id);
      try {
        return await listRecoverable(
          store,
          canvasId,
          recoveryAccess(options.canvasReadRepository, user.id),
        );
      } catch (error) {
        throw asCanvasServiceError(error);
      }
    },

    async recoverArtifacts(user, canvasId, jobIds) {
      const contentRepository = options.canvasContentRepository;
      if (!contentRepository) {
        throw asCanvasServiceError(
          new CanvasUnavailableError(
            canvasId,
            new Error("canvas content repository is not configured"),
          ),
        );
      }
      const store = createRepositoryCanvasStore(contentRepository, user.id);
      try {
        return await restoreArtifacts(
          store,
          canvasId,
          jobIds,
          recoveryAccess(options.canvasReadRepository, user.id),
        );
      } catch (error) {
        throw asCanvasServiceError(error);
      }
    },
  };
}

/**
 * The recovery paths cannot answer "nothing to recover" when the reason is that
 * no repository was wired: that would be a false empty list about a user's own
 * generated images. The two-argument form of the recovery functions stays legal
 * for the legacy manual verifier `apps/server/_p25-verify.ts` (outside this
 * ticket's file list), and canvas-recovery refuses it loudly; here we simply do
 * not invent an access it was never given. The refusal surfaces as the existing
 * 500 (`application_error`) — a misconfiguration report, not a data claim.
 */
function recoveryAccess(
  repository: CanvasReadRepository | undefined,
  actorId: string,
): RecoveryReadAccess | undefined {
  return repository ? { repository, actorId } : undefined;
}

/**
 * The recovery paths read and write through canvas-version.ts, which speaks in
 * its own error types. Translate them so routes keep answering with one shape.
 */
function asCanvasServiceError(error: unknown): unknown {
  if (error instanceof CanvasNotFoundError) {
    return new CanvasServiceError("canvas_not_found", "Canvas not found.", 404);
  }
  if (error instanceof CanvasUnavailableError) {
    // The message is user-facing, so it says what to do rather than naming a
    // driver fault. The driver fault is already in the log from readCanvasRow.
    return new CanvasServiceError(
      "service_unavailable",
      "Canvas is temporarily unavailable. Retrying usually works.",
      503,
    );
  }
  return error;
}

// ---------------------------------------------------------------------------
// File extraction (save path): base64 dataURL → Supabase Storage + oss:// marker
// ---------------------------------------------------------------------------

type CanvasFileRecord = Record<string, Record<string, unknown>>;

/**
 * A canvas never changes workspace, and the save path runs on a ~1.5s debounce
 * while the user edits, so this is cached to keep the hot path free of extra
 * round trips.
 */
const canvasWorkspaceCache = new Map<string, string>();

/**
 * Storage RLS requires the FIRST path segment to be the workspace UUID:
 *
 *   is_workspace_admin_or_owner(try_parse_uuid((storage.foldername(name))[1]))
 *
 * Every other writer in the codebase already follows that layout
 * (`${workspaceId}/generated/...`, `${workspace_id}/${projectId}/thumbnail.ext`).
 * This one used to write `canvas-files/<canvasId>/...`, so try_parse_uuid saw the
 * literal "canvas-files", returned null, and every upload was rejected with
 * "new row violates row-level security policy" — silently, leaving canvases to
 * carry multi-MB base64 forever.
 */
async function resolveWorkspaceId(
  repository: CanvasReadRepository | undefined,
  actorId: string,
  canvasId: string,
): Promise<string | null> {
  const cached = canvasWorkspaceCache.get(canvasId);
  if (cached) return cached;
  if (!repository) return null;

  let link: Awaited<
    ReturnType<CanvasReadRepository["findReadableCanvasProjectLink"]>
  >;
  try {
    link = await repository.findReadableCanvasProjectLink({
      actorId,
      canvasId,
    });
  } catch {
    return null;
  }
  if (!link?.workspace_id) return null;

  const workspaceId = String(link.workspace_id);
  canvasWorkspaceCache.set(canvasId, workspaceId);
  return workspaceId;
}

async function extractFilesToStorage(
  store: ObjectStore,
  canvasReadRepository: CanvasReadRepository | undefined,
  assetRecordRepository:
    | Pick<AssetRecordRepository, "recordProjectAsset">
    | undefined,
  canvasId: string,
  content: CanvasContent,
  createdBy: string,
): Promise<CanvasContent> {
  const files = (content as { files?: CanvasFileRecord }).files;
  if (!files || Object.keys(files).length === 0) {
    return content;
  }

  // Nothing to upload on most saves (files are already markers), so resolve the
  // workspace only when it is actually needed.
  const needsUpload = Object.values(files).some((fileData) => {
    const dataURL = fileData.dataURL as string | undefined;
    return typeof dataURL === "string" && dataURL.startsWith("data:");
  });
  const workspaceId = needsUpload
    ? await resolveWorkspaceId(canvasReadRepository, createdBy, canvasId)
    : null;

  const updatedFiles: CanvasFileRecord = {};

  await Promise.all(
    Object.entries(files).map(async ([fileId, fileData]) => {
      const dataURL = fileData.dataURL as string | undefined;

      // Already extracted to storage — keep marker
      if (dataURL?.startsWith(OSS_MARKER_PREFIX)) {
        updatedFiles[fileId] = fileData;
        return;
      }

      // Only process base64 data URLs
      if (!dataURL?.startsWith("data:")) {
        updatedFiles[fileId] = fileData;
        return;
      }

      if (!workspaceId) {
        // Without the workspace we cannot build an RLS-valid path. Guessing one
        // would just reproduce the silent-rejection bug, so keep the base64 and
        // say why.
        console.log(
          `[canvas-service] file upload skipped, workspace unresolved ` +
            `canvasId=${canvasId} fileId=${fileId}`,
        );
        updatedFiles[fileId] = fileData;
        return;
      }

      try {
        const { buffer, mimeType } = parseDataURL(dataURL);
        const ext = mimeToExt(mimeType);
        const objectPath = `${workspaceId}/canvas-files/${canvasId}/${fileId}.${ext}`;

        // Upsert: the same file ID may be re-saved. 43H put the write behind the
        // `ObjectStore` seam; since 45AJ that store comes from the injected
        // per-user factory (see the options doc), so no backend is named here.
        try {
          await store.put(
            { bucket: CANVAS_FILES_BUCKET, key: objectPath },
            buffer,
            { contentType: mimeType, upsert: true },
          );
        } catch (err) {
          const detail =
            err instanceof ObjectStoreError
              ? (err.detail ?? err.message)
              : String(err);
          // Graceful degradation is right, but upstream did it SILENTLY: the
          // canvas kept carrying multi-MB base64 with no hint why, and the only
          // symptom was a slow, bloated document. Log the reason.
          console.log(
            `[canvas-service] file upload failed, keeping base64 fileId=${fileId} ` +
              `bucket=${CANVAS_FILES_BUCKET} path=${objectPath} ` +
              `bytes=${buffer.length} error=${detail}`,
          );
          updatedFiles[fileId] = fileData;
          return;
        }

        // The object exists now, so record who owns it: a canvas file's project
        // comes from the canvas itself, and an unregistered object has nobody to
        // authorise it once the bucket is private (X-52).
        //
        // A failure here is treated like an upload failure rather than thrown:
        // this path must not lose the user's canvas, and by NOT writing the
        // oss:// marker we keep the base64, so the next save retries the upload
        // (upsert) and the record (idempotent on bucket+path).
        let recordFailure: string | null = null;
        if (!assetRecordRepository) {
          recordFailure = "no asset record repository";
        } else {
          try {
            await assetRecordRepository.recordProjectAsset({
              bucket: CANVAS_FILES_BUCKET,
              objectPath,
              createdBy,
              fallbackWorkspaceId: workspaceId,
              projectId: null,
              canvasId,
              mimeType,
              byteSize: buffer.length,
            });
          } catch (err) {
            recordFailure = err instanceof Error ? err.message : String(err);
          }
        }

        if (recordFailure !== null) {
          console.log(
            `[canvas-service] asset metadata failed, keeping base64 fileId=${fileId} ` +
              `path=${objectPath} error=${recordFailure}`,
          );
          updatedFiles[fileId] = fileData;
          return;
        }

        updatedFiles[fileId] = {
          ...fileData,
          dataURL: `${OSS_MARKER_PREFIX}${CANVAS_FILES_BUCKET}/${objectPath}`,
        };
      } catch {
        // Unparseable dataURL — keep as-is
        updatedFiles[fileId] = fileData;
      }
    }),
  );

  return {
    ...content,
    files: updatedFiles,
  } as CanvasContent;
}

// ---------------------------------------------------------------------------
// File resolution (load path): oss:// marker → URL the browser can fetch
// ---------------------------------------------------------------------------

/**
 * Longest edge, in pixels, of the image the canvas actually downloads.
 *
 * Generated art is 2048px and ~6 MB per PNG. Rendering that on a canvas tile a
 * few hundred pixels wide means a browser holds ~6.7 MB of base64 per image, so
 * a sixty-image board costs ~400 MB of JS strings before a single pixel is
 * drawn — the tab dies. Supabase Storage resizes on the fly, and at 1024px the
 * same image came back as 54 KB of WebP: about 1/105 of the original, while
 * still holding up when the user zooms in to inspect detail.
 *
 * Raise this if art review needs more detail; the full-resolution object is
 * always still there under the oss:// marker.
 */
const CANVAS_DISPLAY_MAX_PX = 1024;

/**
 * Whether Supabase's image transformer can safely resize this mime type.
 *
 * Deliberately an allowlist. SVG has no raster size to resize and comes back
 * rasterised; GIF loses its animation; video files are not images at all and the
 * render endpoint would simply fail. In every one of those cases the failure is
 * silent from the server's point of view — the client just gets something wrong
 * looking — so anything not proven safe keeps its untransformed URL.
 */
function canTransformOnTheFly(mimeType: string): boolean {
  return (
    mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/jpg" ||
    mimeType === "image/webp"
  );
}

async function resolveFilesFromStorage(
  store: ObjectStore,
  canvasId: string,
  content: CanvasContent,
  repository: CanvasReadRepository | undefined,
  actorId: string,
): Promise<CanvasContent> {
  const files = (content as { files?: CanvasFileRecord }).files;
  if (!files || Object.keys(files).length === 0) {
    return content;
  }

  // Separate OSS files from inline files
  const updatedFiles: CanvasFileRecord = {};
  const ossEntries: Array<{ fileId: string; fileData: Record<string, unknown>; bucket: string; objectPath: string }> = [];

  for (const [fileId, fileData] of Object.entries(files)) {
    const dataURL = fileData.dataURL as string | undefined;
    if (!dataURL?.startsWith(OSS_MARKER_PREFIX)) {
      updatedFiles[fileId] = fileData;
      continue;
    }

    const ref = dataURL.slice(OSS_MARKER_PREFIX.length);
    const slashIdx = ref.indexOf("/");
    if (slashIdx === -1) continue;
    ossEntries.push({
      fileId,
      fileData,
      bucket: ref.slice(0, slashIdx),
      objectPath: ref.slice(slashIdx + 1),
    });
  }

  if (ossEntries.length === 0) {
    return content;
  }

  // X-52 (T3): the RESPONSE field each file also carries — the real asset id of
  // the object behind its marker.
  //
  // It is looked up by the exact `(bucket, object_path)` pair through the canvas
  // read repository (workorder 20C), which requires the object to belong to THIS
  // canvas's project and re-applies the project's ACL for the caller in SQL. Two
  // things are deliberately absent:
  //   * nothing here parses the marker's path to guess a project or workspace —
  //     the `asset_objects.project_id` column is the authority, the string is
  //     only a lookup key;
  //   * this is a RESPONSE-only projection. It is never written into the canvas
  //     JSON, so the document keeps carrying `oss://<bucket>/<path>` exactly as
  //     before and no client can inject an id of its own choosing.
  //
  // A file with no row simply has no assetId: that is a legacy object (extracted
  // before工单12/13), and T3's rule is that it cannot be sent as a persistent
  // Agent attachment rather than that it should be guessed at.
  const assetIdByPair = await lookupAssetIds(
    repository,
    actorId,
    canvasId,
    ossEntries,
  );

  // 45D: ownership is decided BEFORE anything is signed. The workspace prefix is
  // the second admissible source besides the asset rows (see isMarkerOwned).
  const workspacePrefix = await resolveWorkspacePrefix(
    repository,
    actorId,
    canvasId,
  );

  // Resolve public URLs instead of downloading each file
  // Group by bucket (normally all in one bucket)
  const byBucket = new Map<string, typeof ossEntries>();
  for (const entry of ossEntries) {
    const list = byBucket.get(entry.bucket) ?? [];
    list.push(entry);
    byBucket.set(entry.bucket, list);
  }

  for (const [bucket, entries] of byBucket) {
    for (const entry of entries) {
      if (!isMarkerOwned(entry, assetIdByPair, workspacePrefix)) {
        // Same treatment as a failed signature: keep the marker, give no URL.
        // The log carries a fixed reason and the ids, never the path.
        console.log(
          `[canvas-service] file not signed, marker kept fileId=${entry.fileId} ` +
            `reason=not_owned`,
        );
        updatedFiles[entry.fileId] = { ...entry.fileData };
        continue;
      }

      const mimeType =
        typeof entry.fileData.mimeType === "string"
          ? entry.fileData.mimeType
          : "";
      const transformable =
        canTransformOnTheFly(mimeType) && storageRenderTransformEnabled();

      // SIGNED, not public (X-52): the caller's JWT decides whether this object
      // may be read at all. The 1024px display projection is signed as a
      // transform, so the downscaled variant is authorised the same way as the
      // full-resolution original — no path where a display URL is merely "public
      // because it is smaller".
      let original: string;
      let storageUrl: string;

      try {
        original = await signProjectAssetUrl(store, entry.objectPath, { bucket });
        storageUrl = transformable
          ? withWebpFormat(
              await signProjectAssetUrl(store, entry.objectPath, {
                bucket,
                transform: {
                  width: CANVAS_DISPLAY_MAX_PX,
                  height: CANVAS_DISPLAY_MAX_PX,
                  resize: "contain",
                },
              }),
            )
          : original;
      } catch (err) {
        // Keep the marker and leave this file without a URL. The canvas must
        // still load — one unrunnable signature is one file's problem — and a
        // file that could not be signed must NEVER fall back to a public URL.
        // Note the log carries the reason, not the URL: a signed URL is a token.
        console.log(
          `[canvas-service] file signing failed, marker kept fileId=${entry.fileId} ` +
            `bucket=${bucket} reason=${err instanceof Error ? err.message : String(err)}`,
        );
        updatedFiles[entry.fileId] = { ...entry.fileData };
        continue;
      }

      updatedFiles[entry.fileId] = {
        ...entry.fileData,
        // KEEP the oss:// marker. Replacing it with `dataURL: undefined` made the
        // field vanish from the JSON response, so a client that could not fetch
        // storageUrl held a file entry pointing at nothing — and the next
        // auto-save (a FULL REPLACE) wrote that empty entry back, permanently
        // orphaning the stored object. Carrying the marker means a write-back is
        // lossless even when resolution fails; extractFilesToStorage already
        // passes oss:// markers straight through on the way in.
        //
        // The marker still addresses the FULL-RESOLUTION original; only this
        // fetch URL is downscaled. Nothing about the stored object changes.
        storageUrl,
        // The undownscaled object, for the client to fall back to.
        //
        // Downscaling routes the fetch through Supabase's image renderer, which is
        // a second service that can fail independently of storage itself — it was
        // observed throwing `TypeError: Failed to fetch` for both images at once
        // and then working again minutes later. An optimisation must not be able
        // to cost the user their picture, so the plain object stays reachable.
        storageUrlOriginal: original,
        // X-52 (T3): the stable identity the browser must use when it hands this
        // file to the Agent. Absent for a legacy object with no metadata row —
        // see below.
        ...(assetIdByPair.get(markerPairKey(entry.bucket, entry.objectPath))
          ? {
              assetId: assetIdByPair.get(
                markerPairKey(entry.bucket, entry.objectPath),
              ),
            }
          : {}),
      };
    }
  }

  return {
    ...content,
    files: updatedFiles,
  } as CanvasContent;
}

/**
 * `(bucket, object path)` → asset id for every marker on this canvas.
 *
 * Keyed by the PAIR because that is what identifies the object: the same path in
 * another bucket is a different row, and `asset_objects` is unique on the pair.
 * Keying by path alone used to be safe only because the lookup grouped by bucket
 * and merged the results into one map — the merge is what has to go.
 *
 * A failure or a missing row yields no entry rather than an error: an asset the
 * caller may not read is indistinguishable from one that does not exist, and
 * neither should stop the canvas from loading.
 */
async function lookupAssetIds(
  repository: CanvasReadRepository | undefined,
  actorId: string,
  canvasId: string,
  entries: ReadonlyArray<{ bucket: string; objectPath: string }>,
): Promise<Map<string, string>> {
  const byPair = new Map<string, string>();

  // No repository means no identity is projected — the same answer a legacy
  // object with no metadata row already produces.
  if (!repository) return byPair;

  // A marker with an empty half cannot address an object; dropping it here keeps
  // one damaged marker from failing the lookup for every other file.
  const refs = entries
    .filter((entry) => entry.bucket.length > 0 && entry.objectPath.length > 0)
    .map((entry) => ({ bucket: entry.bucket, objectPath: entry.objectPath }));

  if (refs.length === 0) return byPair;

  try {
    const rows = await repository.listReadableCanvasAssets({
      actorId,
      canvasId,
      refs,
    });

    for (const row of rows) {
      byPair.set(markerPairKey(row.bucket, row.object_path), row.id);
    }
  } catch (error) {
    // The log carries the operation, never the statement or the connection: a
    // repository failure's own message is already fixed text.
    console.log(
      `[canvas-service] asset id lookup failed canvasId=${canvasId} reason=${
        error instanceof CanvasReadError
          ? error.operation
          : error instanceof Error
            ? error.name
            : typeof error
      }`,
    );
    return byPair;
  }

  return byPair;
}

/** The key `asset_objects` is actually unique on. */
function markerPairKey(bucket: string, objectPath: string): string {
  return `${bucket}\u0000${objectPath}`;
}

/** `<workspaceId>/` for the workspace this canvas lives in, or null when unknown. */
async function resolveWorkspacePrefix(
  repository: CanvasReadRepository | undefined,
  actorId: string,
  canvasId: string,
): Promise<string | null> {
  const workspaceId = await resolveWorkspaceId(repository, actorId, canvasId);
  return workspaceId ? `${workspaceId}/` : null;
}

/**
 * Whether a canvas marker `(bucket, objectPath)` may be signed (45D).
 *
 * Why this exists: a canvas is user-saved JSON, so whoever can write it can point
 * a marker at any bucket / path. With Supabase the signing request carries the
 * caller's JWT and Storage RLS rejects a foreign path; the fs storage mode (45C)
 * has no RLS, so the adapter would sign ANY key — an authorization bypass. This
 * server-side check does not depend on the storage backend.
 *
 * A marker is owned when either:
 *   1. its exact pair is among `ownedPairs` (the rows `listReadableCanvasAssets`
 *      returned: object belongs to this canvas's project and is readable by the
 *      caller), or
 *   2. its path starts with `workspacePrefix` (`<workspaceId>/` of this canvas's
 *      project), which covers workspace-scoped objects with no asset row yet.
 *
 * Rule 2 refuses paths with `.`/`..`/empty segments or backslashes, so a prefix
 * cannot be used to climb out of the workspace folder.
 */
export function isMarkerOwned(
  marker: { bucket: string; objectPath: string },
  ownedPairs: { has(key: string): boolean },
  workspacePrefix: string | null,
): boolean {
  if (ownedPairs.has(markerPairKey(marker.bucket, marker.objectPath))) {
    return true;
  }
  if (!workspacePrefix || workspacePrefix === "/") return false;
  if (!marker.objectPath.startsWith(workspacePrefix)) return false;
  if (marker.objectPath.includes("\\")) return false;
  const rest = marker.objectPath.slice(workspacePrefix.length);
  if (rest.length === 0) return false;
  return rest
    .split("/")
    .every((segment, index, all) =>
      segment === "" ? index === all.length - 1 : segment !== "." && segment !== "..",
    );
}

async function resolveVideoElementsFromStorage(
  store: ObjectStore,
  content: CanvasContent,
  repository: CanvasReadRepository | undefined,
  actorId: string,
  canvasId: string,
): Promise<CanvasContent> {
  const elements = (content as { elements?: unknown }).elements;
  if (!Array.isArray(elements) || elements.length === 0) return content;

  // First pass: collect every well-formed video marker so ownership is looked up
  // ONCE for the whole canvas (45D), not once per element.
  const markers = new Map<
    number,
    {
      element: Record<string, unknown>;
      customData: Record<string, unknown>;
      bucket: string;
      objectPath: string;
    }
  >();

  elements.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const element = raw as Record<string, unknown>;
    if (element.type !== "embeddable") return;

    const customData = element.customData as Record<string, unknown> | undefined;
    if (customData?.isVideo !== true) return;

    const link = element.link;
    if (typeof link !== "string" || !link.startsWith(OSS_MARKER_PREFIX)) {
      return;
    }

    const ref = link.slice(OSS_MARKER_PREFIX.length);
    const slashIdx = ref.indexOf("/");
    if (slashIdx <= 0 || slashIdx === ref.length - 1) {
      // A broken marker is one element's problem. Throwing here would take the
      // whole canvas down, including the images that are perfectly fine.
      console.log(
        `[canvas-service] malformed video marker left untouched ` +
          `elementId=${String(element.id)}`,
      );
      return;
    }

    markers.set(index, {
      element,
      customData,
      bucket: ref.slice(0, slashIdx),
      objectPath: ref.slice(slashIdx + 1),
    });
  });

  if (markers.size === 0) return content;

  const ownedPairs = await lookupAssetIds(
    repository,
    actorId,
    canvasId,
    [...markers.values()],
  );
  const workspacePrefix = await resolveWorkspacePrefix(
    repository,
    actorId,
    canvasId,
  );

  let changed = false;

  const updated = await Promise.all(
    elements.map(async (raw, index) => {
    const found = markers.get(index);
    if (!found) return raw;
    const { element, customData, bucket, objectPath } = found;

    if (!isMarkerOwned({ bucket, objectPath }, ownedPairs, workspacePrefix)) {
      // Same as a failed signature: the element is returned untouched.
      console.log(
        `[canvas-service] video marker not signed, left untouched ` +
          `elementId=${String(element.id)} reason=not_owned`,
      );
      return raw;
    }

    try {
      // Signed, and nothing else: `resolvedVideoUrl` is a read-time projection
      // that the client may play but never persists (the marker stays in `link`).
      const resolvedVideoUrl = await signProjectAssetUrl(store, objectPath, {
        bucket,
      });
      changed = true;
      return {
        ...element,
        customData: { ...customData, resolvedVideoUrl },
      };
    } catch (err) {
      console.log(
        `[canvas-service] video marker could not be resolved, left untouched ` +
          `elementId=${String(element.id)} reason=${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      return raw;
    }
    }),
  );

  if (!changed) return content;

  return { ...content, elements: updated } as CanvasContent;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseDataURL(dataURL: string): { buffer: Buffer; mimeType: string } {
  // Format: data:[<mediatype>][;base64],<data>
  const match = dataURL.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) {
    throw new Error("Invalid data URL");
  }
  return {
    mimeType: match[1]!,
    buffer: Buffer.from(match[2]!, "base64"),
  };
}

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    case "image/gif": return "gif";
    default: return "bin";
  }
}
