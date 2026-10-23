// Finding images that were generated successfully but are no longer on the canvas.
//
// WHY THIS CAN HAPPEN AT ALL
// A generated image lives in two places: the file in Supabase Storage (recorded
// by background_jobs.result / asset_objects) and the element that displays it
// (canvases.content). Only the second one could be lost — see canvas-version.ts
// for how a stale whole-content save used to erase elements. The bytes were
// never touched, so every one of those images is still fully recoverable.
//
// P2 stopped new losses. This closes the loop for the ones already lost.
//
// WHY DELETED ELEMENTS COUNT AS "ON THE CANVAS"
// Excalidraw deletes elements softly: a user deletion leaves the element in the
// array with isDeleted: true. An element erased by a stale overwrite leaves
// nothing at all. So "the canvas has no element referencing this file, not even
// a deleted one" is exactly the accidental-loss case, and a user who deliberately
// deleted an image is never nagged to restore it.

import type { CanvasContent } from "@loomic/shared";
import type { RecoverableArtifact } from "@loomic/shared";

import type {
  CanvasReadRepository,
  CanvasRecoveryJobRow,
} from "../../db/canvas-read-repository.js";
import {
  CanvasReadError,
  LIST_READABLE_SUCCEEDED_IMAGE_JOBS,
} from "../../db/canvas-read-repository.js";
import {
  CANVAS_FILES_BUCKET,
  OSS_MARKER_PREFIX,
  insertImageElement,
} from "./canvas-element-writer.js";
import { type CanvasStore, readCanvasSnapshot } from "./canvas-version.js";

/**
 * How the job list is authorised (workorder 20C).
 *
 * The snapshot still comes from `canvas-version.ts` — this ticket deliberately
 * does not touch the shared read/CAS path — but the job list is a pure read and
 * now goes through the repository, which re-derives the canvas's project ACL in
 * SQL and carries the actor into the transaction. The actor is the authenticated
 * user id, never a value from the request body.
 */
export type RecoveryReadAccess = {
  repository: CanvasReadRepository;
  actorId: string;
};

/**
 * Storage path a canvas file marker points at, or null if it is not a marker
 * (a plain base64 dataURL, for instance, which is not a generated artifact).
 *
 * Only the path is compared, not the bucket: the path already contains the
 * workspace id, a millisecond timestamp and the job uuid, so it is unique on its
 * own. The bucket is validated separately in `usableArtifact`.
 */
function markerObjectPath(dataURL: unknown): string | null {
  if (typeof dataURL !== "string") return null;
  if (!dataURL.startsWith(OSS_MARKER_PREFIX)) return null;
  const rest = dataURL.slice(OSS_MARKER_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const path = rest.slice(slash + 1);
  return path.length > 0 ? path : null;
}

/**
 * Every Storage path the canvas currently references, including through
 * soft-deleted elements (see the note at the top of this file).
 */
function referencedObjectPaths(content: CanvasContent): Set<string> {
  const elements = ((content as any).elements as Record<string, unknown>[]) ?? [];
  const files =
    ((content as any).files as Record<string, Record<string, unknown>>) ?? {};

  const paths = new Set<string>();
  for (const element of elements) {
    const fileId = element.fileId;
    if (typeof fileId !== "string") continue;
    const file = files[fileId];
    if (!file) continue;
    const path = markerObjectPath(file.dataURL);
    if (path) paths.add(path);
  }
  return paths;
}

/**
 * Turn a succeeded job row into a restorable artifact, or explain why it is not
 * one. Returning a reason instead of silently dropping the row matters: a job
 * whose file we cannot reference would otherwise look like "nothing to recover"
 * when in fact there is something we are failing to reach.
 */
function usableArtifact(
  job: CanvasRecoveryJobRow,
): { artifact: RecoverableArtifact } | { reason: string } {
  const result = job.result ?? {};
  const objectPath = result.object_path;
  if (typeof objectPath !== "string" || objectPath.length === 0) {
    return { reason: "result has no object_path" };
  }

  const width = Number(result.width);
  const height = Number(result.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    // Without real dimensions the element would be sized wrong; the image would
    // come back visibly distorted, which is worse than reporting it as unusable.
    return { reason: `result has no usable dimensions (${result.width}x${result.height})` };
  }

  const signedUrl = typeof result.signed_url === "string" ? result.signed_url : "";
  // insertImageElement always writes the marker against CANVAS_FILES_BUCKET, so
  // an artifact stored anywhere else would be restored as a broken image. The
  // job's own URL is the cheapest available evidence of which bucket it is in.
  if (signedUrl && !signedUrl.includes(`/${CANVAS_FILES_BUCKET}/`)) {
    return { reason: `stored outside ${CANVAS_FILES_BUCKET}: ${signedUrl}` };
  }

  const prompt = job.payload?.prompt;
  const mimeType =
    typeof result.mime_type === "string" && result.mime_type.length > 0
      ? result.mime_type
      : "image/png";

  return {
    artifact: {
      jobId: job.id,
      objectPath,
      width: Math.round(width),
      height: Math.round(height),
      mimeType,
      createdAt: job.created_at,
      ...(typeof prompt === "string" && prompt.length > 0 ? { prompt } : {}),
      ...(signedUrl ? { previewUrl: signedUrl } : {}),
    },
  };
}

/**
 * Succeeded image generations for one canvas, read through the canvas read
 * repository.
 *
 * Images only, on purpose. Video elements are embeddables carrying a signed URL
 * rather than an oss:// marker, and those URLs expire — restoring one would put a
 * permanently broken frame on the canvas. Recovering videos needs them re-signed
 * first, which is a separate change. The filter, the order and the ACL all live
 * in the repository's statement now.
 *
 * `access` is optional only so that the legacy manual verifier
 * `apps/server/_p25-verify.ts` — which still calls the two-argument form and is
 * outside this ticket — keeps compiling. It is NOT a way to skip the database:
 * omitting it fails loud instead of answering "nothing to recover".
 */
async function fetchSucceededImageJobs(
  access: RecoveryReadAccess | undefined,
  canvasId: string,
): Promise<CanvasRecoveryJobRow[]> {
  if (!access) {
    throw new CanvasReadError(
      LIST_READABLE_SUCCEEDED_IMAGE_JOBS,
      new Error("canvas read repository and actor are required"),
    );
  }

  return access.repository.listReadableSucceededImageJobs({
    actorId: access.actorId,
    canvasId,
  });
}

/**
 * Succeeded image generations for this canvas that no element references.
 * Read-only.
 */
export async function listRecoverableArtifacts(
  client: CanvasStore,
  canvasId: string,
  access?: RecoveryReadAccess,
): Promise<RecoverableArtifact[]> {
  const [snapshot, jobs] = await Promise.all([
    readCanvasSnapshot(client, canvasId),
    fetchSucceededImageJobs(access, canvasId),
  ]);

  const referenced = referencedObjectPaths(snapshot.content);
  const artifacts: RecoverableArtifact[] = [];
  const seen = new Set<string>();

  for (const job of jobs) {
    const checked = usableArtifact(job);
    if ("reason" in checked) {
      console.log(
        `[canvas-recovery] skipping job=${job.id} canvasId=${canvasId}: ${checked.reason}`,
      );
      continue;
    }
    const { artifact } = checked;
    if (referenced.has(artifact.objectPath)) continue;
    // Two jobs pointing at the same file would otherwise be offered twice and
    // restored twice.
    if (seen.has(artifact.objectPath)) continue;
    seen.add(artifact.objectPath);
    artifacts.push(artifact);
  }

  if (artifacts.length > 0) {
    console.log(
      `[canvas-recovery] canvasId=${canvasId} recoverable=${artifacts.length} ` +
        `of succeeded=${jobs.length} referenced=${referenced.size}`,
    );
  }
  return artifacts;
}

/**
 * Put the requested artifacts back on the canvas.
 *
 * The list is recomputed here rather than trusted from the request, so clicking
 * "restore" twice — or acting on a list built before someone else restored the
 * same image — cannot produce duplicates.
 *
 * Each insert goes through insertImageElement, i.e. through the same optimistic
 * concurrency that made these losses impossible in the first place.
 */
export async function recoverArtifacts(
  client: CanvasStore,
  canvasId: string,
  jobIds: string[],
  access?: RecoveryReadAccess,
): Promise<{ recovered: number; skipped: string[]; version?: number }> {
  const requested = new Set(jobIds);
  const available = await listRecoverableArtifacts(client, canvasId, access);
  const byJobId = new Map(available.map((a) => [a.jobId, a]));

  const skipped = jobIds.filter((id) => !byJobId.has(id));
  const toRestore = available.filter((a) => requested.has(a.jobId));

  for (const artifact of toRestore) {
    await insertImageElement(client, {
      canvasId,
      objectPath: artifact.objectPath,
      width: artifact.width,
      height: artifact.height,
      mimeType: artifact.mimeType,
      ...(artifact.prompt ? { title: artifact.prompt } : {}),
    });
  }

  // Read after the writes so the caller gets the version its next save must be
  // based on; skipping this would make the open editor's next save conflict.
  const after = await readCanvasSnapshot(client, canvasId);

  console.log(
    `[canvas-recovery] restored canvasId=${canvasId} recovered=${toRestore.length} ` +
      `skipped=${skipped.length} version=${after.version}`,
  );

  return { recovered: toRestore.length, skipped, version: after.version };
}
