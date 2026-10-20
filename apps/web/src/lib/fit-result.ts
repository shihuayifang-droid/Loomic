/**
 * GN-02 (5): place the result at its REAL aspect ratio inside the slot.
 *
 * WHY THIS EXISTS
 * The slot is drawn from the ratio the *request* asked for. Upstream providers
 * snap that request to one of their own sizes (kwjm only produces 1024x1024,
 * 1536x1024 or 1024x1536), so the picture that comes back is regularly a
 * different shape than the box waiting for it. Stretching the picture into the
 * box deforms it; this helper fits it instead.
 *
 * Contain, centred: the whole result is always visible, and the leftover of the
 * slot stays empty rather than the picture being cropped. Values are not
 * rounded — an image element takes floats, and rounding here would reintroduce a
 * fractional aspect error at small sizes.
 */

export type Box = { x: number; y: number; width: number; height: number };

/** GN-02 (5): place the result at its REAL aspect ratio inside the slot — fit (contain), centred, never stretched. Unknown size → the slot as-is. */
export function fitResultIntoSlot(
  slot: Box,
  result: { width?: number; height?: number },
): Box {
  const width = result?.width;
  const height = result?.height;

  // Missing, zero or negative: we cannot know the real shape, so assume the slot
  // is right. Guessing a ratio here would be worse than not fitting at all.
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return slot;
  }

  const scale = Math.min(slot.width / width, slot.height / height);
  const placedWidth = width * scale;
  const placedHeight = height * scale;

  return {
    x: slot.x + (slot.width - placedWidth) / 2,
    y: slot.y + (slot.height - placedHeight) / 2,
    width: placedWidth,
    height: placedHeight,
  };
}
