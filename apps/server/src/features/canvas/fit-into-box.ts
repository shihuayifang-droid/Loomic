/**
 * GN-02 (5): place content of its REAL size inside a requested box.
 *
 * WHY THIS EXISTS
 * When an Agent says "put the video at x/y", the box it names comes from the
 * *request* — 640x360 unless it says otherwise. Upstream providers snap that
 * request to one of their own shapes, so a 9:16 video regularly comes back for
 * a 16:9 box. Assigning the box's width/height to the element stretches the
 * video; this helper fits it instead.
 *
 * Same behaviour as the web side `lib/fit-result.ts` `fitResultIntoSlot`
 * (36X): contain, centred, never stretched. Values are not rounded — an element
 * takes floats, and rounding here would reintroduce a fractional aspect error at
 * small sizes.
 */

export type Box = { x: number; y: number; width: number; height: number };

/** GN-02 (5): place content of its REAL size inside a requested box — contain, centred, never stretched. Unknown size → the box as-is. */
export function fitIntoBox(
  box: Box,
  size: { width?: number | null; height?: number | null },
): Box {
  const width = size?.width;
  const height = size?.height;

  // Missing, zero or negative: we cannot know the real shape, so assume the box
  // is right. Guessing a ratio here would be worse than not fitting at all.
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return box;
  }

  const scale = Math.min(box.width / width, box.height / height);
  const placedWidth = width * scale;
  const placedHeight = height * scale;

  return {
    x: box.x + (box.width - placedWidth) / 2,
    y: box.y + (box.height - placedHeight) / 2,
    width: placedWidth,
    height: placedHeight,
  };
}
