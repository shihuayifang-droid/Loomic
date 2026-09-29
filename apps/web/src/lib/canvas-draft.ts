/**
 * Write-ahead local copy of an unsaved canvas.
 *
 * WHY THIS EXISTS
 * The auto-save path already retries (three attempts, ~18s of backoff). What it
 * did not have was anywhere to put the payload once those ran out: the only copy
 * lived in an in-memory ref, so a reload, a crash, or simply closing the tab
 * threw the work away. Observed for real: a generated image was added, the save
 * hit a TLS reset, all retries failed, the user reloaded, the client re-read the
 * older server state and then saved THAT back -- turning a transient network
 * blip into permanent loss.
 *
 * So the payload is written here BEFORE the request goes out and cleared only
 * once the server has acknowledged it. If a draft is present at load time, that
 * by definition means the last save never completed.
 *
 * WHY localStorage
 * It is synchronous, which is what makes it usable from `beforeunload` where
 * IndexedDB's async API cannot finish. The payloads this guards are small
 * (~1 KB in practice, because generated images are stored as `oss://` pointers
 * rather than inline base64). SIZE_LIMIT_BYTES below handles the case where they
 * are not.
 */

const KEY_PREFIX = "loomic:canvas-draft:";

/**
 * Above this, the draft is stored without `files`.
 *
 * localStorage writes are synchronous and block the main thread, and the whole
 * origin shares a ~5 MB budget. A canvas holding several inline base64 images
 * would blow through both. Dropping `files` keeps the part that is actually
 * irreplaceable -- element geometry and layout -- because the server retains its
 * own file records (see mergeFilesForSave, which refuses to drop a file record
 * that an element still references). The images therefore come back from the
 * server; only unsaved never-uploaded bytes are lost, which is strictly better
 * than losing the entire scene.
 */
const SIZE_LIMIT_BYTES = 2_000_000;

export interface CanvasDraft {
  /** Epoch ms when this draft was written. */
  savedAt: number;
  /** True when `files` was dropped to stay under the size limit. */
  filesOmitted: boolean;
  content: {
    elements: unknown[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
  };
}

function keyFor(canvasId: string): string {
  return `${KEY_PREFIX}${canvasId}`;
}

/**
 * Record a payload as "attempted but not yet acknowledged".
 *
 * Never throws: a failure here must not take down the save it is protecting.
 * Returns whether anything was stored, so callers can log the difference between
 * "protected" and "too big / storage unavailable".
 */
export function writeCanvasDraft(
  canvasId: string,
  content: CanvasDraft["content"],
): boolean {
  if (typeof window === "undefined") return false;
  try {
    let draft: CanvasDraft = {
      savedAt: Date.now(),
      filesOmitted: false,
      content,
    };
    let serialised = JSON.stringify(draft);

    if (serialised.length > SIZE_LIMIT_BYTES) {
      draft = {
        savedAt: draft.savedAt,
        filesOmitted: true,
        content: { ...content, files: {} },
      };
      serialised = JSON.stringify(draft);
      // Still too big even without files: the element list alone is enormous.
      // Give up rather than throw a QuotaExceededError inside the save path.
      if (serialised.length > SIZE_LIMIT_BYTES) return false;
    }

    window.localStorage.setItem(keyFor(canvasId), serialised);
    return true;
  } catch {
    // Quota exceeded, private-mode restrictions, storage disabled -- all mean
    // "no local protection available", none of them mean "abort the save".
    return false;
  }
}

/** Read a pending draft, or null when the last save completed cleanly. */
export function readCanvasDraft(canvasId: string): CanvasDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(keyFor(canvasId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CanvasDraft;
    // Reject anything that is not shaped like a draft -- a half-written or
    // hand-edited entry must not be fed into the scene.
    if (
      !parsed ||
      typeof parsed.savedAt !== "number" ||
      !parsed.content ||
      !Array.isArray(parsed.content.elements)
    ) {
      window.localStorage.removeItem(keyFor(canvasId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the draft. Call this only after the server has acknowledged the save. */
export function clearCanvasDraft(canvasId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(keyFor(canvasId));
  } catch {
    // Nothing actionable; a stale draft is recoverable, a thrown error here is
    // not (it would run inside the save success path).
  }
}
