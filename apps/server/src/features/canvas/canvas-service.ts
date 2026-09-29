import type { CanvasContent, CanvasDetail } from "@loomic/shared";

import type { RecoverableArtifact } from "@loomic/shared";

import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";
import {
  listRecoverableArtifacts as listRecoverable,
  recoverArtifacts as restoreArtifacts,
} from "./canvas-recovery.js";
// Shared with canvas-element-writer.ts so the save path and the agent's direct
// insert path cannot drift apart on bucket name or marker format.
import {
  CANVAS_FILES_BUCKET,
  OSS_MARKER_PREFIX,
} from "./canvas-element-writer.js";
import { isTransportFailure } from "../../supabase/transport-retry.js";
import {
  CanvasNotFoundError,
  CanvasUnavailableError,
  CanvasVersionConflictError,
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
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): CanvasService {
  return {
    async getCanvas(user, canvasId) {
      const client = options.createUserClient(user.accessToken);
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
          client,
          canvasId,
          "id, name, project_id, content, version",
        );
      } catch (error) {
        throw asCanvasServiceError(error);
      }

      const content = (data.content as CanvasContent) ?? { elements: [], appState: {} };

      // Resolve OSS-stored files back to base64 dataURLs for the frontend
      const resolvedContent = await resolveFilesFromStorage(client, content);

      return {
        id: data.id,
        name: data.name,
        projectId: data.project_id,
        content: resolvedContent,
        // The client sends this back on save so a stale write is rejected rather
        // than silently overwriting newer content.
        version: (data.version as number) ?? 0,
      };
    },

    async saveCanvasContent(user, canvasId, content, baseVersion) {
      const client = options.createUserClient(user.accessToken);

      // Extract base64 files to Storage, replacing dataURLs with oss:// markers
      const leanContent = await extractFilesToStorage(client, canvasId, content);

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
          saved = await replaceCanvasContent(client, canvasId, leanContent, baseVersion);
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
      const client = options.createUserClient(user.accessToken);
      try {
        return await listRecoverable(client, canvasId);
      } catch (error) {
        throw asCanvasServiceError(error);
      }
    },

    async recoverArtifacts(user, canvasId, jobIds) {
      const client = options.createUserClient(user.accessToken);
      try {
        return await restoreArtifacts(client, canvasId, jobIds);
      } catch (error) {
        throw asCanvasServiceError(error);
      }
    },
  };
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
  client: UserSupabaseClient,
  canvasId: string,
): Promise<string | null> {
  const cached = canvasWorkspaceCache.get(canvasId);
  if (cached) return cached;

  const { data: canvasRow, error: canvasError } = await client
    .from("canvases")
    .select("project_id")
    .eq("id", canvasId)
    .single();
  if (canvasError || !canvasRow?.project_id) return null;

  const { data: projectRow, error: projectError } = await client
    .from("projects")
    .select("workspace_id")
    .eq("id", canvasRow.project_id)
    .single();
  if (projectError || !projectRow?.workspace_id) return null;

  const workspaceId = String(projectRow.workspace_id);
  canvasWorkspaceCache.set(canvasId, workspaceId);
  return workspaceId;
}

async function extractFilesToStorage(
  client: UserSupabaseClient,
  canvasId: string,
  content: CanvasContent,
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
    ? await resolveWorkspaceId(client, canvasId)
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

        // Upsert: the same file ID may be re-saved
        const { error: uploadError } = await client.storage
          .from(CANVAS_FILES_BUCKET)
          .upload(objectPath, buffer, { contentType: mimeType, upsert: true });

        if (uploadError) {
          // Graceful degradation is right, but upstream did it SILENTLY: the
          // canvas kept carrying multi-MB base64 with no hint why, and the only
          // symptom was a slow, bloated document. Log the reason.
          console.log(
            `[canvas-service] file upload failed, keeping base64 fileId=${fileId} ` +
              `bucket=${CANVAS_FILES_BUCKET} path=${objectPath} ` +
              `bytes=${buffer.length} error=${uploadError.message}`,
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
 * Why `format=webp` is pinned in the URL instead of left to content negotiation.
 *
 * Supabase's transformer will return WebP on its own if the request's Accept
 * header asks for it — but its responses carry NO `Vary: Accept`. Any cache in
 * the path (the browser's included) therefore keys purely on the URL and hands
 * every later requester whichever format happened to be fetched first. Measured
 * on one object: the same URL returned a 1228 KB PNG from cache while a
 * cache-bypassing request for it produced 54 KB of WebP.
 *
 * Naming the format in the URL makes the cache key describe the bytes, so the
 * saving cannot silently evaporate depending on who warmed the cache.
 */
const CANVAS_DISPLAY_FORMAT_QUERY = "format=webp";

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
  client: UserSupabaseClient,
  content: CanvasContent,
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
      const mimeType =
        typeof entry.fileData.mimeType === "string"
          ? entry.fileData.mimeType
          : "";
      const transformable = canTransformOnTheFly(mimeType);
      const original = client.storage.from(bucket).getPublicUrl(entry.objectPath)
        .data.publicUrl;
      let storageUrl = original;
      if (transformable) {
        const { data } = client.storage.from(bucket).getPublicUrl(
          entry.objectPath,
          {
            transform: {
              width: CANVAS_DISPLAY_MAX_PX,
              height: CANVAS_DISPLAY_MAX_PX,
              resize: "contain",
            },
          },
        );
        storageUrl = `${data.publicUrl}&${CANVAS_DISPLAY_FORMAT_QUERY}`;
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
      };
    }
  }

  return {
    ...content,
    files: updatedFiles,
  } as CanvasContent;
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
