import type { AssetBucket, AssetObject } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

/** Buckets configured as public in Supabase — use getPublicUrl instead of signed URLs */
const PUBLIC_BUCKETS = new Set(["project-assets"]);

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

const SIGNED_URL_EXPIRY_SECONDS = 3600;

export function createUploadService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
}): UploadService {
  return {
    async uploadFile(user, input) {
      const client = options.createUserClient(user.accessToken);

      // A project upload belongs to the workspace that actually owns the project.
      // The client sends both ids, and both are used to build the object path and
      // the asset row, so a client that names someone else's workspace would file
      // the object under a workspace its project does not belong to. Verified
      // through the CALLER's client, so RLS also decides whether they may use the
      // project at all.
      let workspaceId = input.workspaceId;

      if (input.projectId) {
        const { data: project, error: projectError } = await client
          .from("projects")
          .select("workspace_id")
          .eq("id", input.projectId)
          .maybeSingle();

        if (projectError) {
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

      // Read the row back through the user's own client: it is the truthful
      // createdAt (the RPC returns ids only) and it proves the uploader can see
      // what they just created.
      const { data: assetRow, error: readError } = await client
        .from("asset_objects")
        .select("id, bucket, object_path, mime_type, byte_size, workspace_id, project_id, created_at")
        .eq("id", assetId)
        .single();

      if (readError || !assetRow) {
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
          id: assetRow.id,
          bucket: assetRow.bucket as AssetBucket,
          objectPath: assetRow.object_path,
          mimeType: assetRow.mime_type,
          byteSize: assetRow.byte_size,
          workspaceId: assetRow.workspace_id,
          projectId: assetRow.project_id,
          createdAt: assetRow.created_at,
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

      const { data: assetRow, error: fetchError } = await client
        .from("asset_objects")
        .select("bucket, object_path")
        .eq("id", assetId)
        .single();

      if (fetchError || !assetRow) {
        throw new UploadServiceError(
          "asset_not_found",
          "Asset not found.",
          404,
        );
      }

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

async function getAssetUrl(
  client: UserSupabaseClient,
  bucket: string,
  objectPath: string,
): Promise<string> {
  if (PUBLIC_BUCKETS.has(bucket)) {
    const { data } = client.storage.from(bucket).getPublicUrl(objectPath);
    return data.publicUrl;
  }
  // Fallback for private buckets (e.g. user-avatars)
  return createSignedUrl(client, bucket, objectPath);
}

async function createSignedUrl(
  client: UserSupabaseClient,
  bucket: string,
  objectPath: string,
): Promise<string> {
  const { data, error } = await client.storage
    .from(bucket)
    .createSignedUrl(objectPath, SIGNED_URL_EXPIRY_SECONDS);

  if (error || !data?.signedUrl) {
    throw new UploadServiceError(
      "upload_failed",
      "Failed to generate signed URL.",
      500,
    );
  }

  return data.signedUrl;
}
