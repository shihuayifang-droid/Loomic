import type { AssetBucket, AssetObject } from "@loomic/shared";

import type {
  AssetReadRepository,
  AssetReadRow,
} from "../../db/asset-read-repository.js";
import type {
  AssetProvenance,
  AssetProvenanceRepository,
} from "../../db/asset-provenance-repository.js";
import type { AssetWriteRepository } from "../../db/asset-write-repository.js";
import type { ProjectReadRepository } from "../../db/project-read-repository.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import {
  ProjectAssetUrlError,
  signProjectAssetUrl,
} from "../storage/project-asset-urls.js";

export class UploadServiceError extends Error {
  readonly statusCode: number;
  readonly code: "upload_failed" | "asset_not_found";

  constructor(
    code: "upload_failed" | "asset_not_found",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type UploadFileInput = {
  bucket: AssetBucket;
  fileName: string;
  fileBuffer: Buffer;
  mimeType: string;
  workspaceId: string;
  projectId?: string | undefined;
  /**
   * GN-11 / X-P7: where the artifact came from. Omitted means a plain user
   * upload (`user_upload`); a relay upload names the real source it produced
   * itself, so relaying an artifact does not change its provenance.
   */
  provenance?:
    | (Partial<Omit<AssetProvenance, "source">> & { source: string })
    | undefined;
};

export type UploadService = {
  uploadFile(
    user: AuthenticatedUser,
    input: UploadFileInput,
  ): Promise<{ asset: AssetObject; url: string }>;

  getAssetUrl(
    user: AuthenticatedUser,
    assetId: string,
    options?: { download?: boolean },
  ): Promise<string>;

  deleteAsset(
    user: AuthenticatedUser,
    assetId: string,
  ): Promise<void>;
};


export function createUploadService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  /**
   * Workorder 20E: the read-only lookup the project branch performs before the
   * object is written. Optional only because unrelated call sites build this
   * service without one; a project upload without it is a wiring bug and answers
   * the existing 500 for an unanswerable lookup.
   */
  projectReadRepository?: ProjectReadRepository;
  /**
   * Workorder 20E: the asset row `record_project_asset` created, and the row
   * `deleteAsset` locates before removing the object — and, since workorder 21AA,
   * the row `getAssetUrl` locates before signing it. Same wire-it-or-fail rule as
   * above; the existing 500 (upload) / 404 (get, delete) are the answers.
   */
  assetReadRepository?: AssetReadRepository;
  /**
   * Workorder 21AA: the row delete at the end of `deleteAsset` is the PostgreSQL
   * repository's. Required, not optional: every construction point passes one, and
   * the repository's own predicate is the authorization
   * (`asset_objects_delete_self` translated verbatim), so no call site here can
   * widen a delete. Nothing else in this file writes a table.
   */
  assetWriteRepository: AssetWriteRepository;
  /**
   * GN-11: writes where the artifact came from onto the row it just created.
   * ED-05: and the name the user gave the file, so a download can carry it back.
   * Optional: absent simply means provenance is skipped, which is not an error —
   * a caller that relays an artifact it produced itself passes one.
   */
  assetProvenanceRepository?: Pick<
    AssetProvenanceRepository,
    "recordProvenance" | "recordDisplayName" | "readDisplayName"
  >;
}): UploadService {
  return {
    async uploadFile(user, input) {
      const client = options.createUserClient(user.accessToken);

      // A project upload belongs to the workspace that actually owns the project.
      // The client sends both ids, and both are used to build the object path and
      // the asset row, so a client that names someone else's workspace would file
      // the object under a workspace its project does not belong to.
      //
      // ADR-0001 / workorder 20E: the verification is the repository's read. Its
      // SQL requires membership in the project's workspace and author/admin/owner,
      // and it does NOT filter `archived_at` — the lookup it replaces had no
      // archive clause either. What it answers is unchanged: a failure is the
      // existing 500, no row the existing 403, a foreign workspace the existing
      // 403 — and in all three cases nothing has been written yet.
      let workspaceId = input.workspaceId;

      if (input.projectId) {
        const repository = options.projectReadRepository;

        if (!repository) {
          throw new UploadServiceError(
            "upload_failed",
            "Failed to verify the upload project.",
            500,
          );
        }

        let project: { workspace_id: string } | null = null;

        try {
          project = await repository.findReadableProjectWorkspaceForMutation({
            actorId: user.id,
            projectId: input.projectId,
          });
        } catch {
          throw new UploadServiceError(
            "upload_failed",
            "Failed to verify the upload project.",
            500,
          );
        }

        if (!project) {
          throw new UploadServiceError(
            "upload_failed",
            "Project not found or not accessible to this user.",
            403,
          );
        }
        if (project.workspace_id !== input.workspaceId) {
          throw new UploadServiceError(
            "upload_failed",
            "Project belongs to a different workspace.",
            403,
          );
        }

        workspaceId = project.workspace_id;
      }

      const objectPath = buildObjectPath(
        workspaceId,
        input.projectId,
        input.fileName,
      );

      const { error: storageError } = await client.storage
        .from(input.bucket)
        .upload(objectPath, input.fileBuffer, {
          contentType: input.mimeType,
          upsert: false,
        });

      if (storageError) {
        throw new UploadServiceError(
          "upload_failed",
          `Storage upload failed: ${storageError.message}`,
          500,
        );
      }

      // Metadata is written through the ONE service_role-only entry point, which
      // derives project ownership itself — the user client cannot call it, and
      // must not insert asset rows directly.
      const { data: recorded, error: recordError } = await options
        .getAdminClient()
        .rpc("record_project_asset", {
          p_bucket: input.bucket,
          p_object_path: objectPath,
          p_created_by: user.id,
          p_fallback_workspace_id: workspaceId,
          p_project_id: input.projectId ?? null,
          p_canvas_id: null,
          p_mime_type: input.mimeType,
          p_byte_size: input.fileBuffer.length,
        });

      const assetId = (recorded as { asset_id?: string } | null)?.asset_id;

      if (recordError || !assetId) {
        // Clean up the uploaded file if its metadata could not be recorded.
        await client.storage.from(input.bucket).remove([objectPath]);
        throw new UploadServiceError(
          "upload_failed",
          "Failed to record asset metadata.",
          500,
        );
      }

      // Read the row back: it is the truthful createdAt and DTO (the RPC returns
      // ids only) and it proves the uploader can see what they just created.
      //
      // ADR-0001 / workorder 20E: this is the repository's read now, and its SQL
      // is the ACL — the row is only found when the caller is the project's author
      // or an admin/owner (or, for a project-less asset, its creator). A failure
      // and a missing row are still one answer: the object is removed again and the
      // existing 500 is reported, exactly as before, and no other compensation is
      // added.
      const assetRepository = options.assetReadRepository;
      let asset: AssetReadRow | null = null;

      if (assetRepository) {
        try {
          asset = await assetRepository.findReadableAsset({
            actorId: user.id,
            assetId,
          });
        } catch {
          asset = null;
        }
      }

      if (!asset) {
        await client.storage.from(input.bucket).remove([objectPath]);
        throw new UploadServiceError(
          "upload_failed",
          "Failed to record asset metadata.",
          500,
        );
      }

      // GN-11 / X-P7: an upload is a user upload unless the caller relays an
      // artifact it produced itself, in which case it names the real source.
      // Best effort: the object and its row exist, so a failure only warns.
      if (options.assetProvenanceRepository) {
        try {
          await options.assetProvenanceRepository.recordProvenance({
            actorId: user.id,
            assetId,
            provenance: {
              source: input.provenance?.source ?? "user_upload",
              operation: input.provenance?.operation ?? null,
              modelId: input.provenance?.modelId ?? null,
              prompt: input.provenance?.prompt ?? null,
              creditsCharged: input.provenance?.creditsCharged ?? null,
              actionId: input.provenance?.actionId ?? null,
              sourceJobId: input.provenance?.sourceJobId ?? null,
              parentArtifactId: input.provenance?.parentArtifactId ?? null,
            },
          });
        } catch {
          console.warn(`[asset-provenance] upload ${assetId}: provenance was not recorded`);
        }

        // ED-05: keep the name the user gave the file beside the ASCII object key,
        // under the same best-effort rule as the provenance above — the object and
        // its row already exist, so a failure here is a warning, not the upload's
        // answer. A name that is only whitespace is not a name.
        if (input.fileName.trim() !== "") {
          try {
            await options.assetProvenanceRepository.recordDisplayName({
              actorId: user.id,
              assetId,
              displayName: input.fileName,
            });
          } catch {
            console.warn(
              `[asset-display-name] upload ${assetId}: display name was not recorded`,
            );
          }
        }
      }

      const url = await getAssetUrl(client, input.bucket, objectPath);

      return {
        asset: {
          id: asset.id,
          bucket: asset.bucket as AssetBucket,
          objectPath: asset.object_path,
          mimeType: asset.mime_type,
          byteSize: asset.byte_size,
          workspaceId: asset.workspace_id,
          projectId: asset.project_id,
          createdAt: asset.created_at,
        },
        url,
      };
    },

    async getAssetUrl(user, assetId, signOptions) {
      const repository = options.assetReadRepository;

      // ADR-0001 / workorder 21AA: the row that names the bucket and the object is
      // `AssetReadRepository.findReadableAsset`'s now — the same statement
      // `deleteAsset` already used, so the two paths cannot disagree about what an
      // asset the caller may read is.
      //
      // Its ACL is the SELECT policy translated verbatim, and it answers
      // "no such asset", "not yours" and "already gone" as one `null`. A failure is
      // folded into the same answer on purpose: this route published a 404 for a
      // transport failure before the migration and keeps doing so, which is the one
      // place in this file where the two are deliberately indistinguishable.
      let assetRow: AssetReadRow | null = null;

      if (repository) {
        try {
          assetRow = await repository.findReadableAsset({
            actorId: user.id,
            assetId,
          });
        } catch {
          assetRow = null;
        }
      }

      if (!assetRow) {
        throw new UploadServiceError(
          "asset_not_found",
          "Asset not found.",
          404,
        );
      }

      const client = options.createUserClient(user.accessToken);

      if (!signOptions?.download) {
        return getAssetUrl(client, assetRow.bucket, assetRow.object_path);
      }

      // ED-05: a download is named after what the user called the file, not after
      // the object key the storage service had to ASCII-mangle. The stored name is
      // that; the key's last segment is only the fallback for rows that predate it.
      // A failed read is the same answer as a missing one: fall back, do not fail —
      // a nameless-but-working download beats no download.
      let storedName: string | null = null;

      if (options.assetProvenanceRepository) {
        try {
          storedName = await options.assetProvenanceRepository.readDisplayName({
            assetId,
          });
        } catch {
          storedName = null;
        }
      }

      return getAssetUrl(
        client,
        assetRow.bucket,
        assetRow.object_path,
        storedName ?? lastPathSegment(assetRow.object_path),
      );
    },

    async deleteAsset(user, assetId) {
      const client = options.createUserClient(user.accessToken);
      const repository = options.assetReadRepository;

      // ADR-0001 / workorder 20E: only the locating read moved. Its ACL is the
      // repository's SQL; a failure and "no such row" keep the existing single
      // answer, `asset_not_found` 404, and nothing has been removed at that point.
      let assetRow: AssetReadRow | null = null;

      if (repository) {
        try {
          assetRow = await repository.findReadableAsset({
            actorId: user.id,
            assetId,
          });
        } catch {
          assetRow = null;
        }
      }

      if (!assetRow) {
        throw new UploadServiceError(
          "asset_not_found",
          "Asset not found.",
          404,
        );
      }

      // The order is part of the contract: the object first, the row second.
      await client.storage
        .from(assetRow.bucket)
        .remove([assetRow.object_path]);

      // ADR-0001 / workorder 21AA: the row delete is the write repository's now.
      // Its SQL is `asset_objects_delete_self` translated verbatim, so the caller
      // still cannot delete a row it could not have deleted through the policy —
      // and zero rows still answers 204, exactly as the removed delete did, because
      // nothing here inspects the count.
      try {
        await options.assetWriteRepository.deleteOwnAsset({
          actorId: user.id,
          assetId,
        });
      } catch {
        throw new UploadServiceError(
          "upload_failed",
          "Failed to delete asset record.",
          500,
        );
      }
    },
  };
}

function buildObjectPath(
  workspaceId: string,
  projectId: string | undefined,
  fileName: string,
): string {
  const timestamp = Date.now();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (projectId) {
    return `${workspaceId}/${projectId}/${timestamp}-${safeName}`;
  }
  return `${workspaceId}/${timestamp}-${safeName}`;
}

/**
 * ED-05: what is left of an object key once the folders are gone — the closest
 * thing to a file name a stored object has on its own.
 */
function lastPathSegment(objectPath: string): string {
  const cut = objectPath.lastIndexOf("/");
  return cut === -1 ? objectPath : objectPath.slice(cut + 1);
}

/**
 * Every asset URL this service hands out is signed (X-52).
 *
 * `project-assets` used to be on a public allowlist, so an upload answered with a
 * permanent, unauthenticated URL. That is exactly what the ticket removes: reads
 * now go through the signing service, which authorises against the caller's JWT
 * and refuses rather than degrading to a public URL.
 *
 * ED-05: `download` is the name a download should carry; absent it, the signature
 * is the plain one this always produced.
 */
async function getAssetUrl(
  client: UserSupabaseClient,
  bucket: string,
  objectPath: string,
  download?: string,
): Promise<string> {
  try {
    return await signProjectAssetUrl(client, objectPath, {
      bucket,
      ...(download ? { download } : {}),
    });
  } catch (error) {
    throw new UploadServiceError(
      "upload_failed",
      error instanceof ProjectAssetUrlError
        ? error.message
        : "Failed to generate signed URL.",
      500,
    );
  }
}
