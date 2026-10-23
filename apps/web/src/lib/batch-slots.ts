import { buildImageGeneratorElement, type ImageGeneratorData } from "./canvas-image-generator";

type Bounds = { x: number; y: number; width: number; height: number };

/** AG-07: at most this many slots (the source slot included) per row. */
const SLOTS_PER_ROW = 5;

/**
 * AG-07: where the `count - 1` extra placeholders go. The source slot is slot 0;
 * the extras continue to its right, five slots per row (source included), then
 * wrap to the next row starting at the source's x.
 */
export function batchSlotBounds(source: Bounds, count: number, gap = 24): Bounds[] {
  const bounds: Bounds[] = [];
  for (let i = 1; i < count; i++) {
    const column = i % SLOTS_PER_ROW;
    const row = Math.floor(i / SLOTS_PER_ROW);
    bounds.push({
      x: source.x + column * (source.width + gap),
      y: source.y + row * (source.height + gap),
      width: source.width,
      height: source.height,
    });
  }
  return bounds;
}

/**
 * AG-07: draws `count - 1` extra "generating" placeholders next to the source slot
 * in one scene update and returns their ids in position order.
 */
export function addBatchPlaceholders(api: any, sourceId: string, count: number): string[] {
  if (count <= 1) return [];
  const elements: readonly any[] = api.getSceneElements();
  const source = elements.find((el: any) => el.id === sourceId);
  if (!source) return [];

  const customData = (source.customData ?? {}) as ImageGeneratorData;
  const slots = batchSlotBounds(
    { x: source.x, y: source.y, width: source.width, height: source.height },
    count,
  );
  const created = slots.map((slot) =>
    buildImageGeneratorElement(slot, { ...customData, status: "generating" }),
  );
  api.updateScene({
    elements: [...elements, ...created],
    captureUpdate: "IMMEDIATELY",
  });
  return created.map((el) => el.id as string);
}
