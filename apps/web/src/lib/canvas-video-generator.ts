import { getViewportCenter } from "./canvas-elements";

// Aspect ratio to pixel dimensions mapping (video ratios only)
const RATIO_DIMENSIONS: Record<string, { w: number; h: number }> = {
  "16:9": { w: 1024, h: 576 },
  "9:16": { w: 576, h: 1024 },
};

export type VideoGeneratorStatus = "idle" | "generating" | "completed" | "error";

export type VideoGeneratorData = {
  type: "video-generator";
  status: VideoGeneratorStatus;
  prompt: string;
  model: string;
  aspectRatio: string;
  duration: number;
  resolution: string;
  inputImages?: string[];
  errorMessage?: string;
};

function generateId(): string {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  ).slice(0, 20);
}

/**
 * Get display dimensions for a video aspect ratio, scaled to fit nicely on canvas.
 * Canvas display size is smaller than actual generation size.
 */
export function getDisplayDimensions(
  aspectRatio: string,
  displayMaxSize = 400,
): { width: number; height: number } {
  const dims = RATIO_DIMENSIONS[aspectRatio] ?? RATIO_DIMENSIONS["16:9"]!;
  const scale = Math.min(displayMaxSize / dims.w, displayMaxSize / dims.h);
  return {
    width: Math.round(dims.w * scale),
    height: Math.round(dims.h * scale),
  };
}

/**
 * Build the Excalidraw rectangle skeleton for a video generator placeholder at a
 * given position. Exported so callers that already know where the element belongs
 * (GN-19 retry reuses the failed slot's own x/y/width/height) do not have to copy
 * the shape; `createVideoGeneratorElement` is the viewport-centred wrapper.
 */
export function buildVideoGeneratorElement(
  position: { x: number; y: number; width: number; height: number },
  data: VideoGeneratorData,
): Record<string, unknown> {
  const { x, y, width, height } = position;
  return {
    type: "rectangle",
    id: generateId(),
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#93C5FD",
    backgroundColor: "#EFF6FF",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: { type: 3 },
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
    customData: data,
  };
}

/**
 * Create an Excalidraw rectangle element that serves as a video generator placeholder.
 */
export function createVideoGeneratorElement(
  api: {
    getAppState: () => any;
    getSceneElements: () => readonly any[];
    updateScene: (scene: { elements: any[]; captureUpdate?: string }) => void;
  },
  options?: {
    aspectRatio?: string;
    model?: string;
    duration?: number;
    resolution?: string;
  },
): string {
  const aspectRatio = options?.aspectRatio ?? "16:9";
  const { width, height } = getDisplayDimensions(aspectRatio);
  const center = getViewportCenter(api.getAppState());

  const customData: VideoGeneratorData = {
    type: "video-generator",
    status: "idle",
    prompt: "",
    model: options?.model ?? "google-official/veo-3.1-generate-preview",
    aspectRatio,
    duration: options?.duration ?? 5,
    resolution: options?.resolution ?? "720p",
  };

  const element = buildVideoGeneratorElement(
    {
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
    },
    customData,
  );
  const id = element.id as string;

  api.updateScene({
    elements: [...api.getSceneElements(), element],
    captureUpdate: "IMMEDIATELY",
  });

  return id;
}

/**
 * GN-19: the video generator that replaces a failed slot on "retry". Null when the slot cannot be retried.
 */
export function retryVideoGeneratorFromFailedSlot(slot: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  customData?: unknown;
}): {
  x: number;
  y: number;
  width: number;
  height: number;
  data: VideoGeneratorData;
} | null {
  const customData = slot?.customData as Record<string, any> | undefined;
  if (customData?.failed !== true) return null;

  const retry = customData.retryRequest as Record<string, any> | undefined;
  if (retry?.kind !== "video") return null;

  const prompt = typeof retry.prompt === "string" ? retry.prompt : "";
  const model = typeof retry.model === "string" ? retry.model : "";
  if (prompt.trim() === "" || model.trim() === "") return null;

  return {
    x: slot.x ?? 0,
    y: slot.y ?? 0,
    width: slot.width ?? 0,
    height: slot.height ?? 0,
    data: {
      type: "video-generator",
      status: "idle",
      prompt,
      model,
      aspectRatio: retry.aspectRatio ?? "16:9",
      duration: retry.duration ?? 5,
      resolution: retry.resolution ?? "720p",
    },
  };
}

/**
 * Check if an Excalidraw element is a video-generator placeholder.
 */
export function isVideoGeneratorElement(element: any): element is { customData: VideoGeneratorData } & Record<string, unknown> {
  return element?.customData?.type === "video-generator";
}

/**
 * Get the video-generator data from an element, or null if not a video-generator.
 */
export function getVideoGeneratorData(element: any): VideoGeneratorData | null {
  if (!isVideoGeneratorElement(element)) return null;
  return element.customData as VideoGeneratorData;
}

/**
 * Update the customData of a video-generator element.
 */
export function updateVideoGeneratorElement(
  api: {
    getSceneElements: () => readonly any[];
    updateScene: (scene: { elements: any[]; captureUpdate?: string }) => void;
  },
  elementId: string,
  updates: Partial<VideoGeneratorData>,
): void {
  const elements = api.getSceneElements().map((el: any) => {
    if (el.id !== elementId || !isVideoGeneratorElement(el)) return el;
    return {
      ...el,
      customData: { ...el.customData, ...updates },
      version: ((el.version as number | undefined) ?? 1) + 1,
      versionNonce: Math.floor(Math.random() * 2_000_000_000),
      updated: Date.now(),
    };
  });
  api.updateScene({ elements, captureUpdate: "IMMEDIATELY" });
}

/**
 * Resize a video-generator element when aspect ratio changes.
 */
export function resizeVideoGeneratorElement(
  api: {
    getSceneElements: () => readonly any[];
    updateScene: (scene: { elements: any[]; captureUpdate?: string }) => void;
  },
  elementId: string,
  aspectRatio: string,
): void {
  const { width, height } = getDisplayDimensions(aspectRatio);
  const elements = api.getSceneElements().map((el: any) => {
    if (el.id !== elementId) return el;
    // Keep center position, adjust size
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    return {
      ...el,
      x: cx - width / 2,
      y: cy - height / 2,
      width,
      height,
      customData: { ...el.customData, aspectRatio },
      version: (el.version ?? 1) + 1,
      versionNonce: Math.floor(Math.random() * 2_000_000_000),
      updated: Date.now(),
    };
  });
  api.updateScene({ elements, captureUpdate: "IMMEDIATELY" });
}

/**
 * Delete a video-generator element from the canvas (soft delete).
 */
export function deleteVideoGeneratorElement(
  api: {
    getSceneElements: () => readonly any[];
    updateScene: (scene: { elements: any[]; captureUpdate?: string }) => void;
  },
  elementId: string,
): void {
  const elements = api.getSceneElements().map((el: any) => {
    if (el.id !== elementId) return el;
    return { ...el, isDeleted: true };
  });
  api.updateScene({ elements, captureUpdate: "IMMEDIATELY" });
}
