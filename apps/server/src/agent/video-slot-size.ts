/**
 * CV-02 / GN-02: the size of the canvas slot reserved while an agent video job
 * is still running.
 *
 * The slot used to be a fixed 640x360 box whenever the caller gave no explicit
 * placement, so a portrait ("9:16") request reserved a landscape frame and the
 * canvas jumped when the finished video finally landed in it. The slot now
 * follows the requested aspect ratio: the LONG edge stays 640 (so the default
 * "16:9" request keeps the historical 640x360) and the short edge is derived
 * from the ratio.
 */

/** The long edge of a video placeholder slot, in canvas pixels. */
const VIDEO_SLOT_LONG_EDGE = 640;

/** The ratio used when the request carries no usable one. */
const DEFAULT_PARTS = { widthPart: 16, heightPart: 9 } as const;

/**
 * Parses a "w:h" ratio into two positive numbers, or returns null when the
 * string is not readable that way.
 *
 * This exists because the shared `aspectRatioToDimensions` helper falls back to
 * a SQUARE for unreadable input, which is the wrong default for a video slot.
 */
function parseAspectRatio(
  aspectRatio: string,
): { widthPart: number; heightPart: number } | null {
  const parts = aspectRatio.split(":");
  if (parts.length !== 2) return null;
  const widthPart = Number(parts[0]);
  const heightPart = Number(parts[1]);
  if (!Number.isFinite(widthPart) || !Number.isFinite(heightPart)) return null;
  if (widthPart <= 0 || heightPart <= 0) return null;
  return { widthPart, heightPart };
}

/**
 * The width/height, in canvas pixels, of the placeholder reserved for a video
 * job that asked for `aspectRatio` (e.g. "9:16").
 *
 * An omitted or unreadable ratio falls back to "16:9", i.e. 640x360.
 */
export function videoSlotSize(aspectRatio?: string): {
  width: number;
  height: number;
} {
  const parsed =
    aspectRatio === undefined
      ? null
      : parseAspectRatio(aspectRatio);
  const { widthPart, heightPart } = parsed ?? DEFAULT_PARTS;

  if (widthPart >= heightPart) {
    return {
      width: VIDEO_SLOT_LONG_EDGE,
      height: Math.round((VIDEO_SLOT_LONG_EDGE * heightPart) / widthPart),
    };
  }
  return {
    width: Math.round((VIDEO_SLOT_LONG_EDGE * widthPart) / heightPart),
    height: VIDEO_SLOT_LONG_EDGE,
  };
}
