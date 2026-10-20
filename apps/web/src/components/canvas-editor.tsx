"use client";

import "@excalidraw/excalidraw/index.css";

import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";

import type { RecoverableArtifact } from "@loomic/shared";
import type { WebSocketHandle } from "../hooks/use-websocket";
import { getServerBaseUrl } from "../lib/env";
import {
  fetchRecoverableArtifacts,
  recoverArtifacts,
  saveCanvas,
  uploadThumbnail,
  ApiApplicationError,
  CanvasVersionConflict,
} from "../lib/server-api";
import { VideoCanvasElement } from "./canvas/video-canvas-element";
import { FailedGenerationSlot } from "./media/failed-generation-slot";
import { GenerationShimmer } from "./media/generation-shimmer";
import {
  partitionCanvasFiles,
  collectReferencedFileIds,
  fetchPendingCanvasFiles,
  rememberDocumentFiles,
  mergeFilesForSave,
} from "../lib/canvas-files";
import {
  getVideoElementSrc,
  isVideoElement,
  stripResolvedVideoUrls,
} from "../lib/canvas-elements";
import {
  writeCanvasDraft,
  readCanvasDraft,
  clearCanvasDraft,
} from "../lib/canvas-draft";
import {
  mergeCanvasContent,
  mergeElementsById,
  type MergeableContent,
} from "../lib/canvas-merge";
import { CanvasToolMenu } from "./canvas-tool-menu";
import { ImageToolbarLayer } from "./canvas/image-toolbar-layer";
import { normalizeCanvasElements } from "../lib/canvas-normalize";
import { ErrorBoundary } from "./error-boundary";

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((mod) => mod.Excalidraw),
  { ssr: false },
);

// Safari <16.4 does not support requestIdleCallback — provide a fallback
// that defers via setTimeout(cb, 1) to approximate idle scheduling.
const ric: typeof requestIdleCallback =
  typeof window !== "undefined" && window.requestIdleCallback
    ? window.requestIdleCallback.bind(window)
    : ((cb: IdleRequestCallback) => setTimeout(cb, 1) as unknown as number);
const cic: typeof cancelIdleCallback =
  typeof window !== "undefined" && window.cancelIdleCallback
    ? window.cancelIdleCallback.bind(window)
    : clearTimeout;

// Memoize CanvasToolMenu to prevent re-renders when parent state changes
// (e.g. selection changes in the editor don't need to re-render the toolbar)
const MemoizedCanvasToolMenu = memo(CanvasToolMenu);

export type CanvasSelectedElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fileId?: string;
  dataUrl?: string;
  /**
   * Full-resolution storage URL. This is what gets attached to a message, so it
   * must NOT be the downscaled display variant: an "edit this image" prompt that
   * receives a 1024px re-encode instead of the 2048px original quietly loses
   * detail the user can see on screen but the model never gets.
   */
  storageUrl?: string;
  /** Downscaled variant, for thumbnails and inline chips only. */
  thumbnailUrl?: string;
  /**
   * The stored object's identity, read from the server's file projection
   * (`files[fileId].assetId`). This — never the element's own `id` — is what an
   * Agent run attaches: `resolveAttachmentContent` looks the value up in
   * `asset_objects` with the caller's JWT, so an element id answers "not
   * available to this user" and the whole run is refused.
   */
  assetId?: string;
};

type CanvasEditorProps = {
  canvasId: string;
  projectId: string;
  accessToken: string;
  initialContent: {
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  };
  /**
   * Server version `initialContent` was read at. Sent back on every save so a
   * write built on it is rejected (409) rather than overwriting newer content.
   * Undefined only when loaded by a caller that has not been updated.
   */
  initialVersion?: number;
  onApiReady?: (api: any) => void;
  /**
   * A storage-backed media URL (image file record, or a video element's
   * projected src) failed to load. The page re-reads the canvas so the server
   * mints fresh signatures for it.
   *
   * The URL is a bearer token: it is passed on, never logged.
   */
  onStorageMediaError?: (url: string) => void;
  ws?: WebSocketHandle;
  leftPanelOpen?: boolean;
  onSelectionChange?: (elements: CanvasSelectedElement[]) => void;
};

const SAVE_DEBOUNCE_MS = 1500;
const THUMBNAIL_DEBOUNCE_MS = 10_000;
const THUMBNAIL_MAX_SIZE = 400;

/** Backoff between auto-save retries. Length = number of retries. */
const SAVE_RETRY_DELAYS_MS = [800, 2400];

/**
 * Whether a failed save is worth retrying.
 *
 * A network-level failure surfaces as TypeError ("Failed to fetch") — that is
 * exactly the case a retry fixes (flaky connection, or the dev server
 * restarting mid-request). A 5xx means the server broke on something that may
 * be transient, e.g. a Postgres statement timeout. A 4xx will fail identically
 * no matter how often we resend, and ApiAuthError has already been retried with
 * a refreshed token inside saveCanvas.
 */
function isRetriableSaveError(err: unknown): boolean {
  if (err instanceof ApiApplicationError) {
    return err.status === undefined || err.status >= 500;
  }
  return err instanceof TypeError;
}

export function CanvasEditor({
  canvasId,
  projectId,
  accessToken,
  initialContent,
  initialVersion,
  onApiReady,
  onStorageMediaError,
  ws,
  leftPanelOpen,
  onSelectionChange,
}: CanvasEditorProps) {
  const { resolvedTheme } = useTheme();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbnailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;
  const [excalidrawApi, setExcalidrawApi] = useState<any>(null);

  // Epoch ms of the oldest edit that is still not on the server, or null when
  // everything is saved. Drives the warning badge -- previously a save that
  // exhausted its retries only reached console.error, which in production nobody
  // sees, so the canvas looked saved right up until the next reload lost it.
  const [unsavedSince, setUnsavedSince] = useState<number | null>(null);
  // Set when a draft from a previous session was restored into the scene.
  const [restoredDraft, setRestoredDraft] = useState<{
    savedAt: number;
    filesOmitted: boolean;
  } | null>(null);

  // Images this canvas generated that no element shows any more. Optimistic
  // concurrency (P2) stopped new losses, but canvases that lost images before it
  // landed still have the files sitting in Storage — nothing was ever deleted.
  // Empty array means "checked, nothing missing", so the notice never flashes.
  const [recoverable, setRecoverable] = useState<RecoverableArtifact[]>([]);
  const [recovering, setRecovering] = useState(false);

  const prevSelectedIdsRef = useRef<string>("");
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  // Read through a ref rather than the prop directly: the storage-URL resolve
  // effect below must not re-run when the page hands down a new callback
  // identity. Re-running it re-fetches images the scene already holds, and
  // `addFiles` ignores known ids — so the download would be thrown away.
  const onStorageMediaErrorRef = useRef(onStorageMediaError);
  onStorageMediaErrorRef.current = onStorageMediaError;
  // Tracks whether the one-time normalization pass has already run
  const normalizedRef = useRef(false);

  // Guard: prevent auto-save until Excalidraw has fully hydrated with initial data.
  // Without this, a page reload can fire onChange with empty elements before
  // initialData is applied, causing a FULL REPLACE that wipes existing content.
  const hydratedRef = useRef(false);
  const initialElementCountRef = useRef(initialContent.elements.filter((e) => !e.isDeleted).length);

  // Track pending save payload so we can flush on tab close / unmount
  const pendingSaveRef = useRef<{
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  } | null>(null);

  // Monotonic id of the newest auto-save payload. A retry only fires while its
  // payload is still the newest one: the PUT is a FULL REPLACE, so resending an
  // older snapshot after a newer one landed would silently undo the user's most
  // recent edits.
  //
  // NOTE: this is a client-side ordering guard only — it cannot see writes made
  // by anyone else (the agent appending a generated image, another tab). That is
  // what versionRef and the 409 handling below are for. Keep both.
  const saveSeqRef = useRef(0);

  // Server version this client's content is based on. Sent with every save so a
  // write built on stale content is rejected with 409 instead of erasing whatever
  // arrived in between.
  const versionRef = useRef<number | undefined>(initialVersion);

  // Ref to hold initialContent.files for storageUrl lookup in handleChange
  // without adding the full initialContent to the dependency array.
  const initialFilesRef = useRef(initialContent.files);
  initialFilesRef.current = initialContent.files;

  // True while this editor is mounted. Async work checks this instead of a
  // per-run cancellation flag, so a re-render cannot discard already-downloaded
  // images.
  //
  // Setting it back to true on mount is NOT redundant. React's dev StrictMode
  // mounts, unmounts and remounts every component; a ref that is only ever set to
  // false on cleanup stays false for the rest of the page's life, and then every
  // image silently fails to reach addFiles even though it downloaded fine. The
  // effect is declared before the resolve effect below so this runs first.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Checked once per canvas open: two indexed queries, and this is the moment the
  // user is actually looking at this canvas.
  useEffect(() => {
    let alive = true;

    // Retried once. Every Supabase call here goes through a local proxy that
    // intermittently resets a connection, and the server reports such a failure
    // as "canvas not found" — so without a retry one blip hides the notice until
    // the user happens to reload again. Opening the canvas never depends on this:
    // it is a repair affordance, not part of loading.
    const check = async (attempt: number): Promise<void> => {
      try {
        const artifacts = await fetchRecoverableArtifacts(
          accessTokenRef.current,
          canvasId,
        );
        if (alive) setRecoverable(artifacts);
      } catch (err) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 1_200));
          if (alive) await check(1);
          return;
        }
        console.log("[canvas-editor] recoverable check failed:", err);
      }
    };
    void check(0);

    return () => {
      alive = false;
    };
  }, [canvasId]);

  const handleRecover = useCallback(async () => {
    if (recovering || recoverable.length === 0) return;
    setRecovering(true);
    try {
      const outcome = await recoverArtifacts(
        accessTokenRef.current,
        canvasIdRef.current,
        recoverable.map((a) => a.jobId),
      );

      // Everything staged locally was built from the scene BEFORE the restore, and
      // the reload below fires `beforeunload`, which flushes exactly that. Left
      // alone it would PUT the pre-restore snapshot over the images the server
      // just put back — the same lost-update shape P2 exists to prevent, only
      // triggered by our own reload. Observed once in testing: the elements
      // survived but their file records did not, leaving broken images behind.
      // Adopting the server's new version keeps any save that does still slip
      // through conditional on current state rather than unconditional.
      pendingSaveRef.current = null;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (outcome.version !== undefined) versionRef.current = outcome.version;

      // Reload rather than splicing the elements in here. The images have to come
      // back through the load path that resolves oss:// markers into something
      // Excalidraw can render, and versionRef has to be re-seeded from the server.
      // Rebuilding both by hand would be a second implementation of the load path
      // — which is the class of bug that lost these images to begin with.
      window.location.reload();
    } catch (err) {
      setRecovering(false);
      console.error("[canvas-editor] recovery failed:", err);
    }
  }, [recoverable, recovering]);

  // WHICH files are referenced, reduced to a stable primitive.
  //
  // This must not be the elements array itself. Its identity changes on every
  // normalize pass, canvas.sync and re-render, and feeding that identity into
  // the memo below made `pendingUrls` a fresh array each time — which re-ran the
  // resolve effect, whose cleanup set `cancelled = true` on the in-flight run, so
  // `addFiles` was never reached. The images downloaded exactly once and then sat
  // in a discarded promise while the canvas showed grey placeholders and logged
  // nothing at all. Comparing the set's contents instead of the array's identity
  // is what makes the effect fire once per actual change.
  //
  // The element list is the persisted one, which still contains soft-deleted
  // elements — that is what keeps an undo from restoring a broken image.
  const referencedFileIdsKey = useMemo(
    () => [...collectReferencedFileIds(initialContent.elements)].sort().join(","),
    [initialContent.elements],
  );

  // Separate inline files (ready) from storage URLs (need async fetch).
  const { inlineFiles, pendingUrls } = useMemo(() => {
    rememberDocumentFiles(canvasId, initialContent.files);
    const referenced = new Set(
      referencedFileIdsKey ? referencedFileIdsKey.split(",") : [],
    );
    const { inline, pending, skippedOrphans } = partitionCanvasFiles(
      initialContent.files,
      referenced,
    );
    if (skippedOrphans.length > 0) {
      console.log(
        `[canvas-editor] skipped ${skippedOrphans.length} orphan file record(s) no element references`,
      );
    }
    return { inlineFiles: inline, pendingUrls: pending };
  }, [initialContent.files, referencedFileIdsKey, canvasId]);

  // Lazily resolve storage URLs and inject into Excalidraw.
  //
  // The guard is "did the component unmount", NOT "did this effect run get
  // superseded". A per-run cancelled flag throws away images that have already
  // finished downloading whenever the effect re-runs, and addFiles ignores ids the
  // scene already knows — so discarding them buys nothing and costs the user their
  // pixels, silently. Only an unmounted editor is a reason not to deliver.
  useEffect(() => {
    if (!excalidrawApi || pendingUrls.length === 0) return;

    async function resolveFiles() {
      // A file record's `storageUrl` / `storageUrlOriginal` are read-time
      // projections of an `oss://` marker, and their signatures expire. Telling
      // the page about a file that could not be fetched is what gets the canvas
      // re-read for a fresh one — otherwise the element stays a grey placeholder
      // for the life of the tab, since nothing else re-fetches it.
      const resolved = await fetchPendingCanvasFiles(pendingUrls, (url) => {
        onStorageMediaErrorRef.current?.(url);
      });
      if (mountedRef.current && resolved.length > 0) {
        excalidrawApi.addFiles(resolved);
        console.log(`[canvas-editor] Resolved ${resolved.length} storage files`);
      }
    }

    resolveFiles();
  }, [excalidrawApi, pendingUrls]);

  // On open, put the viewport where the work is.
  //
  // The saved document carries viewBackgroundColor and gridModeEnabled but not
  // scrollX/scrollY/zoom, so every reload starts the viewport at the origin. A
  // board whose images sit at x=1500 therefore opens on empty space, which looks
  // exactly like "the images did not load" even when they loaded perfectly.
  //
  // Runs once per canvas, and only when there is something to aim at.
  //
  // It has to WAIT for the scene rather than read it once. When the api first
  // becomes available Excalidraw has not yet applied initialData, so
  // getSceneElements() returns []; bailing out at that moment meant the effect
  // never ran again (its deps never change) and the viewport silently stayed at
  // the origin — the exact symptom this code exists to prevent.
  const framedRef = useRef(false);
  useEffect(() => {
    if (!excalidrawApi || framedRef.current) return;

    let attempts = 0;
    const maxAttempts = 40; // ~6s at 150ms
    const timer = setInterval(() => {
      attempts += 1;
      const elements = excalidrawApi
        .getSceneElements()
        .filter((el: { isDeleted?: boolean }) => !el.isDeleted);
      if (elements.length === 0) {
        if (attempts >= maxAttempts) clearInterval(timer);
        return;
      }
      clearInterval(timer);
      framedRef.current = true;
      excalidrawApi.scrollToContent(elements, {
        fitToViewport: true,
        // Do not magnify a small board past 1:1 — a single 600px image would
        // otherwise fill the screen at absurd zoom.
        maxZoom: 1,
        animate: false,
      });
    }, 150);

    return () => clearInterval(timer);
  }, [excalidrawApi, canvasId]);

  const handleExcalidrawApi = useCallback(
    (api: any) => {
      setExcalidrawApi(api);
      onApiReady?.(api);
    },
    [onApiReady],
  );

  // Normalize agent-created elements on initial load.
  // Uses DOM text measurement to fix server-side approximation errors.
  useEffect(() => {
    if (!excalidrawApi || normalizedRef.current) return;
    normalizedRef.current = true;

    // Run normalization after Excalidraw has loaded fonts.
    // Store the handle so we can cancel on unmount to prevent memory leaks.
    const idleHandle = ric(() => {
      try {
        const sceneElements = excalidrawApi.getSceneElements();
        // Create mutable copies for normalization
        const mutableElements = sceneElements.map((el: any) => ({ ...el }));
        const { changed } = normalizeCanvasElements(mutableElements);

        if (changed) {
          console.log("[canvas-editor] normalized agent-created elements");
          excalidrawApi.updateScene({
            elements: mutableElements,
            captureUpdate: "NONE",
          });
          // Persist normalized elements to DB
          const files: Record<string, Record<string, unknown>> = {};
          const rawFiles = excalidrawApi.getFiles() as Record<string, any>;
          for (const [id, file] of Object.entries(rawFiles)) {
            files[id] = { id: file.id, dataURL: file.dataURL, mimeType: file.mimeType, created: file.created };
          }
          const appState = excalidrawApi.getAppState();
          saveCanvas(
            accessTokenRef.current,
            canvasIdRef.current,
            {
              elements: mutableElements.filter((el: any) => !el.isDeleted),
              appState: { viewBackgroundColor: appState.viewBackgroundColor, gridModeEnabled: appState.gridModeEnabled },
              files,
            },
            versionRef.current,
          )
            .then((saved) => {
              if (saved.version !== undefined) versionRef.current = saved.version;
            })
            .catch((err: Error) => console.warn("[canvas-editor] normalization save failed:", err));
        }
      } catch (err) {
        console.warn("[canvas-editor] normalization failed:", err);
      }

      // Mark hydrated after normalization — auto-save is now safe.
      // Before this point, onChange may fire with incomplete element lists
      // during Excalidraw's internal initialization, which would cause a
      // FULL REPLACE with empty content and silently wipe existing data.
      hydratedRef.current = true;

      // Recover work whose save never completed.
      //
      // A draft on disk means exactly one thing: the last save was staged but
      // never acknowledged. Recovering has to happen after `hydratedRef` is set,
      // because the updateScene below is what triggers the onChange that saves
      // the recovered scene back.
      try {
        const draft = readCanvasDraft(canvasIdRef.current);
        if (draft) {
          const live = excalidrawApi.getSceneElements() as { id: string }[];

          // Union by id with the draft winning. Shared with the 409 conflict
          // path so the two cannot drift; see mergeElementsById for why this is
          // a union rather than a replace and what that tradeoff costs.
          const merged = mergeElementsById(
            live as unknown as Record<string, unknown>[],
            draft.content.elements as Record<string, unknown>[],
          );

          // Teach the file table about the draft's records before any save runs.
          // mergeFilesForSave pulls from here for files an element references but
          // the scene never loaded, which is precisely the state a recovered
          // `oss://` pointer is in -- so the image record survives the next save
          // and resolves normally on the following load.
          rememberDocumentFiles(canvasIdRef.current, {
            ...(initialFilesRef.current as Record<string, Record<string, unknown>>),
            ...(draft.content.files as Record<string, Record<string, unknown>>),
          });

          if (merged.length > live.length) {
            excalidrawApi.updateScene({
              elements: merged,
              captureUpdate: "NONE",
            });
            console.log(
              `[canvas-editor] recovered ${merged.length - live.length} unsaved element(s) ` +
                `from a draft written at ${new Date(draft.savedAt).toISOString()}`,
            );
            setRestoredDraft({
              savedAt: draft.savedAt,
              filesOmitted: draft.filesOmitted,
            });
            // updateScene fires onChange, which schedules the debounced save --
            // that is what puts the recovered scene on the server.
          } else {
            // Nothing extra in the draft: the save had in fact landed and only
            // the acknowledgement was lost. Drop it so it cannot resurrect
            // deletions on some later load.
            clearCanvasDraft(canvasIdRef.current);
          }
        }
      } catch (err) {
        console.warn("[canvas-editor] draft recovery failed:", err);
      }
    });
    return () => cic(idleHandle);
  }, [excalidrawApi]);

  const handleChange = useCallback(
    (elements: readonly any[], appState: any) => {
      // Skip auto-save until Excalidraw has fully hydrated with initial data.
      // During initialization, onChange may fire with empty/partial elements
      // which would wipe the persisted canvas via FULL REPLACE.
      if (!hydratedRef.current) return;

      // --- 1. Debounced save ---
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

      // Mark that a save is pending. The full payload is built lazily inside
      // the timeout to avoid constructing the files map on every drag frame.
      pendingSaveRef.current = { elements: [] as any, appState: {}, files: {} };

      saveTimerRef.current = setTimeout(() => {
        // Read the LIVE scene, not the `elements` snapshot this callback was
        // invoked with. The snapshot is up to SAVE_DEBOUNCE_MS old, and this PUT
        // is a FULL REPLACE — sending a stale snapshot silently deletes anything
        // that arrived in the meantime, e.g. a generation slot the backend
        // inserted while the debounce was still counting down.
        //
        // buildSavePayload also carries the "refuse to save empty when we loaded
        // with content" guard, so this is the only place that should assemble a
        // save payload.
        const built = buildSavePayloadRef.current();
        if (!built) return;
        // Reassignable: on a 409 this is replaced by the merge of ours + theirs
        // and the loop resends that instead.
        // Annotated rather than inferred: the conflict path below reassigns this
        // to a merged payload, and the literal's inferred appState shape is
        // narrower than the merge produces.
        let content: MergeableContent = built;
        pendingSaveRef.current = content;

        // Write-ahead: put the payload somewhere that survives a reload BEFORE
        // attempting the request. Doing it after a failure instead would leave a
        // window where a crash or a manual refresh loses the work, and that
        // window is exactly when things go wrong.
        if (!writeCanvasDraft(canvasId, content)) {
          console.warn(
            "[canvas-editor] could not stage a local draft; this save is unprotected",
          );
        }

        const seq = ++saveSeqRef.current;
        void (async () => {
          // Conflicts have their own budget, separate from the network retry
          // budget: a conflict is a different request (the merged payload), not a
          // repeat of a failed one. Bounded so a writer that keeps beating us
          // cannot spin here forever — after this the draft holds the work and
          // the unsaved indicator comes up.
          let conflictsLeft = 3;
          for (let attempt = 0; ; attempt++) {
            try {
              const saved = await saveCanvas(
                accessTokenRef.current,
                canvasId,
                content,
                versionRef.current,
              );
              if (saved.version !== undefined) versionRef.current = saved.version;
              if (pendingSaveRef.current === content) {
                pendingSaveRef.current = null;
              }
              // Acknowledged by the server, so the local copy is redundant.
              // Only clear when this is still the newest save in flight -- a
              // newer attempt has already staged its own draft, and wiping it
              // here would unprotect that one.
              if (seq === saveSeqRef.current) {
                clearCanvasDraft(canvasId);
                setUnsavedSince(null);
              }
              return;
            } catch (err) {
              // A newer snapshot is already queued or saved — this one is stale
              // and must not be resent.
              if (seq !== saveSeqRef.current) return;

              // Somebody else wrote first. Merge their elements into ours instead
              // of retrying blindly, which would reinstate the exact overwrite the
              // version check just prevented.
              if (err instanceof CanvasVersionConflict && conflictsLeft > 0) {
                conflictsLeft--;
                const merged = mergeCanvasContent(content, err.currentContent);
                const gained = merged.elements.length - content.elements.length;
                versionRef.current = err.currentVersion;
                console.warn(
                  `[canvas-editor] save conflict, merged with server version ` +
                    `${err.currentVersion} (ours=${content.elements.length} ` +
                    `theirs=${err.currentContent.elements.length} ` +
                    `merged=${merged.elements.length} elements)`,
                );
                content = merged;
                pendingSaveRef.current = merged;
                // Stage the merged payload before resending, same write-ahead
                // reasoning as the first attempt.
                writeCanvasDraft(canvasId, merged);
                // Show the elements that came in, otherwise the user's next edit
                // would be built on a scene that is missing them again.
                if (gained > 0 && excalidrawApi) {
                  excalidrawApi.updateScene({
                    elements: merged.elements,
                    captureUpdate: "NONE",
                  });
                }
                // `continue` without consuming a retry slot: a conflict is not a
                // transport failure, and the merged payload is a different
                // request. attempt-- keeps the network budget for real failures.
                attempt--;
                continue;
              }

              // Out of conflict budget: stop rather than fight. The draft is on
              // disk and the indicator will tell the user.
              if (err instanceof CanvasVersionConflict) {
                console.error(
                  "[canvas-editor] gave up after repeated save conflicts; " +
                    "work is preserved in the local draft",
                );
                setUnsavedSince(Date.now());
                return;
              }

              const delay = SAVE_RETRY_DELAYS_MS[attempt];
              if (delay === undefined || !isRetriableSaveError(err)) {
                console.error(
                  `[canvas-editor] save failed after ${attempt + 1} attempt(s):`,
                  err,
                );
                // The draft stays on disk deliberately. It is the only remaining
                // copy, and it is what the next page load recovers from.
                setUnsavedSince(Date.now());
                return;
              }
              console.warn(
                `[canvas-editor] save attempt ${attempt + 1} failed, retrying in ${delay}ms:`,
                err,
              );
              await new Promise((resolve) => setTimeout(resolve, delay));
              if (seq !== saveSeqRef.current) return;
            }
          }
        })();
      }, SAVE_DEBOUNCE_MS);

      // --- 2. Debounced thumbnail (runs much less frequently than save) ---
      if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current);
      thumbnailTimerRef.current = setTimeout(async () => {
        if (!excalidrawApi) return;
        try {
          const { exportToBlob } = await import("@excalidraw/excalidraw");
          const sceneElements = excalidrawApi.getSceneElements();
          const sceneFiles = excalidrawApi.getFiles();
          if (!sceneElements.length) return;

          const blob = await exportToBlob({
            elements: sceneElements,
            appState: { exportBackground: true },
            files: sceneFiles,
            mimeType: "image/webp",
            quality: 0.8,
            maxWidthOrHeight: THUMBNAIL_MAX_SIZE,
          });

          console.log("[canvas-editor] uploading thumbnail, blob size:", blob.size);
          await uploadThumbnail(accessTokenRef.current, projectId, blob);
          console.log("[canvas-editor] thumbnail uploaded OK");
        } catch (err) {
          console.warn("[canvas-editor] thumbnail generation/upload failed:", err);
        }
      }, THUMBNAIL_DEBOUNCE_MS);

      // --- 3. Selection change detection ---
      // Cheap string comparison avoids unnecessary downstream re-renders.
      const selectedIds = appState.selectedElementIds
        ? Object.keys(appState.selectedElementIds as Record<string, boolean>).filter(
            (id) => (appState.selectedElementIds as Record<string, boolean>)[id],
          ).sort().join(",")
        : "";

      if (selectedIds !== prevSelectedIdsRef.current) {
        prevSelectedIdsRef.current = selectedIds;
        if (onSelectionChangeRef.current) {
          if (!selectedIds) {
            onSelectionChangeRef.current([]);
          } else {
            const idSet = new Set(selectedIds.split(","));
            const selFiles: Record<string, any> = excalidrawApi?.getFiles() ?? {};
            const selected: CanvasSelectedElement[] = elements
              .filter((el: any) => idSet.has(el.id) && !el.isDeleted)
              .map((el: any) => {
                const base: CanvasSelectedElement = {
                  id: el.id,
                  type: el.type,
                  x: el.x ?? 0,
                  y: el.y ?? 0,
                  width: el.width ?? 0,
                  height: el.height ?? 0,
                };
                if (el.type === "text" && el.text) {
                  base.text = el.text;
                }
                if (el.type === "image" && el.fileId) {
                  base.fileId = el.fileId;
                  const file = selFiles[el.fileId];
                  if (file?.dataURL) {
                    base.dataUrl = file.dataURL;
                  }
                  // Prefer storage URL over base64 dataUrl for message attachments.
                  // Sources: 1) element customData (model-generated images)
                  //          2) initial canvas content files (server-resolved URLs)
                  //
                  // storageUrlOriginal comes first on purpose. The file record's
                  // `storageUrl` is now the downscaled display variant, so reading
                  // it here would attach a 1024px re-encode to every message.
                  const rec = initialFilesRef.current[el.fileId] as
                    | {
                        storageUrl?: string;
                        storageUrlOriginal?: string;
                        assetId?: string;
                      }
                    | undefined;
                  const fullUrl =
                    el.customData?.storageUrl ??
                    rec?.storageUrlOriginal ??
                    rec?.storageUrl;
                  if (typeof fullUrl === "string" && fullUrl) {
                    base.storageUrl = fullUrl;
                  }
                  const thumb = rec?.storageUrl ?? fullUrl;
                  if (typeof thumb === "string" && thumb) {
                    base.thumbnailUrl = thumb;
                  }
                  // The attachment identity: the server's projection of the stored
                  // object, not anything derived from the element.
                  if (typeof rec?.assetId === "string" && rec.assetId) {
                    base.assetId = rec.assetId;
                  }
                }
                return base;
              });
            onSelectionChangeRef.current(selected);
          }
        }
      }
    },
    [canvasId, projectId, excalidrawApi],
  );

  // Register screenshot RPC handler so the server can request canvas captures
  useEffect(() => {
    if (!ws || !excalidrawApi) return;

    const cleanup = ws.registerRPC(
      "canvas.screenshot",
      async (params) => {
        const { mode, region, max_dimension = 1024 } = params as {
          mode: string;
          region?: { x: number; y: number; width: number; height: number };
          max_dimension?: number;
        };

        const allElements = excalidrawApi
          .getSceneElements()
          .filter((e: any) => !e.isDeleted);
        const appState = excalidrawApi.getAppState();
        const files = excalidrawApi.getFiles();

        let elements = allElements;

        if (mode === "region" && region) {
          elements = allElements.filter((el: any) => {
            const ex = (el.x as number) ?? 0;
            const ey = (el.y as number) ?? 0;
            const ew = (el.width as number) ?? 0;
            const eh = (el.height as number) ?? 0;
            return !(
              ex + ew < region.x ||
              ex > region.x + region.width ||
              ey + eh < region.y ||
              ey > region.y + region.height
            );
          });
        } else if (mode === "viewport") {
          const zoom = (appState.zoom?.value as number) ?? 1;
          const sx = -((appState.scrollX as number) ?? 0);
          const sy = -((appState.scrollY as number) ?? 0);
          const vw = ((appState.width as number) ?? 1920) / zoom;
          const vh = ((appState.height as number) ?? 1080) / zoom;
          elements = allElements.filter((el: any) => {
            const ex = (el.x as number) ?? 0;
            const ey = (el.y as number) ?? 0;
            const ew = (el.width as number) ?? 0;
            const eh = (el.height as number) ?? 0;
            return !(
              ex + ew < sx || ex > sx + vw || ey + eh < sy || ey > sy + vh
            );
          });
        }

        const { exportToBlob } = await import("@excalidraw/excalidraw");
        const blob = await exportToBlob({
          elements,
          appState: { ...appState, exportBackground: true },
          files,
          maxWidthOrHeight: max_dimension,
          mimeType: "image/png",
        });

        // Convert blob to base64 data URL directly (no upload needed --
        // the image is passed inline to the model for visual understanding)
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("Failed to convert screenshot to data URL"));
          reader.readAsDataURL(blob);
        });

        const bmp = await createImageBitmap(blob);
        const width = bmp.width;
        const height = bmp.height;
        bmp.close();

        return { url: dataUrl, width, height };
      },
    );

    return cleanup;
  }, [ws, excalidrawApi, canvasId]);

  // Build a full save payload from current Excalidraw state.
  // Used by both beforeunload and unmount to flush pending changes.
  const buildSavePayload = useCallback(() => {
    if (!excalidrawApi) return null;
    // Never flush before hydration — Excalidraw may not have loaded elements yet
    if (!hydratedRef.current) return null;
    try {
      const sceneElements = excalidrawApi.getSceneElements();
      const rawFiles = excalidrawApi.getFiles() as Record<string, any>;
      const appState = excalidrawApi.getAppState();

      // Safety: refuse to save empty when we loaded with elements — prevents
      // race conditions from wiping canvas content during page teardown.
      const liveCount = sceneElements.filter((el: any) => !el.isDeleted).length;
      if (liveCount === 0 && initialElementCountRef.current > 0) {
        console.warn("[canvas-editor] skipping save: 0 elements but loaded with", initialElementCountRef.current);
        return null;
      }
      const files: Record<string, Record<string, unknown>> = {};
      for (const [id, file] of Object.entries(rawFiles)) {
        files[id] = {
          id: file.id,
          dataURL: file.dataURL,
          mimeType: file.mimeType,
          created: file.created,
        };
      }
      return {
        // CV-01: drop read-time extras (customData.resolvedVideoUrl) — this PUT
        // replaces the whole document, so anything left on an element here is
        // stored permanently, and a stored URL is what the object-key change
        // exists to prevent.
        elements: stripResolvedVideoUrls(
          sceneElements.filter((el: any) => !el.isDeleted),
        ),
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          gridModeEnabled: appState.gridModeEnabled,
        },
        // This PUT replaces the whole document. Any file the scene could not load
        // is missing from `rawFiles`, so sending it as-is would delete the
        // server's record and orphan the stored object; merge keeps those — but
        // only while an element still references them.
        files: mergeFilesForSave(
          canvasIdRef.current,
          files,
          new Set(
            sceneElements
              .filter((el: any) => !el.isDeleted && el.fileId)
              .map((el: any) => String(el.fileId)),
          ),
        ),
      };
    } catch (err) {
      console.warn("[canvas-editor] failed to build save payload on flush:", err);
      return null;
    }
  }, [excalidrawApi]);

  // Keep buildSavePayload accessible without stale closures
  const buildSavePayloadRef = useRef(buildSavePayload);
  buildSavePayloadRef.current = buildSavePayload;

  // Flush pending save on page close (beforeunload) and component unmount
  useEffect(() => {
    const flushBeforeUnload = () => {
      if (!pendingSaveRef.current) return;

      // Build the real payload since pendingSaveRef may hold a placeholder
      const payload = buildSavePayloadRef.current();
      if (!payload) return;

      // Stage locally first. A keepalive request reports nothing back -- the page
      // is already going away -- so this is the only way to know afterwards
      // whether it made it. If it did, the next load sees the server already has
      // the content and discards the draft; if it did not, the draft is what
      // brings the work back.
      writeCanvasDraft(canvasIdRef.current, payload);

      // Use fetch with keepalive to ensure the request survives page teardown.
      // keepalive requests are limited to 64 KiB total in-flight per page; for
      // canvases with very large embedded files this may exceed the limit, but
      // it's the best-effort approach -- sendBeacon has the same constraint.
      const url = `${getServerBaseUrl()}/api/canvases/${canvasIdRef.current}`;
      try {
        // The .catch matters: fetch rejects ASYNCHRONOUSLY, so the surrounding
        // try/catch never sees a network failure and it surfaced as
        // "Uncaught (in promise) TypeError: Failed to fetch" on every teardown
        // where the request could not complete.
        fetch(url, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessTokenRef.current}`,
            "Content-Type": "application/json",
          },
          // baseVersion is sent here too. It means this save can be REJECTED with
          // a 409 that nobody will ever see, since the page is unloading — and
          // that is the right outcome: better to leave the newer server content
          // intact and recover our work from the draft on the next load than to
          // overwrite someone else's element on the way out.
          body: JSON.stringify({
            content: payload,
            ...(versionRef.current !== undefined
              ? { baseVersion: versionRef.current }
              : {}),
          }),
          keepalive: true,
        }).catch(() => {
          // Best-effort -- the page is going away, there is no retry to make.
        });
      } catch {
        // Synchronous throw (e.g. invalid URL) -- also nothing to do here.
      }
      pendingSaveRef.current = null;
    };

    window.addEventListener("beforeunload", flushBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", flushBeforeUnload);

      // Cancel pending debounce timers
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current);

      // Flush pending save on component unmount (e.g. SPA navigation)
      if (pendingSaveRef.current) {
        const payload = buildSavePayloadRef.current();
        if (payload) {
          const id = canvasIdRef.current;
          writeCanvasDraft(id, payload);
          saveCanvas(accessTokenRef.current, id, payload, versionRef.current)
            .then((saved) => {
              if (saved.version !== undefined) versionRef.current = saved.version;
              clearCanvasDraft(id);
            })
            // A 409 cannot be merged here: the component is unmounting, so there
            // is nowhere to put the merged scene. The draft deliberately stays on
            // disk and the next load recovers from it — that is the case it exists
            // for.
            .catch(console.error);
        }
        pendingSaveRef.current = null;
      }
    };
  }, []);

  // Keep trying while anything is unsaved.
  //
  // The debounced path gives up after its backoff runs out, and would then wait
  // for the user's next edit. If they stop touching the canvas -- which is
  // exactly what happens after "I generated an image, it looked fine, I walked
  // away" -- the work would sit only in the local draft.
  //
  // The interval is not redundant with the `online` listener: the failure this
  // was built for is a proxy or upstream stalling while the NIC stays up, and
  // that fires no online/offline event at all. `visibilitychange` covers coming
  // back to a backgrounded tab, where timers are throttled.
  const hasUnsaved = unsavedSince !== null;
  useEffect(() => {
    if (!hasUnsaved) return;

    const retry = () => {
      const payload = buildSavePayloadRef.current();
      if (!payload) return;
      const id = canvasIdRef.current;
      const seq = ++saveSeqRef.current;
      writeCanvasDraft(id, payload);
      saveCanvas(accessTokenRef.current, id, payload, versionRef.current)
        .then((saved) => {
          if (seq !== saveSeqRef.current) return;
          if (saved.version !== undefined) versionRef.current = saved.version;
          clearCanvasDraft(id);
          setUnsavedSince(null);
          console.log("[canvas-editor] background retry saved the pending canvas");
        })
        .catch((err) => {
          // On a conflict, adopt the server's version and merge into the scene so
          // the NEXT tick builds its payload from combined content. Without this
          // the retry would resend the same stale version every 30s forever.
          if (err instanceof CanvasVersionConflict) {
            versionRef.current = err.currentVersion;
            if (excalidrawApi) {
              const merged = mergeElementsById(
                err.currentContent.elements,
                payload.elements,
              );
              if (merged.length > payload.elements.length) {
                excalidrawApi.updateScene({
                  elements: merged,
                  captureUpdate: "NONE",
                });
              }
            }
            console.warn(
              `[canvas-editor] background retry hit a conflict; adopted server ` +
                `version ${err.currentVersion} and merged`,
            );
            return;
          }
          // Still down. The next tick or event tries again; the draft stays put.
        });
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };

    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(retry, 30_000);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [hasUnsaved]);

  // Stable identity on purpose: `renderEmbeddable` is handed to Excalidraw, and a
  // new function there re-renders every embeddable on the canvas — the player
  // would reload its video (and lose playback position) for nothing.
  const handleVideoLoadError = useCallback((url: string) => {
    onStorageMediaErrorRef.current?.(url);
  }, []);

  // Render custom embeddable content for video elements on canvas.
  // Excalidraw calls this for every embeddable element; we intercept video URLs
  // and render an inline player, falling back to default for everything else.
  const renderEmbeddable = useCallback(
    (element: any, _appState: any) => {
      // GN-19: the job died server-side (`failed: true` replaces a stale
      // `generating: true`), so show the reason and offer to drop the slot.
      // Sits BEFORE the generating branch so a failure can never be masked.
      if (element?.customData?.failed === true) {
        return (
          <FailedGenerationSlot
            kind={element.customData.kind === "video" ? "video" : "image"}
            message={element.customData.failureMessage ?? "生成失败，请重试"}
            width={element.width ?? 512}
            height={element.height ?? 512}
            onDelete={() => {
              excalidrawApi?.updateScene({
                elements: excalidrawApi
                  .getSceneElements()
                  .map((el: any) =>
                    el.id === element.id ? { ...el, isDeleted: true } : el,
                  ),
              });
            }}
          />
        );
      }

      // A slot reserved by the backend while a generation runs. Rendered with the
      // same component the chat sidebar uses, so both views show one state for
      // one job — and, being a live component, it can actually animate.
      if (element?.customData?.generating) {
        return (
          <GenerationShimmer
            kind={element.customData.kind === "video" ? "video" : "image"}
            modelName={element.customData.modelName}
            startedAt={element.customData.startedAt}
            width={element.width ?? 512}
            height={element.height ?? 512}
          />
        );
      }

      // CV-01: play the projected URL, whichever way the element was written —
      // customData.resolvedVideoUrl from a marker, or link for pre-CV-01
      // elements. `getVideoElementSrc` returns undefined for a marker that has
      // not been projected, in which case Excalidraw's default takes over rather
      // than a <video> pointed at an oss:// string.
      const src = getVideoElementSrc(element);
      if (src && isVideoElement(element)) {
        return (
          <VideoCanvasElement
            src={src}
            width={element.width ?? 640}
            height={element.height ?? 360}
            onError={handleVideoLoadError}
          />
        );
      }
      // Return null to let Excalidraw handle non-video embeddables with default behavior
      return null;
    },
    [handleVideoLoadError, excalidrawApi],
  );

  // Allow any URL as a valid embeddable so our video links are accepted
  const validateEmbeddable = useCallback(() => true, []);

  return (
    <ErrorBoundary
      onError={(err) => console.error("[canvas-editor] render crashed:", err)}
    >
      <div className="h-full w-full relative">
        <Excalidraw
          theme={resolvedTheme === "dark" ? "dark" : "light"}
          initialData={{
            elements: initialContent.elements as any,
            appState: initialContent.appState as any,
            files: inlineFiles as any,
          }}
          onChange={handleChange}
          excalidrawAPI={handleExcalidrawApi}
          renderEmbeddable={renderEmbeddable}
          validateEmbeddable={validateEmbeddable}
        />
        {excalidrawApi && (
          <MemoizedCanvasToolMenu
            accessToken={accessToken}
            excalidrawApi={excalidrawApi}
            leftPanelOpen={leftPanelOpen ?? false}
            {...(ws ? { ws } : {})}
          />
        )}
        {excalidrawApi && <ImageToolbarLayer accessToken={accessToken} excalidrawApi={excalidrawApi} />}

        {/*
          Save state has to be visible. A save that exhausted its retries used to
          reach console.error only, so the canvas looked fine and the loss showed
          up on the next reload. Both notices sit above the canvas and below
          Excalidraw's own islands (z-10).
        */}
        {unsavedSince !== null && (
          <div
            role="status"
            className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs text-amber-700 backdrop-blur dark:text-amber-300"
          >
            改动未保存到服务器，已在本地留存，恢复网络后会自动重试
          </div>
        )}
        {restoredDraft !== null && (
          <button data-testid="canvas-editor-restored-draft-dismiss"
            type="button"
            onClick={() => setRestoredDraft(null)}
            className="absolute left-1/2 top-3 z-10 -translate-x-1/2 cursor-pointer rounded-full border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs text-sky-700 backdrop-blur dark:text-sky-300"
          >
            已恢复上次未保存的内容
            {restoredDraft.filesOmitted ? "（图片将从服务器重新加载）" : ""} · 点击关闭
          </button>
        )}

        {/*
          Generated images whose file is still in Storage but which no element
          shows. Sits a row lower so it does not overlap the two notices above.
          Restoring reloads the page, so it stays disabled while anything is
          unsaved — and says why, rather than looking broken.
        */}
        {recoverable.length > 0 && (
          <button data-testid="canvas-editor-recover-images"
            type="button"
            disabled={recovering || unsavedSince !== null}
            onClick={handleRecover}
            className="absolute left-1/2 top-12 z-10 -translate-x-1/2 cursor-pointer rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-700 backdrop-blur disabled:cursor-not-allowed disabled:opacity-60 dark:text-emerald-300"
          >
            {recovering
              ? "正在放回…"
              : unsavedSince !== null
                ? `有 ${recoverable.length} 张已生成的图片不在画布上 · 等改动保存后可放回`
                : `有 ${recoverable.length} 张已生成的图片不在画布上 · 点击放回`}
          </button>
        )}
      </div>
    </ErrorBoundary>
  );
}
