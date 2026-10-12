import type { ImageArtifact, VideoArtifact } from "@loomic/shared";

import { getServerBaseUrl } from "./env";

/** Video file extensions recognized for inline playback on canvas. */
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".ogg", ".mov"];

/**
 * Canvas media lives in Supabase Storage, and the canvas document references it
 * by an `oss://<bucket>/<objectPath>` marker — the same format generated images
 * already use in the files map (see the server's canvas-element-writer).
 *
 * LOCAL FORK (CV-01): a video element used to be persisted with the provider's
 * public URL in `link`. That made every canvas video depend on the bucket
 * staying public; X-52 flips it private, which would have broken all of them at
 * once with nothing left to re-resolve from.
 */
const OSS_MARKER_PREFIX = "oss://";
const CANVAS_FILES_BUCKET = "project-assets";

/**
 * Is this element a video?
 *
 * `customData.isVideo` is the authority. The URL-shape check cannot answer the
 * question any more: once a video is keyed by its object, `link` is an `oss://`
 * marker with no extension at all. The check stays as a fallback so canvases
 * written before the flag meant anything keep rendering.
 */
export function isVideoElement(element: any): boolean {
  if (element?.customData?.isVideo === true) return true;
  return typeof element?.link === "string" && isVideoUrl(element.link);
}

/**
 * The URL to actually load for a video element.
 *
 * `customData.resolvedVideoUrl` is the read-time projection the server attaches
 * to a marker (canvas-service's resolveVideoElementsFromStorage). `link` is the
 * fallback for elements written before CV-01, which held a real URL.
 *
 * An unresolved `oss://` marker is deliberately NOT returned: handing it to a
 * <video> element produces a load error, and the callers would rather show
 * nothing than fetch something that cannot work.
 */
export function getVideoElementSrc(element: any): string | undefined {
  const resolved = element?.customData?.resolvedVideoUrl;
  if (typeof resolved === "string" && resolved.length > 0) return resolved;

  const link = element?.link;
  if (typeof link !== "string" || link.length === 0) return undefined;
  if (link.startsWith(OSS_MARKER_PREFIX)) return undefined;
  return link;
}

/**
 * Drop read-time extras from elements about to be saved.
 *
 * Every canvas save is a FULL REPLACE, so whatever sits on an element here is
 * written to the database for good. `resolvedVideoUrl` is derived from the
 * marker on each read and must never round-trip: if it did, the document would
 * be holding a URL again, which is exactly what CV-01 removes.
 *
 * Returns copies and never mutates the live Excalidraw elements — Excalidraw
 * hands out its own array, and writing through it corrupts the scene in place.
 */
export function stripResolvedVideoUrls(elements: readonly any[]): any[] {
  return elements.map((element) => {
    const customData = element?.customData;
    if (!customData || customData.resolvedVideoUrl === undefined) return element;
    const { resolvedVideoUrl: _resolvedVideoUrl, ...rest } = customData;
    return { ...element, customData: rest };
  });
}

/**
 * Check if a URL points to a video file based on extension or customData hint.
 * Used by canvas-editor (renderEmbeddable) and canvas-tool-menu (selection detection).
 */
export function isVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    // Strip query params/hash for extension check
    const pathname = new URL(url, "https://placeholder").pathname.toLowerCase();
    return VIDEO_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    // Fallback: raw string check
    const lower = url.toLowerCase();
    return VIDEO_EXTENSIONS.some((ext) => lower.includes(ext));
  }
}

/**
 * Scale dimensions to fit within maxSize while preserving aspect ratio.
 */
export function scaleToFit(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  if (width <= maxSize && height <= maxSize) {
    return { width, height };
  }
  const ratio = Math.min(maxSize / width, maxSize / height);
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}

/**
 * Compute the center of the current Excalidraw viewport.
 */
export function getViewportCenter(appState: {
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  zoom: { value: number };
}): { x: number; y: number } {
  const zoom = appState.zoom?.value ?? 1;
  return {
    x: -appState.scrollX + appState.width / (2 * zoom),
    y: -appState.scrollY + appState.height / (2 * zoom),
  };
}

/**
 * Create an Excalidraw image element with all required fields.
 */
export function createExcalidrawImageElement(opts: {
  fileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title?: string;
  source?: "generated" | "uploaded";
  storageUrl?: string;
}): Record<string, unknown> {
  const element: Record<string, unknown> = {
    type: "image",
    id: generateId(),
    x: opts.x,
    y: opts.y,
    width: opts.width,
    height: opts.height,
    angle: 0,
    fileId: opts.fileId,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: null,
    boundElements: null,
    frameId: null,
    index: null,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: false,
    status: "saved",
    scale: [1, 1],
    crop: null,
  };
  if (opts.title || opts.source || opts.storageUrl) {
    element.customData = {
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.storageUrl ? { storageUrl: opts.storageUrl } : {}),
    };
  }
  return element;
}

/**
 * Fetch an image URL and convert it to a data URL string.
 * Routes through the server proxy to bypass browser CORS restrictions.
 */
export async function fetchAsDataURL(url: string): Promise<string> {
  const proxyUrl = `${getServerBaseUrl()}/api/proxy-image?url=${encodeURIComponent(url)}`;

  const response = await fetch(proxyUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(new Error("Failed to convert image to data URL"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Insert an image artifact onto the Excalidraw canvas.
 *
 * X-52 (工单14 fixup3): an artifact may legally carry `assetId` / `objectPath`
 * and still have NO `url` — that is what a stored artifact whose signature could
 * not be minted for this caller looks like (see the shared schema's
 * `requireIdentityWithoutProjection`). Such an artifact cannot be drawn: the
 * element would be built around `undefined`, `fetchAsDataURL` would request
 * `/api/proxy-image?url=undefined`, and the failure would surface as a broken
 * image instead of the chat's "附件当前不可访问" state.
 *
 * So the URL is checked BEFORE anything else happens. The identity fields are
 * deliberately NOT a fallback: `assetId` is a row id and `objectPath` is a
 * storage key, neither is fetchable, and turning one into a URL is the
 * re-introduction of the derived URL that fixup2 removed.
 */
export async function insertImageOnCanvas(
  api: {
    addFiles: (
      files: { id: any; dataURL: any; mimeType: string; created: number }[],
    ) => void;
    getSceneElements: () => readonly any[];
    getAppState: () => any;
    updateScene: (scene: {
      elements: any[];
      captureUpdate?: string;
    }) => void;
  },
  artifact: ImageArtifact,
): Promise<void> {
  const url = artifact.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      "cannot insert image artifact without a readable URL: the artifact for " +
        "this session has no url projection, so there is nothing to fetch. It " +
        "stays in the chat as an inaccessible attachment until a later session " +
        "read signs it again.",
    );
  }

  const dataURL = await fetchAsDataURL(url);
  const fileId = generateId();

  api.addFiles([
    {
      id: fileId as any,
      dataURL: dataURL as any,
      mimeType: artifact.mimeType,
      created: Date.now(),
    },
  ]);

  let x: number;
  let y: number;
  let width: number;
  let height: number;

  if (artifact.placement) {
    // Agent-controlled placement
    x = artifact.placement.x;
    y = artifact.placement.y;
    width = artifact.placement.width;
    height = artifact.placement.height;
  } else {
    // Smart auto-placement: viewport center if empty, next to elements if not
    const scaled = scaleToFit(artifact.width, artifact.height, 600);
    width = scaled.width;
    height = scaled.height;

    const elements = api.getSceneElements().filter((el: any) => !el.isDeleted);

    if (elements.length === 0) {
      // Empty canvas → viewport center
      const center = getViewportCenter(api.getAppState());
      x = center.x - width / 2;
      y = center.y - height / 2;
    } else {
      // Has elements → place to the right of the rightmost element with gap
      const GAP = 40;
      let maxRight = -Infinity;
      let rightEdgeY = 0;

      for (const el of elements) {
        const elRight = (el.x ?? 0) + (el.width ?? 0);
        if (elRight > maxRight) {
          maxRight = elRight;
          // Vertically align center of new image with center of rightmost element
          rightEdgeY = (el.y ?? 0) + (el.height ?? 0) / 2;
        }
      }

      x = maxRight + GAP;
      y = rightEdgeY - height / 2;
    }
  }

  const element = createExcalidrawImageElement({
    fileId,
    x,
    y,
    width,
    height,
    ...(artifact.title ? { title: artifact.title } : {}),
    source: "generated",
    // Only ever passed once the guard above has proven it is a string: under
    // exactOptionalPropertyTypes an explicit `undefined` is not the same as an
    // absent property, and this one is persisted with the element.
    ...(typeof url === "string" && url.length > 0 ? { storageUrl: url } : {}),
  });

  api.updateScene({
    elements: [...api.getSceneElements(), element],
    captureUpdate: "IMMEDIATELY",
  });
}

/**
 * Insert a video artifact onto the Excalidraw canvas as an embeddable element.
 * Uses Excalidraw's native embeddable type with renderEmbeddable callback for inline playback.
 * No poster frame extraction needed -- the video plays directly on canvas.
 *
 * CV-01: the element is keyed on the artifact's `objectPath`, exactly like a
 * generated image, and the playable URL is attached as `customData.resolvedVideoUrl`
 * for the current session only — `buildSavePayload` strips it before every save.
 *
 * An artifact WITHOUT `objectPath` is REFUSED. The only alternative would be to
 * persist `artifact.url`, and that is the thing this change exists to stop; a
 * silent fallback here would quietly undo it on the one path that is easiest to
 * overlook (this function is the browser's own insertion path, independent of
 * the agent runtime).
 *
 * Only the direct-provider path — reachable in tests alone — can produce such an
 * artifact today, so the refusal costs nothing in production but keeps a
 * URL-backed element from ever being created again.
 *
 * X-52 (工单14 fixup3): the object marker is necessary but no longer sufficient.
 * A stored artifact whose signature could not be minted for this caller carries
 * `objectPath` and NO `url`; inserting it would write `resolvedVideoUrl:
 * undefined` into a live element, which the renderer reads through
 * `getVideoElementSrc` and the player panel through the generator registry. The
 * element is refused here instead, so the video keeps its chat-side
 * "不可访问" state and is inserted again once a session read re-signs it.
 */
export async function insertVideoOnCanvas(
  api: {
    getSceneElements: () => readonly any[];
    getAppState: () => any;
    updateScene: (scene: {
      elements: any[];
      captureUpdate?: string;
    }) => void;
  },
  artifact: VideoArtifact,
): Promise<void> {
  const objectPath = artifact.objectPath;
  if (typeof objectPath !== "string" || objectPath.length === 0) {
    throw new Error(
      "insertVideoOnCanvas: artifact has no objectPath, so it cannot be stored " +
        "as an object marker. Persisting its public URL instead would put a URL " +
        "whose lifetime we do not control into the canvas document (CV-01), so " +
        "the insert is refused.",
    );
  }

  const url = artifact.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      "insertVideoOnCanvas: artifact has no readable URL for this session, so " +
        "it cannot be played. The object marker alone would leave " +
        "resolvedVideoUrl undefined on a live element until the next save " +
        "strips it, so the insert is refused and the attachment stays " +
        "inaccessible in the chat.",
    );
  }

  // Dynamic import — excalidraw is client-only and cannot be imported at module level
  const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");

  let x: number;
  let y: number;
  let width: number;
  let height: number;

  if (artifact.placement) {
    x = artifact.placement.x;
    y = artifact.placement.y;
    width = artifact.placement.width;
    height = artifact.placement.height;
  } else {
    // Use 800px max for video elements (larger than images since video benefits from more screen area)
    const scaled = scaleToFit(artifact.width, artifact.height, 800);
    width = scaled.width;
    height = scaled.height;

    const elements = api.getSceneElements().filter((el: any) => !el.isDeleted);

    if (elements.length === 0) {
      // Empty canvas -- place at viewport center
      const center = getViewportCenter(api.getAppState());
      x = center.x - width / 2;
      y = center.y - height / 2;
    } else {
      // Has elements -- place to the right of the rightmost element with gap
      const GAP = 40;
      let maxRight = -Infinity;
      let rightEdgeY = 0;
      for (const el of elements) {
        const elRight = (el.x ?? 0) + (el.width ?? 0);
        if (elRight > maxRight) {
          maxRight = elRight;
          rightEdgeY = (el.y ?? 0) + (el.height ?? 0) / 2;
        }
      }
      x = maxRight + GAP;
      y = rightEdgeY - height / 2;
    }
  }

  const newElements = convertToExcalidrawElements([
    {
      type: "embeddable",
      // The object marker is what gets persisted; see the guard above.
      link: `${OSS_MARKER_PREFIX}${CANVAS_FILES_BUCKET}/${objectPath}`,
      x,
      y,
      width,
      height,
      customData: {
        isVideo: true,
        mimeType: artifact.mimeType,
        durationSeconds: artifact.durationSeconds,
        title: artifact.title?.slice(0, 60),
        prompt: artifact.title,
        // Read-time only. Stripped by stripResolvedVideoUrls on every save.
        // Never undefined: the guard above proved it is a non-empty string.
        resolvedVideoUrl: url,
      },
    } as any, // ExcalidrawElementSkeleton includes IframeLikeElement but TS needs a nudge
  ]);

  const existing = api.getSceneElements();
  api.updateScene({
    elements: [...existing, ...newElements],
    captureUpdate: "IMMEDIATELY",
  });
}

function generateId(): string {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  ).slice(0, 20);
}

/**
 * Slots the backend reserves while a generation job runs carry
 * `customData.generating === true` (see the server's insertImagePlaceholder).
 * The flag is stripped when the real image is written into the same slot.
 */
export function findGeneratingElements(elements: readonly any[]): any[] {
  return elements.filter(
    (el) => el && !el.isDeleted && el.customData?.generating === true,
  );
}

/**
 * Pan/zoom the viewport onto generation slots the user has not been shown yet.
 *
 * Lovart moves the canvas to wherever it is about to draw, so the user never has
 * to hunt for the new image. We mirror that, but only once per slot: a batch
 * generation fires one canvas.sync per image, and re-focusing on every sync
 * would keep yanking the viewport away from whatever the user is doing.
 *
 * @param seen ids already focused. Mutated in place by this call.
 * @returns whether the viewport was moved.
 */
export function focusGeneratingSlots(
  api: any,
  elements: readonly any[],
  seen: Set<string>,
): boolean {
  if (typeof api?.scrollToContent !== "function") return false;
  const slots = findGeneratingElements(elements);
  if (slots.length === 0) return false;
  // Every slot has already been revealed — leave the viewport alone.
  if (slots.every((el) => seen.has(String(el.id)))) return false;
  for (const el of slots) seen.add(String(el.id));

  api.scrollToContent(slots, {
    fitToViewport: true,
    // Leave breathing room so neighbouring images stay in frame; a full-bleed
    // fit turns the canvas into a single-image viewer.
    viewportZoomFactor: 0.6,
    // Never zoom past 1:1 — a small slot would otherwise fill the screen.
    maxZoom: 1,
    animate: true,
    duration: 450,
  });
  return true;
}
