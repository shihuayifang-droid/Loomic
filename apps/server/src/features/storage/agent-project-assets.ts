// X-52 (工单14): the ONE way an Agent-produced image, screenshot or sandbox file
// becomes a project asset.
//
// WHY THIS EXISTS
// Three Agent paths used to end in the storage client's public-URL helper and
// hand the caller a bare string: `generate_image`'s persist step,
// `screenshot_canvas`, and `persist_sandbox_file`. A string is not an identity.
// The moment `project-assets` stops serving public objects, a record whose only
// handle on its media is that URL has nothing left to authorise a read with, and
// the history it lives in shows a broken image forever.
//
// So the order below is the contract, not an implementation detail:
//
//   1. resolve the canvas through the canvas repository for the acting user (its
//      ACL decides what exists),
//   2. upload with the user's own client,
//   3. record ownership through the service-role-only `record_project_asset`,
//      which derives project/team-workspace FROM THE CANVAS — never from a path
//      and never from the caller's personal billing workspace (Q1),
//   4. if that record fails, DELETE the object just uploaded and throw,
//   5. sign the object for THIS read,
//   6. if that signing fails, DELETE the metadata row and then the object, and
//      throw `sign_failed` — a failure must not leave a half-created asset that
//      no caller was ever handed an id for (工单14 fixup T3),
//   7. return { assetId, bucket, objectPath, mimeType, byteSize, signedUrl }.
//
// Workorder 21AC moved the TWO TABLE reads/writes of that sequence off the
// caller's PostgREST client: step 1 is `CanvasReadRepository`'s
// `findReadableCanvasProjectLink` (the same `private.can_read_project` predicate
// the embedded `project:projects(workspace_id)` read relied on) and step 6's row
// delete is `AssetWriteRepository`'s `deleteOwnAsset` (the same
// `asset_objects_delete_self` policy). Both are REQUIRED, not optional: an
// optional dependency that is not wired fails silently at the one moment it
// matters, which is the failure this whole sequence exists to prevent.
//
// There is no fallback URL anywhere on this path. `getPublicUrl` is not called,
// a provider URL is not returned, and a `data:` URL is not substituted: any of
// those would silently restore the exact dependency this ticket removes.
import type { AgentAssetReference } from "@loomic/shared";

import type { AssetRecordRepository } from "../../db/asset-record-repository.js";
import type { AssetWriteRepository } from "../../db/asset-write-repository.js";
import type {
  CanvasProjectLinkRow,
  CanvasReadRepository,
} from "../../db/canvas-read-repository.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import type { ObjectStore } from "./object-store.js";
import { ObjectStoreError } from "./object-store.js";
import {
  PROJECT_ASSET_BUCKET,
  ProjectAssetUrlError,
  signProjectAssetUrl,
} from "./project-asset-urls.js";
import type { SupabaseStorageLike } from "./supabase-object-store.js";
import { createSupabaseObjectStore } from "./supabase-object-store.js";

/**
 * 43G: every object operation in this file goes through the `ObjectStore` seam,
 * with the user client wrapped exactly as it used to be reached directly.
 */
const storeFor = (client: UserSupabaseClient): ObjectStore =>
  createSupabaseObjectStore(client as unknown as SupabaseStorageLike);

export type AgentProjectAssetErrorCode =
  | "no_canvas"
  | "canvas_not_found"
  | "upload_failed"
  | "metadata_failed"
  | "sign_failed";

export class AgentProjectAssetError extends Error {
  readonly code: AgentProjectAssetErrorCode;

  constructor(code: AgentProjectAssetErrorCode, message: string) {
    super(message);
    this.name = "AgentProjectAssetError";
    this.code = code;
  }
}

/**
 * What the caller hands over.
 *
 * `canvasId` is REQUIRED on purpose: it is the only input from which ownership
 * can be derived truthfully, so a caller that cannot name a canvas has no
 * business persisting a project asset. See persist-sandbox-file.ts, which
 * refuses instead of inventing an `uploads/...` path with no owner.
 */
export type PersistAgentProjectAssetInput = {
  /** The caller's JWT — every read and write below is authorised by it. */
  accessToken: string;
  canvasId: string;
  createdBy: string;
  /** The bytes to store. */
  content: Buffer | Uint8Array;
  mimeType: string;
  /** Display name; sanitised into the object key. */
  fileName: string;
  /** Object key prefix inside the bucket. Defaults to `agent`. */
  pathPrefix?: string;
};

export type AgentProjectAssetService = {
  persist(input: PersistAgentProjectAssetInput): Promise<AgentAssetReference>;
};

/** Longest file-name component kept from a display name. */
const MAX_FILE_NAME_LENGTH = 80;

/**
 * A safe object-key component. Deliberately stricter than the canvas upload
 * path: this name can originate from an LLM-authored prompt or a tool title, so
 * anything outside `[A-Za-z0-9._-]` becomes `_`.
 */
export function sanitizeAgentFileName(fileName: string): string {
  const collapsed = fileName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, MAX_FILE_NAME_LENGTH);
  return collapsed.length > 0 ? collapsed : "asset";
}

/**
 * Build the object key.
 *
 * The FIRST segment is always the workspace id resolved from the canvas, because
 * that is what the Storage RLS policy on `storage.objects` matches — a path that
 * does not start with it cannot be written at all, so building one would be a
 * guaranteed failure dressed up as a retry.
 *
 * The canvas id is in the key for diagnosis only; ownership is NOT read back out
 * of the path (that is the `把旧URL反解为objectPath` trap in the ticket's §5).
 */
export function buildAgentObjectPath(args: {
  workspaceId: string;
  canvasId: string;
  pathPrefix: string;
  fileName: string;
  mimeType: string;
  now: number;
  nonce: string;
}): string {
  const { workspaceId, canvasId, pathPrefix, fileName, mimeType, now, nonce } =
    args;
  const base = sanitizeAgentFileName(fileName);
  const withExt = base.includes(".") ? base : `${base}${extensionForMime(mimeType)}`;
  return `${workspaceId}/${pathPrefix}/${canvasId}/${now}-${nonce}-${withExt}`;
}

export function createAgentProjectAssetService(options: {
  /** The canvas → project link the object key's workspace comes from (21AC). */
  canvasReadRepository: CanvasReadRepository;
  /** The compensated row delete when signing fails (21AC). */
  assetWriteRepository: AssetWriteRepository;
  /** Wired through but not used yet: from workorder 44F it records the asset. */
  assetRecordRepository?: Pick<AssetRecordRepository, "recordProjectAsset">;
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
}): AgentProjectAssetService {
  return {
    async persist(input) {
      const canvasId = input.canvasId?.trim();
      if (!canvasId) {
        // The stop condition from the ticket's §6: without a canvas there is no
        // owner to derive, and an object nobody owns is worse than no object.
        throw new AgentProjectAssetError(
          "no_canvas",
          "Cannot persist a project asset without a canvas context.",
        );
      }

      const client = options.createUserClient(input.accessToken);
      const workspaceId = await resolveCanvasWorkspaceId(
        options.canvasReadRepository,
        { actorId: input.createdBy, canvasId },
      );
      const buffer = Buffer.isBuffer(input.content)
        ? input.content
        : Buffer.from(input.content);

      const objectPath = buildAgentObjectPath({
        workspaceId,
        canvasId,
        pathPrefix: input.pathPrefix ?? "agent",
        fileName: input.fileName,
        mimeType: input.mimeType,
        now: Date.now(),
        nonce: Math.random().toString(36).slice(2, 8),
      });

      // Upload with the USER's client. A refusal here is the user's own RLS
      // answering "no", so it is reported rather than retried against another
      // client. 43G: the write goes through the `ObjectStore` seam; the message
      // keeps the backend's own text, read off the adapter's `detail`.
      try {
        await storeFor(client).put(
          { bucket: PROJECT_ASSET_BUCKET, key: objectPath },
          buffer,
          { contentType: input.mimeType, upsert: false },
        );
      } catch (err) {
        const detail =
          err instanceof ObjectStoreError
            ? (err.detail ?? err.message)
            : String(err);
        throw new AgentProjectAssetError(
          "upload_failed",
          `Storage upload failed: ${detail}`,
        );
      }

      // Ownership, through the one service-role-only entry point. The canvas id
      // — not the path, not the personal workspace — is what it derives the
      // project and the team workspace from. `p_fallback_workspace_id` is passed
      // because the function has no default for it; it is only ever consulted
      // when there is no project, which cannot happen on this path.
      const { data: recorded, error: recordError } = await options
        .getAdminClient()
        .rpc("record_project_asset", {
          p_bucket: PROJECT_ASSET_BUCKET,
          p_object_path: objectPath,
          p_created_by: input.createdBy,
          p_fallback_workspace_id: workspaceId,
          p_project_id: null,
          p_canvas_id: canvasId,
          p_mime_type: input.mimeType,
          p_byte_size: buffer.length,
        });

      const assetId = (recorded as { asset_id?: string } | null)?.asset_id;

      if (recordError || !assetId) {
        // The object is already in the bucket and now has no owner. Leaving it
        // there would create exactly the un-authorisable object X-52 exists to
        // eliminate, so remove it — best effort, but the failure is reported
        // either way, including when the cleanup itself fails.
        await removeUploadedObject(client, objectPath, recordError?.message);
        throw new AgentProjectAssetError(
          "metadata_failed",
          `Could not record asset metadata for the uploaded object: ${
            recordError?.message ?? "no asset id returned"
          }`,
        );
      }

      // Sign for THIS read. No public-URL fallback: a signature that cannot be
      // minted is an error the caller sees, not a silent degradation.
      let signedUrl: string;
      try {
        signedUrl = await signProjectAssetUrl(client, objectPath, {
          bucket: PROJECT_ASSET_BUCKET,
        });
      } catch (error) {
        // 工单14 fixup T3. By the time signing runs, BOTH halves of the asset
        // exist: the Storage object and the `asset_objects` row that names it.
        // The caller is about to get an exception instead of a reference, so
        // nobody will ever hold this asset's id — leaving either half behind
        // creates precisely the un-referenceable orphan X-52 exists to remove.
        //
        // Both are therefore undone, metadata FIRST: the row is the
        // authoritative record, and it must not outlive the bytes it points at.
        // Each step is best-effort and neither can mask the original failure —
        // what survives is named on the safe log (asset id + object key) so
        // T-23's real inventory can find it. Nothing is logged or returned that
        // contains a URL: a signed URL is a bearer token, and a failed signing
        // has not produced one anyway. The URL is never rolled back to anything.
        await removeRecordedAssetMetadata(
          options.assetWriteRepository,
          { actorId: input.createdBy, assetId },
          objectPath,
        );
        await removeUploadedObject(client, objectPath, "sign_failed", assetId);
        throw new AgentProjectAssetError(
          "sign_failed",
          error instanceof ProjectAssetUrlError
            ? error.message
            : "Failed to sign the stored object.",
        );
      }

      return {
        assetId,
        bucket: PROJECT_ASSET_BUCKET,
        objectPath,
        mimeType: input.mimeType,
        byteSize: buffer.length,
        signedUrl,
      };
    },
  };
}

/**
 * Read the canvas → project link for the ACTING USER through the canvas
 * repository (workorder 21AC).
 *
 * The read this replaces was an embedded `project:projects(workspace_id)` lookup
 * on the caller's own PostgREST client, so RLS decided what existed: a canvas the
 * user could not read answered no row and the persist was refused rather than
 * filed against a guessed workspace. `findReadableCanvasProjectLink` is that same
 * decision as SQL — `private.can_read_project`, translation for translation — so
 * both outcomes below are unchanged: a failed read and an unreadable canvas are
 * both `canvas_not_found`, with the messages the caller already produced.
 */
async function resolveCanvasWorkspaceId(
  repository: CanvasReadRepository,
  input: { actorId: string; canvasId: string },
): Promise<string> {
  let link: CanvasProjectLinkRow | null;

  try {
    link = await repository.findReadableCanvasProjectLink(input);
  } catch (error) {
    throw new AgentProjectAssetError(
      "canvas_not_found",
      `Canvas lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const workspaceId = link?.workspace_id;

  if (!workspaceId) {
    throw new AgentProjectAssetError(
      "canvas_not_found",
      "Canvas not found or not accessible — refusing to persist an asset with no owner.",
    );
  }

  return workspaceId;
}

async function removeUploadedObject(
  client: UserSupabaseClient,
  objectPath: string,
  reason: string | undefined,
  assetId?: string,
): Promise<void> {
  try {
    // 43G: the removal goes through the `ObjectStore` seam. The adapter turns a
    // backend refusal into an `ObjectStoreError`, so it lands in the catch below
    // and this cleanup keeps reporting the failure instead of passing silently.
    await storeFor(client).delete([
      { bucket: PROJECT_ASSET_BUCKET, key: objectPath },
    ]);
  } catch (error) {
    console.error(
      `[agent-project-assets] cleanup of an unowned object FAILED ` +
        `bucket=${PROJECT_ASSET_BUCKET} path=${objectPath} ` +
        `assetId=${assetId ?? "none"} ` +
        `recordReason=${reason ?? "unknown"} ` +
        `cleanupReason=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Undo the `asset_objects` row that `record_project_asset` just wrote.
 *
 * Deleted through `AssetWriteRepository.deleteOwnAsset` (workorder 21AC), whose
 * statement is `asset_objects_delete_self` translated verbatim: author +
 * workspace membership + `can_write_project`. That is the same ACL the caller's
 * user-scoped client applied, so this cleanup still needs no privilege the write
 * path did not have — and reaching for the admin client here would turn an error
 * message into a way to delete rows user RLS protects.
 *
 * Best effort — a failure is reported on the safe log and never rethrown, so the
 * `sign_failed` the caller sees remains the reason the persist failed. Zero rows
 * is not a failure (`deleted: 0` means the row was already gone or the predicate
 * refused it) but it IS logged: something this module was told it had just
 * created is no longer there, and the `(0 rows)` marker is how that shows up in
 * the log instead of passing as a silent success.
 */
async function removeRecordedAssetMetadata(
  repository: AssetWriteRepository,
  input: { actorId: string; assetId: string },
  objectPath: string,
): Promise<void> {
  const logPrefix =
    `[agent-project-assets] cleanup of a failed-to-sign metadata row FAILED ` +
    `assetId=${input.assetId} bucket=${PROJECT_ASSET_BUCKET} path=${objectPath} `;

  try {
    const { deleted } = await repository.deleteOwnAsset(input);

    if (deleted === 0) {
      // The original code had no zero-row branch (the PostgREST delete did not
      // report a count). Same message, with the marker appended.
      console.error(`${logPrefix}cleanupReason=the row was not deleted (0 rows)`);
    }
  } catch (error) {
    console.error(
      `${logPrefix}cleanupReason=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/svg+xml":
      return ".svg";
    case "application/pdf":
      return ".pdf";
    case "video/mp4":
      return ".mp4";
    default:
      return ".png";
  }
}
