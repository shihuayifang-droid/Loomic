/**
 * Turning a canvas document's `files` map into entries Excalidraw can render.
 *
 * The server does not ship image bytes inside the canvas document. On read it
 * adds a `storageUrl` alongside the `oss://` marker (see canvas-service's
 * resolveFilesFromStorage), so a file is only usable after the browser fetches
 * that URL and turns it into a dataURL.
 *
 * This lives in one place because there are two entry points that both need it —
 * the initial canvas load and every canvas.sync push. The sync path used to skip
 * the fetch and hand the raw entries to addFiles, which produced an element
 * pointing at a file with no data: the canvas showed a broken-image box even
 * though the generation had succeeded and the document was correct.
 */

export type CanvasFileMap = Record<string, Record<string, unknown>>;

/**
 * File ids that some element in the document still points at.
 *
 * Deliberately counts soft-deleted elements too. Excalidraw keeps deleted
 * elements in the document so they can be undone; dropping the file of a
 * deleted element would make undo restore a broken-image box.
 */
export function collectReferencedFileIds(
  elements: ReadonlyArray<Record<string, unknown>> | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const el of elements ?? []) {
    if (typeof el?.fileId === "string" && el.fileId) ids.add(el.fileId);
  }
  return ids;
}

export type ExcalidrawFileEntry = {
  id: string;
  mimeType: string;
  created: number;
  dataURL: string;
};

/**
 * Split a files map into entries that are ready to use and entries that still
 * need their bytes fetched.
 *
 * Orphans — file records no element points at — are dropped instead of fetched.
 * A document accumulates them because deleting an image element does not delete
 * its file record, so a long-lived canvas keeps paying to download images that
 * cannot be seen. Measured on a two-image canvas: 13.79 MB of the 13.79 MB
 * downloaded belonged to no element at all.
 *
 * `referencedFileIds` is required rather than optional on purpose: a caller that
 * forgot to pass it would silently go back to downloading everything, and the
 * only symptom would be a slow page.
 */
export type PendingCanvasFile = {
  fileId: string;
  url: string;
  /** Undownscaled object, tried when `url` cannot be fetched. */
  fallbackUrl?: string | undefined;
  meta: Record<string, unknown>;
};

export function partitionCanvasFiles(
  files: CanvasFileMap,
  referencedFileIds: Set<string>,
): {
  inline: CanvasFileMap;
  pending: PendingCanvasFile[];
  skippedOrphans: string[];
} {
  const inline: CanvasFileMap = {};
  const pending: PendingCanvasFile[] = [];
  const skippedOrphans: string[] = [];

  for (const [fileId, fileData] of Object.entries(files ?? {})) {
    if (!referencedFileIds.has(fileId)) {
      skippedOrphans.push(fileId);
      continue;
    }
    if (typeof fileData.storageUrl === "string" && fileData.storageUrl) {
      const fallback =
        typeof fileData.storageUrlOriginal === "string" &&
        fileData.storageUrlOriginal !== fileData.storageUrl
          ? fileData.storageUrlOriginal
          : undefined;
      pending.push({
        fileId,
        url: fileData.storageUrl,
        fallbackUrl: fallback,
        meta: fileData,
      });
    } else {
      inline[fileId] = fileData;
    }
  }
  return { inline, pending, skippedOrphans };
}

/**
 * Fetch one image, retrying a network failure once and then degrading to the
 * undownscaled original.
 *
 * The downscaled URL goes through Supabase's image renderer, a service that can
 * fail on its own: it threw `TypeError: Failed to fetch` for every image on a
 * canvas at once, then served them again minutes later. The old code caught that
 * into a console.warn and moved on, which left the element on screen as a grey
 * placeholder box — permanently, since nothing retries. An image the user owns
 * must not disappear because a size optimisation had a bad minute.
 *
 * A non-OK HTTP status is not retried at the same URL: 403/404 will say the same
 * thing a moment later. It does still fall through to the original, because the
 * renderer can reject an object that storage itself will happily serve.
 */
async function fetchImageBlob(
  fileId: string,
  urls: string[],
): Promise<Blob | null> {
  for (const [index, url] of urls.entries()) {
    const isFallback = index > 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // No Accept header on purpose: the server pins the output format in the
        // URL, so what comes back does not depend on content negotiation here.
        const resp = await fetch(url);
        if (resp.ok) {
          if (isFallback) {
            console.warn(
              `[canvas-files] file ${fileId} loaded from the full-size original; the downscaled URL failed`,
            );
          }
          return await resp.blob();
        }
        console.warn(
          `[canvas-files] file ${fileId} fetch returned ${resp.status}${isFallback ? " (fallback)" : ""}`,
        );
        break;
      } catch (err) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        console.warn(
          `[canvas-files] file ${fileId} unreachable${isFallback ? " (fallback)" : ""}:`,
          err,
        );
      }
    }
  }
  return null;
}

/**
 * Fetch the bytes for storage-backed files and convert them to dataURLs.
 * Failures are skipped rather than thrown: one unreachable file should not stop
 * the rest of the canvas from rendering.
 */
export async function fetchPendingCanvasFiles(
  pending: PendingCanvasFile[],
): Promise<ExcalidrawFileEntry[]> {
  const resolved: ExcalidrawFileEntry[] = [];

  await Promise.all(
    pending.map(async ({ fileId, url, fallbackUrl, meta }) => {
      try {
        const candidates = fallbackUrl ? [url, fallbackUrl] : [url];
        const blob = await fetchImageBlob(fileId, candidates);
        if (!blob) return;
        const dataURL = await blobToDataURL(blob);
        resolved.push({
          id: String(meta.id ?? fileId),
          // Trust the bytes we actually got, not what the document claims. The
          // server hands out a downscaled URL that answers in WebP, so the
          // document's mimeType ("image/png") no longer describes these bytes.
          // Recording the stale value would leave the entry's mimeType
          // disagreeing with its own dataURL, which is exactly the sort of
          // mismatch that surfaces later as a broken export rather than an error
          // here. It also matters for the fallback, which really is a PNG.
          mimeType: blob.type || String(meta.mimeType ?? ""),
          created: Number(meta.created ?? Date.now()),
          dataURL,
        });
      } catch (err) {
        console.warn(`[canvas-files] failed to resolve file ${fileId}:`, err);
      }
    }),
  );

  return resolved;
}

/**
 * Push a document's files into a live Excalidraw scene, fetching storage-backed
 * ones first.
 *
 * NOTE: Excalidraw's addFiles only fills in ids the scene does not already know;
 * re-adding a known id is silently ignored. Content updates therefore have to
 * arrive under a new file id (which is what the server does when a generation
 * slot is filled).
 */
export async function syncCanvasFilesIntoScene(
  api: { addFiles: (files: unknown[]) => void },
  files: CanvasFileMap,
  elements: ReadonlyArray<Record<string, unknown>>,
  canvasId?: string,
): Promise<void> {
  if (canvasId) rememberDocumentFiles(canvasId, files);
  // Elements come from the incoming document, not the live scene: this runs
  // before updateScene, so the scene does not know the new elements yet.
  const { inline, pending } = partitionCanvasFiles(
    files,
    collectReferencedFileIds(elements),
  );

  const inlineEntries = Object.values(inline);
  if (inlineEntries.length > 0) api.addFiles(inlineEntries);

  if (pending.length === 0) return;
  const fetched = await fetchPendingCanvasFiles(pending);
  if (fetched.length > 0) api.addFiles(fetched);
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Last file map the server sent us, per canvas.
 *
 * Saving the canvas is a FULL REPLACE built from Excalidraw's in-memory files.
 * If a file could not be resolved (unreachable storage URL, permission error) it
 * is absent from that memory — so a save would drop the entry and permanently
 * orphan the stored object. Keeping the server's own version lets a save carry
 * unresolvable files through untouched instead of destroying them.
 */
const documentFiles = new Map<string, CanvasFileMap>();

export function rememberDocumentFiles(
  canvasId: string,
  files: CanvasFileMap,
): void {
  documentFiles.set(canvasId, { ...(files ?? {}) });
}

const OSS_MARKER_PREFIX = "oss://";

/** Strip read-time extras (storageUrl) so they never get written back. */
function toStoredEntry(
  fileId: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: entry.id ?? fileId,
    dataURL: entry.dataURL,
    mimeType: entry.mimeType,
    created: entry.created,
  };
}

/**
 * Build the `files` map to save, given the live scene and what the server last
 * sent us.
 *
 * Two jobs, both about a full-replace PUT being unforgiving:
 *
 * 1. NEVER RE-SEND BYTES THAT ARE ALREADY STORED. A stored image arrives as an
 *    `oss://` marker, gets fetched, and lives in Excalidraw's memory as a base64
 *    dataURL. Saving that memory verbatim would ship every image's bytes on every
 *    save — at ~6 MB of base64 per image a canvas of a few dozen blows straight
 *    past the endpoint's 50 MB limit, and then NOTHING saves, including the
 *    element positions the user actually changed. Sending the marker keeps a save
 *    at a few KB no matter how many images the canvas holds.
 *
 * 2. Don't drop a file the scene failed to load. If resolution failed the entry
 *    is missing from memory, and writing that omission would orphan the stored
 *    object. Only still-referenced entries are preserved, so genuinely dead
 *    records can still be pruned.
 */
export function mergeFilesForSave(
  canvasId: string,
  liveFiles: CanvasFileMap,
  referencedFileIds: Set<string>,
): CanvasFileMap {
  const known = documentFiles.get(canvasId);
  if (!known) return liveFiles;

  const out: CanvasFileMap = {};

  for (const [fileId, live] of Object.entries(liveFiles)) {
    const knownEntry = known[fileId];
    const knownDataUrl = knownEntry?.dataURL;
    if (
      knownEntry &&
      typeof knownDataUrl === "string" &&
      knownDataUrl.startsWith(OSS_MARKER_PREFIX)
    ) {
      // Already in storage — send the pointer, not the pixels.
      out[fileId] = toStoredEntry(fileId, knownEntry);
    } else {
      out[fileId] = live;
    }
  }

  // Files an element still needs but the scene never loaded.
  for (const [fileId, entry] of Object.entries(known)) {
    if (out[fileId]) continue;
    if (!referencedFileIds.has(fileId)) continue;
    out[fileId] = toStoredEntry(fileId, entry);
  }

  return out;
}
