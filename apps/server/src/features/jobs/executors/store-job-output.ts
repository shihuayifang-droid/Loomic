// Shared "store a job's product" step: upload the bytes to the project-assets
// bucket and record ownership through the single service_role-only entry point.
// Image generation and tool execution both end here, so the storage write and the
// ownership record live in exactly one place.
import type { AdminSupabaseClient } from "../../../supabase/admin.js";

export type StoreJobOutputInput = {
  objectPath: string;
  bytes: Buffer;
  mimeType: string;
  createdBy: string;
  workspaceId: string;
  projectId: string | null;
  canvasId: string | null;
};

export async function storeJobOutput(
  admin: AdminSupabaseClient,
  input: StoreJobOutputInput,
): Promise<{ assetId: string; objectPath: string }> {
  const { objectPath, bytes, mimeType, createdBy, workspaceId, projectId, canvasId } = input;

  // Upload to Supabase Storage under the project-assets bucket
  const { error: uploadError } = await admin.storage
    .from("project-assets")
    .upload(objectPath, bytes, {
      contentType: mimeType,
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Storage upload failed: ${uploadError.message}`);
  }

  // Record ownership through the single service_role-only entry point. A
  // direct insert here is what left generated media attached to the billing
  // workspace with project_id null, which a private bucket then cannot
  // authorise. If this fails the job must fail: an uploaded object with no
  // metadata is exactly the "silent success" this ticket exists to remove.
  const { data: assetData, error: assetError } = await admin.rpc("record_project_asset", {
    p_bucket: "project-assets",
    p_object_path: objectPath,
    p_created_by: createdBy,
    p_fallback_workspace_id: workspaceId,
    p_project_id: projectId,
    p_canvas_id: canvasId,
    p_mime_type: mimeType,
    p_byte_size: bytes.length,
  });

  if (assetError) {
    throw new Error(`Failed to record asset ownership: ${assetError.message}`);
  }

  const assetId = (assetData as { asset_id?: string } | null)?.asset_id;
  if (!assetId) {
    throw new Error("Failed to record asset ownership: no asset id returned");
  }

  return { assetId, objectPath };
}
