// apps/server/src/features/canvas/canvas-element-writer.ts
//
// Every writer here goes through mutateCanvasContent. Do NOT add a bare
// select-then-update: that is the pattern that silently erased generated images
// (see canvas-version.ts for the full account).

import type { CanvasContent } from "@loomic/shared";

import { mutateCanvasContent } from "./canvas-version.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CanvasElement = Record<string, unknown>;

type ImageInsertOpts = {
  canvasId: string;
  objectPath: string;       // Storage path for oss:// marker (already uploaded by worker)
  width: number;
  height: number;
  mimeType: string;
  title?: string;
  /**
   * When set, fill in this existing placeholder element (see
   * insertImagePlaceholder) instead of appending a new one. Keeps the slot's
   * position stable so the image does not jump when generation finishes.
   */
  replaceElementId?: string;
};

type PlaceholderInsertOpts = {
  canvasId: string;
  /** Intended output size, used only to reserve a correctly-proportioned slot. */
  width: number;
  height: number;
  title?: string;
  /** Drives which icon and label the slot shows. Defaults to "image". */
  kind?: "image" | "video";
  /** Shown under the label, matching the chat sidebar's card. */
  modelName?: string;
};

type VideoInsertOpts = {
  canvasId: string;
  /**
   * Storage path of the already-uploaded video, e.g. `<userId>/<jobId>.mp4`.
   *
   * LOCAL FORK (CV-01): this used to be the provider's public URL, and that URL
   * was written straight into `link`. That made every canvas video depend on the
   * bucket staying public — flipping it private (X-52) would have broken every
   * existing video at once, with no way back, since the URL was the only record
   * of where the object lived. The object key is the durable half, so it is what
   * gets persisted.
   */
  objectPath: string;
  width: number;
  height: number;
  mimeType: string;
  durationSeconds?: number;
  title?: string;
  prompt?: string;
};

type Placement = { x: number; y: number; width: number; height: number };

type InsertResult = { elementId: string };

// ---------------------------------------------------------------------------
// Placement calculation (ported from apps/web/src/lib/canvas-elements.ts)
// ---------------------------------------------------------------------------

function scaleToFit(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  if (width <= maxSize && height <= maxSize) return { width, height };
  const ratio = Math.min(maxSize / width, maxSize / height);
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

function calculateAutoPlacement(
  elements: CanvasElement[],
  assetWidth: number,
  assetHeight: number,
  maxSize: number,
): Placement {
  const scaled = scaleToFit(assetWidth, assetHeight, maxSize);
  const visible = elements.filter((el) => !el.isDeleted);

  if (visible.length === 0) {
    // Empty canvas: center around origin
    return {
      x: -scaled.width / 2,
      y: -scaled.height / 2,
      width: scaled.width,
      height: scaled.height,
    };
  }

  // Place right of the rightmost element with 40px gap
  const GAP = 40;
  let maxRight = -Infinity;
  let rightEdgeY = 0;
  for (const el of visible) {
    const elRight = (Number(el.x) || 0) + (Number(el.width) || 0);
    if (elRight > maxRight) {
      maxRight = elRight;
      rightEdgeY = (Number(el.y) || 0) + (Number(el.height) || 0) / 2;
    }
  }
  return {
    x: maxRight + GAP,
    y: rightEdgeY - scaled.height / 2,
    width: scaled.width,
    height: scaled.height,
  };
}

// ---------------------------------------------------------------------------
// Element builders
// ---------------------------------------------------------------------------

function generateId(): string {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  ).slice(0, 20);
}

function buildImageElement(
  fileId: string,
  placement: Placement,
  opts: { title?: string },
  elementId: string = generateId(),
): CanvasElement {
  return {
    type: "image",
    id: elementId,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
    fileId,
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
    customData: {
      ...(opts.title ? { title: opts.title } : {}),
      source: "generated" as const,
    },
  };
}

/**
 * Link stored on a generation slot. Never navigated to — the frontend matches on
 * `customData.generating` and renders its own component instead (see
 * canvas-editor's renderEmbeddable). The scheme just makes the intent obvious
 * if anyone inspects the canvas document.
 */
export const GENERATING_SLOT_LINK = "loomic://generating";

/**
 * The slot shown while a generation runs.
 *
 * Built as an `embeddable`, not an `image`, so the frontend can render a live
 * React component into it — the same shimmer the chat sidebar shows for the same
 * job. The previous version baked a static SVG into an image element, which by
 * construction could not animate and looked nothing like the chat.
 *
 * Carrying no `fileId` also sidesteps a trap: Excalidraw's addFiles() ignores an
 * id the scene already knows, so a slot backed by a file could not be updated in
 * place on a running page.
 */
function buildGeneratingSlotElement(
  placement: Placement,
  opts: { title?: string; kind?: "image" | "video"; modelName?: string },
): CanvasElement {
  return {
    type: "embeddable",
    id: generateId(),
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
    strokeColor: "transparent",
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
    link: GENERATING_SLOT_LINK,
    // Deliberately NOT locked. The slot is a normal canvas citizen: the user can
    // select it, move it out of the way, or group it while the job runs, and the
    // image lands wherever the slot ended up. Locking it only took that away.
    locked: false,
    customData: {
      generating: true,
      kind: opts.kind ?? "image",
      // Wall-clock start, so the elapsed counter survives a page reload. Without
      // it the frontend can only measure from component mount, which restarts at
      // zero whenever the canvas is reopened mid-generation.
      startedAt: Date.now(),
      ...(opts.modelName ? { modelName: opts.modelName } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      source: "generated" as const,
    },
  };
}

function buildVideoElement(
  placement: Placement,
  opts: VideoInsertOpts,
): CanvasElement {
  return {
    type: "embeddable",
    id: generateId(),
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
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
    link: `${OSS_MARKER_PREFIX}${CANVAS_FILES_BUCKET}/${opts.objectPath}`,
    locked: false,
    customData: {
      isVideo: true,
      mimeType: opts.mimeType,
      ...(opts.durationSeconds != null ? { durationSeconds: opts.durationSeconds } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API — Read-Modify-Write canvas content
// ---------------------------------------------------------------------------

export const CANVAS_FILES_BUCKET = "project-assets";

/**
 * Marker stored in the canvas `files` map in place of a base64 dataURL.
 * Format: `oss://<bucket>/<objectPath>`.
 *
 * canvas-service.ts writes these on save (extractFilesToStorage) and resolves
 * them back into base64 on load (resolveFilesFromStorage), so anything that
 * writes the canvas directly must use the same marker.
 */
export const OSS_MARKER_PREFIX = "oss://";
const IMAGE_MAX_SIZE = 600;

const VIDEO_MAX_SIZE = 800;

/**
 * Insert an image element into a canvas. Reads current content, appends element
 * with auto-placement (or explicit placement), writes it back.
 *
 * The image file is already in Supabase Storage (uploaded by worker executor),
 * so the files map only stores an `oss://` marker pointing at it.
 *
 * LOCAL FORK: upstream downloaded the object back out of Storage, base64'd it,
 * and wrote the result into canvases.content. That made a single UPDATE carry
 * multiple MB of JSONB (one 1024x1024 PNG measured 7 MB), which reliably hit
 * Postgres statement_timeout — so the placeholder element never got inserted
 * and the canvas showed no "generating" state at all. It was also pure
 * round-tripping: saveCanvasContent's extractFilesToStorage would have pushed
 * the very same bytes straight back into Storage on the next save.
 * resolveFilesFromStorage turns the marker back into a dataURL when the client
 * loads the canvas, so Excalidraw rendering is unaffected.
 */
/**
 * Reserve a visible slot on the canvas before generation starts.
 *
 * The slot is an embeddable the frontend renders as the shared generation
 * shimmer, so the canvas and the chat sidebar show the same thing for the same
 * job. When the job finishes, insertImageElement({ replaceElementId }) swaps the
 * slot for a real image element at the same position.
 *
 * LOCAL FORK: upstream inserted nothing until the job succeeded, so the canvas
 * stayed blank for the whole 30-90s generation with no sign anything was
 * happening.
 */
export async function insertImagePlaceholder(
  client: { from: (table: string) => any },
  opts: PlaceholderInsertOpts,
  explicitPlacement?: Placement,
): Promise<InsertResult> {
  // The element id has to be stable across retries: the caller stores it and
  // later fills this exact slot, so it cannot be regenerated per attempt.
  let element: CanvasElement | undefined;

  const written = await mutateCanvasContent(
    client,
    opts.canvasId,
    (content) => {
      const elements: CanvasElement[] = (content.elements as CanvasElement[]) ?? [];
      const files =
        ((content as any).files as Record<string, Record<string, unknown>>) ?? {};

      // Placement is recomputed on each attempt on purpose: if another element
      // landed meanwhile, the auto-placement should avoid overlapping it.
      const placement =
        explicitPlacement ??
        calculateAutoPlacement(elements, opts.width, opts.height, IMAGE_MAX_SIZE);

      // No files entry: the slot carries no raster data at all now.
      const built = buildGeneratingSlotElement(placement, {
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.modelName ? { modelName: opts.modelName } : {}),
      });
      element = element
        ? { ...built, id: element.id }
        : built;

      return {
        ...content,
        elements: [...elements, element],
        files,
      } as CanvasContent;
    },
    { label: "insertImagePlaceholder" },
  );

  if (!written || !element) {
    throw new Error(`Failed to reserve canvas slot: ${opts.canvasId}`);
  }

  console.log(
    `[canvas-element-writer] placeholder inserted canvasId=${opts.canvasId} ` +
      `elementId=${element.id} version=${written.version}`,
  );
  return { elementId: element.id as string };
}

/**
 * Drop a placeholder that will never be filled (generation failed or was
 * canceled), so the canvas is not left with a permanently empty frame.
 */
export async function removeCanvasElement(
  client: { from: (table: string) => any },
  canvasId: string,
  elementId: string,
): Promise<void> {
  try {
    await mutateCanvasContent(
      client,
      canvasId,
      (content) => {
        const elements: CanvasElement[] = (content.elements as CanvasElement[]) ?? [];
        const remaining = elements.filter((el) => el.id !== elementId);
        // Already gone — return null so no write is issued at all.
        if (remaining.length === elements.length) return null;
        return { ...content, elements: remaining } as CanvasContent;
      },
      { label: "removeCanvasElement" },
    );
  } catch (err) {
    // Kept non-throwing, as before: this only tidies up a placeholder whose
    // generation already failed, and the caller is in an error path. But it must
    // not be silent, or a stuck placeholder has no explanation.
    console.log(
      `[canvas-element-writer] removeCanvasElement gave up canvasId=${canvasId} ` +
        `elementId=${elementId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function insertImageElement(
  client: { from: (table: string) => any; storage: { from: (bucket: string) => any } },
  opts: ImageInsertOpts,
  explicitPlacement?: Placement,
): Promise<InsertResult> {
  // 1. Reference the object already in Storage — no download, no base64.
  const dataURL = `${OSS_MARKER_PREFIX}${CANVAS_FILES_BUCKET}/${opts.objectPath}`;

  // 2-5. Read, transform and write under optimistic concurrency. Everything
  // below runs again from freshly read content if someone else wrote in between,
  // which is what keeps a concurrent full save from erasing this image.
  let resultElementId = "";
  let filledPlaceholder = false;

  const written = await mutateCanvasContent(
    client,
    opts.canvasId,
    (content) => {
  const elements: CanvasElement[] = (content.elements as CanvasElement[]) ?? [];
  const files = ((content as any).files as Record<string, Record<string, unknown>>) ?? {};

  // 3/4. Either fill in the reserved placeholder, or append a fresh element.
  let updatedElements: CanvasElement[];
  let updatedFiles: Record<string, Record<string, unknown>>;

  const placeholder = opts.replaceElementId
    ? elements.find((el) => el.id === opts.replaceElementId)
    : undefined;
  filledPlaceholder = !!placeholder;

  if (placeholder) {
    // Build a FRESH image element rather than mutating the slot: the slot is an
    // `embeddable`, and flipping an element's type in place is not something
    // Excalidraw expects. Swapping it at the same array index keeps the z-order,
    // and reusing its x/y keeps the image exactly where the user watched it
    // being generated.
    //
    // The new element also gets a brand-new fileId. Excalidraw's addFiles() only
    // fills in MISSING ids — re-adding an id the scene already knows is silently
    // ignored — so a reused id would leave a running page showing stale content,
    // which the next auto-save (a FULL REPLACE) would then write back over the
    // real image.
    const fileId = generateId();
    const scaled = scaleToFit(opts.width, opts.height, IMAGE_MAX_SIZE);
    const element = buildImageElement(
      fileId,
      {
        x: Number(placeholder.x) || 0,
        y: Number(placeholder.y) || 0,
        width: scaled.width,
        height: scaled.height,
      },
      opts,
    );

    updatedElements = elements.map((el) =>
      el.id === opts.replaceElementId ? element : el,
    );
    updatedFiles = {
      ...files,
      [fileId]: {
        id: fileId,
        dataURL,
        mimeType: opts.mimeType,
        created: Date.now(),
      },
    };
    resultElementId = element.id as string;
  } else {
    // No placeholder (or it was removed) — fall back to appending.
    const fileId = generateId();
    const placement = explicitPlacement ?? calculateAutoPlacement(
      elements, opts.width, opts.height, IMAGE_MAX_SIZE,
    );
    const element = buildImageElement(fileId, placement, opts);
    updatedElements = [...elements, element];
    updatedFiles = {
      ...files,
      [fileId]: {
        id: fileId,
        dataURL,
        mimeType: opts.mimeType,
        created: Date.now(),
      },
    };
    resultElementId = element.id as string;
  }

      return {
        ...content,
        elements: updatedElements,
        files: updatedFiles,
      } as CanvasContent;
    },
    { label: "insertImageElement" },
  );

  if (!written) {
    throw new Error(`Failed to write canvas: ${opts.canvasId}`);
  }

  console.log(
    `[canvas-element-writer] image ${filledPlaceholder ? "filled placeholder" : "inserted"} ` +
      `canvasId=${opts.canvasId} elementId=${resultElementId} version=${written.version}`,
  );
  return { elementId: resultElementId };
}

/**
 * Insert a video element into a canvas. Videos use Excalidraw's `embeddable`
 * type, carrying an `oss://` object marker in `link` — no files map entry
 * needed, and no public URL in the persisted document (see VideoInsertOpts).
 *
 * The marker is resolved to a playable URL on read (see canvas-service's
 * resolveVideoElementsFromStorage), so the stored document never pins a URL
 * whose lifetime we do not control.
 */
export async function insertVideoElement(
  client: { from: (table: string) => any; storage: { from: (bucket: string) => any } },
  opts: VideoInsertOpts,
  explicitPlacement?: Placement,
): Promise<InsertResult> {
  // Keep the element id stable across retries, same reason as the placeholder.
  let element: CanvasElement | undefined;

  const written = await mutateCanvasContent(
    client,
    opts.canvasId,
    (content) => {
      const elements: CanvasElement[] = (content.elements as CanvasElement[]) ?? [];

      const placement =
        explicitPlacement ??
        calculateAutoPlacement(elements, opts.width, opts.height, VIDEO_MAX_SIZE);

      const built = buildVideoElement(placement, opts);
      element = element ? { ...built, id: element.id } : built;

      return {
        ...content,
        elements: [...elements, element],
      } as CanvasContent;
    },
    { label: "insertVideoElement" },
  );

  if (!written || !element) {
    throw new Error(`Failed to write canvas: ${opts.canvasId}`);
  }

  console.log(
    `[canvas-element-writer] video inserted canvasId=${opts.canvasId} ` +
      `elementId=${element.id} version=${written.version}`,
  );
  return { elementId: element.id as string };
}
