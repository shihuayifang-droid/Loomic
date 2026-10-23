import type { Readable } from "node:stream";

import { ZipFile } from "yazl";

import type { AssetBucket, AssetObject, ToolOutputSource } from "@loomic/shared";

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
import { planZipDownload } from "../downloads/zip-download-plan.js";
import type { ObjectRef, ObjectStore } from "../storage/object-store.js";
import { ObjectStoreError } from "../storage/object-store.js";
import {
  ProjectAssetUrlError,
  signProjectAssetUrl,
  signProjectAssetUrls,
} from "../storage/project-asset-urls.js";
import type { SupabaseStorageLike } from "../storage/supabase-object-store.js";
import { createSupabaseObjectStore } from "../storage/supabase-object-store.js";

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

  /**
   * ED-00i: a tool output the browser rendered itself (`tool:adjust`, `tool:crop`)
   * arrives here. The `source` is a whitelisted `tool:*` value, so relaying such
   * an artifact through the front end can no longer be recorded as `user_upload`.
   *
   * The parent artifact is read first through the same repository every other
   * read in this file uses — its SQL is the authorization, so "no such asset"
   * and "not yours" are one answer (404) and a repository that refuses or is not
   * wired is the existing 500. Nothing is uploaded before that read succeeds.
   *
   * The bytes themselves go through `uploadFile` unchanged (no second storage
   * call), with the parent's project so the output joins the source image's
   * project. `params` the tool ran with are NOT stored: `asset_objects` has no
   * column for them. No billing is touched — this service has none.
   */
  uploadToolOutput(
    user: AuthenticatedUser,
    input: {
      parentArtifactId: string;
      source: ToolOutputSource;
      fileName: string;
      fileBuffer: Buffer;
      mimeType: string;
      workspaceId: string;
    },
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

  /**
   * AS-06: the reference tab — this project's own uploaded files, newest first by
   * default, optionally oldest first and/or filtered to one media kind.
   *
   * `url` is a short-lived signature, exactly like every other URL this file hands
   * out; a row whose object could not be signed keeps its metadata with `url: null`
   * rather than being dropped, so one unreadable object does not empty the drawer.
   */
  listProjectUploads(
    user: AuthenticatedUser,
    input: {
      projectId: string;
      order?: "newest" | "oldest";
      mediaType?: "image" | "video" | "pdf";
    },
  ): Promise<
    Array<{
      id: string;
      name: string;
      mimeType: string | null;
      byteSize: number | null;
      createdAt: string;
      url: string | null;
    }>
  >;

  /**
   * ED-05: bundle several readable artifacts into one zip stream.
   *
   * The plan (names, limits, skipped count) comes from `planZipDownload`. Objects
   * are read one at a time into memory and then written into the zip, so the peak
   * memory is about the largest single object; the total is bounded by the plan's
   * 500MB limit.
   *
   * The stream is returned immediately and filled in the background. `skipped`
   * only counts objects skipped at plan time (unreadable / not ready): an object
   * that fails to download once the stream has started is left out of the zip, but
   * the response headers are already sent, so it is not reflected in `skipped`.
   */
  prepareZipDownload(
    user: AuthenticatedUser,
    input: { assetIds: readonly string[]; projectName: string; now?: Date },
  ): Promise<
    | { ok: true; fileName: string; skipped: number; stream: NodeJS.ReadableStream }
    | { ok: false; message: string }
  >;
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
  const service: UploadService = {
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

      try {
        await storeFor(client).put(
          { bucket: input.bucket, key: objectPath },
          input.fileBuffer,
          { contentType: input.mimeType, upsert: false },
        );
      } catch (err) {
        const message =
          err instanceof ObjectStoreError
            ? (err.detail ?? err.message)
            : String(err);
        throw new UploadServiceError(
          "upload_failed",
          `Storage upload failed: ${message}`,
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
        await removeQuietly(storeFor(client), {
          bucket: input.bucket,
          key: objectPath,
        });
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
        await removeQuietly(storeFor(client), {
          bucket: input.bucket,
          key: objectPath,
        });
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

    // ED-00i: the browser rendered a tool output and uploads it itself. The
    // parent is read first, so an output can never be filed against a source the
    // caller cannot read, and the bytes then take the ordinary `uploadFile` path
    // with `tool:*` provenance — the relay therefore cannot change the source.
    async uploadToolOutput(user, input) {
      const repository = options.assetReadRepository;

      if (!repository) {
        throw new UploadServiceError(
          "upload_failed",
          "Failed to verify the source artifact.",
          500,
        );
      }

      let parent: AssetReadRow | null = null;

      try {
        parent = await repository.findReadableAsset({
          actorId: user.id,
          assetId: input.parentArtifactId,
        });
      } catch {
        throw new UploadServiceError(
          "upload_failed",
          "Failed to verify the source artifact.",
          500,
        );
      }

      if (!parent) {
        throw new UploadServiceError(
          "upload_failed",
          "源图不存在或无权访问",
          404,
        );
      }

      return service.uploadFile(user, {
        bucket: "project-assets",
        fileName: input.fileName,
        fileBuffer: input.fileBuffer,
        mimeType: input.mimeType,
        workspaceId: input.workspaceId,
        // The output joins the source image's project; a project-less parent
        // stays project-less rather than inventing one.
        ...(parent.project_id === null ? {} : { projectId: parent.project_id }),
        provenance: {
          source: input.source,
          operation: input.source.slice("tool:".length),
          creditsCharged: 0,
          parentArtifactId: input.parentArtifactId,
        },
      });
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

    /**
     * AS-06: the reference drawer's list.
     *
     * Two answers this method must not collapse:
     *
     * - a repository that does not carry the list at all is a WIRING gap, not an
     *   empty project: 503, so a half-wired deployment is visible instead of
     *   looking like "this project has no uploads";
     * - a repository that refused is a read failure: the existing 500 shape.
     *
     * The URLs are minted through the one signing helper every other path uses,
     * grouped by the bucket each row names — no second storage call is introduced
     * (34G: the dependency audit counts those), and a path that cannot be signed is
     * simply `null` on that row, exactly as the helper's contract says.
     */
    async listProjectUploads(user, input) {
      const repository = options.assetReadRepository;
      const listReadable = repository?.listReadableProjectUploads;

      if (!repository || !listReadable) {
        throw new UploadServiceError(
          "upload_failed",
          "Listing uploads is not available.",
          503,
        );
      }

      let rows: Awaited<ReturnType<typeof listReadable>>;

      try {
        rows = await listReadable.call(repository, {
          actorId: user.id,
          projectId: input.projectId,
          order: input.order ?? "newest",
          ...(input.mediaType === undefined
            ? {}
            : { mediaType: input.mediaType }),
          limit: 200,
        });
      } catch {
        throw new UploadServiceError(
          "upload_failed",
          "Failed to list uploads.",
          500,
        );
      }

      const pathsByBucket = new Map<string, string[]>();

      for (const row of rows) {
        const paths = pathsByBucket.get(row.bucket);
        if (paths) paths.push(row.object_path);
        else pathsByBucket.set(row.bucket, [row.object_path]);
      }

      const client = options.createUserClient(user.accessToken);
      const signedByBucket = new Map<string, Map<string, string>>();

      await Promise.all(
        [...pathsByBucket].map(async ([bucket, paths]) => {
          signedByBucket.set(
            bucket,
            await signProjectAssetUrls(client, paths, { bucket }),
          );
        }),
      );

      return rows.map((row) => ({
        id: row.id,
        // ED-05: what the person called the file, falling back to the object key's
        // last segment for rows that predate the stored name.
        name:
          row.display_name !== null && row.display_name.trim() !== ""
            ? row.display_name
            : lastPathSegment(row.object_path),
        mimeType: row.mime_type,
        byteSize: row.byte_size,
        createdAt: row.created_at,
        url: signedByBucket.get(row.bucket)?.get(row.object_path) ?? null,
      }));
    },

    async prepareZipDownload(user, input) {
      const client = options.createUserClient(user.accessToken);
      const repository = options.assetReadRepository;
      const uniqueIds = [...new Set(input.assetIds)];

      const rows = new Map<string, AssetReadRow>();
      const items: Array<{
        id: string;
        name: string;
        byteSize: number | null;
        status: "ready" | "failed";
      }> = [];

      for (const assetId of uniqueIds) {
        let row: AssetReadRow | null = null;

        if (repository) {
          try {
            row = await repository.findReadableAsset({
              actorId: user.id,
              assetId,
            });
          } catch {
            row = null;
          }
        }

        if (!row) {
          items.push({ id: assetId, name: assetId, byteSize: null, status: "failed" });
          continue;
        }

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

        const name =
          storedName && storedName.trim() !== ""
            ? storedName
            : lastPathSegment(row.object_path);

        rows.set(assetId, row);
        items.push({ id: assetId, name, byteSize: row.byte_size, status: "ready" });
      }

      const plan = planZipDownload({
        projectName: input.projectName,
        now: input.now ?? new Date(),
        items,
      });

      if (!plan.ok) {
        return { ok: false, message: plan.message };
      }

      const zip = new ZipFile();

      // Fill the zip in the background so the caller can start streaming at once.
      void (async () => {
        try {
          for (const entry of plan.entries) {
            const row = rows.get(entry.id);
            if (!row) continue;

            try {
              const url = await signProjectAssetUrl(client, row.object_path, {
                bucket: row.bucket,
              });
              const res = await fetch(url);

              if (!res.ok) {
                console.warn("[zip-download] an object could not be read; skipped");
                continue;
              }

              zip.addBuffer(Buffer.from(await res.arrayBuffer()), entry.entryName);
            } catch {
              console.warn("[zip-download] an object could not be read; skipped");
            }
          }

          zip.end();
        } catch (error) {
          (zip.outputStream as Readable).destroy(
            error instanceof Error ? error : new Error("zip download failed"),
          );
        }
      })();

      return {
        ok: true,
        fileName: plan.fileName,
        skipped: plan.skipped,
        stream: zip.outputStream,
      };
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
      await removeQuietly(storeFor(client), {
        bucket: assetRow.bucket,
        key: assetRow.object_path,
      });

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

  return service;
}

/**
 * 43F: every object operation in this file goes through the `ObjectStore` seam,
 * with the user client wrapped as they were doing before with the raw SDK.
 */
const storeFor = (client: UserSupabaseClient): ObjectStore =>
  createSupabaseObjectStore(client as unknown as SupabaseStorageLike);

/**
 * 43F: the compensation paths (an upload whose row could not be recorded, a
 * delete) never inspected the backend error before this ticket and still do not:
 * the object is removed best-effort and the caller sees the existing answer.
 */
async function removeQuietly(
  store: ObjectStore,
  ref: ObjectRef,
): Promise<void> {
  try {
    await store.delete([ref]);
  } catch {
    // Same as before 43F: a failed removal during rollback / delete is ignored.
  }
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
