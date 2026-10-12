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
//   1. resolve the canvas with the USER's JWT (their RLS decides what exists),
//   2. upload with that same client,
//   3. record ownership through the service-role-only `record_project_asset`,
//      which derives project/team-workspace FROM THE CANVAS — never from a path
//      and never from the caller's personal billing workspace (Q1),
//   4. if that record fails, DELETE the object just uploaded and throw,
//   5. sign the object for THIS read,
//   6. return { assetId, bucket, objectPath, mimeType, byteSize, signedUrl }.
//
// There is no fallback URL anywhere on this path. `getPublicUrl` is not called,
// a provider URL is not returned, and a `data:` URL is not substituted: any of
// those would silently restore the exact dependency this ticket removes.
import type { AgentAssetReference } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import {
  PROJECT_ASSET_BUCKET,
  ProjectAssetUrlError,
  signProjectAssetUrl,
} from "./project-asset-urls.js";

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
      const workspaceId = await resolveCanvasWorkspaceId(client, canvasId);
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
      // client.
      const { error: uploadError } = await client.storage
        .from(PROJECT_ASSET_BUCKET)
        .upload(objectPath, buffer, {
          contentType: input.mimeType,
          upsert: false,
        });

      if (uploadError) {
        throw new AgentProjectAssetError(
          "upload_failed",
          `Storage upload failed: ${uploadError.message}`,
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
 * Read the canvas through the USER's client so RLS is part of the answer: a
 * canvas this user cannot see returns no row, and the persist is refused rather
 * than filed against a guessed workspace.
 */
async function resolveCanvasWorkspaceId(
  client: UserSupabaseClient,
  canvasId: string,
): Promise<string> {
  const { data, error } = await client
    .from("canvases")
    .select("project:projects(workspace_id)")
    .eq("id", canvasId)
    .maybeSingle();

  if (error) {
    throw new AgentProjectAssetError(
      "canvas_not_found",
      `Canvas lookup failed: ${error.message}`,
    );
  }

  const workspaceId = (data?.project as { workspace_id?: string } | null)
    ?.workspace_id;

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
): Promise<void> {
  try {
    const { error } = await client.storage
      .from(PROJECT_ASSET_BUCKET)
      .remove([objectPath]);
    if (error) throw new Error(error.message);
  } catch (error) {
    console.error(
      `[agent-project-assets] cleanup of an unowned object FAILED ` +
        `bucket=${PROJECT_ASSET_BUCKET} path=${objectPath} ` +
        `recordReason=${reason ?? "unknown"} ` +
        `cleanupReason=${error instanceof Error ? error.message : String(error)}`,
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
