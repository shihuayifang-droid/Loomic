import type { AssetBucket, AssetObject } from "@loomic/shared";

import type {
  AssetReadRepository,
  AssetReadRow,
} from "../../db/asset-read-repository.js";
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
};

export type UploadService = {
  uploadFile(
    user: AuthenticatedUser,
    input: UploadFileInput,
  ): Promise<{ asset: AssetObject; url: string }>;

  getAssetUrl(
    user: AuthenticatedUser,
    assetId: string,
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
   * `deleteAsset` locates before removing the object. Same wire-it-or-fail rule as
   * above; the existing 500 (upload) / 404 (delete) are the answers.
   */
  assetReadRepository?: AssetReadRepository;
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

    async getAssetUrl(user, assetId) {
      const client = options.createUserClient(user.accessToken);

      const { data: assetRow, error } = await client
        .from("asset_objects")
        .select("bucket, object_path")
        .eq("id", assetId)
        .single();

      if (error || !assetRow) {
        throw new UploadServiceError(
          "asset_not_found",
          "Asset not found.",
          404,
        );
      }

      return getAssetUrl(client, assetRow.bucket, assetRow.object_path);
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

      // The order is part of the contract: the object first, the row second. The
      // DELETE below is NOT migrated — it stays the user client's PostgREST call.
      await client.storage
        .from(assetRow.bucket)
        .remove([assetRow.object_path]);

      const { error: deleteError } = await client
        .from("asset_objects")
        .delete()
        .eq("id", assetId);

      if (deleteError) {
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
 * Every asset URL this service hands out is signed (X-52).
 *
 * `project-assets` used to be on a public allowlist, so an upload answered with a
 * permanent, unauthenticated URL. That is exactly what the ticket removes: reads
 * now go through the signing service, which authorises against the caller's JWT
 * and refuses rather than degrading to a public URL.
 */
async function getAssetUrl(
  client: UserSupabaseClient,
  bucket: string,
  objectPath: string,
): Promise<string> {
  try {
    return await signProjectAssetUrl(client, objectPath, { bucket });
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
