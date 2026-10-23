// ED-00i ④: 工具产物落地的「原位替换」公共件。
//
// 为什么是「换 fileId 不换 id」：Excalidraw 的撤销栈存的是元素快照，旧文件仍然留在
// `files` 里，所以一次 `updateScene({ captureUpdate: "IMMEDIATELY" })` 就能让 Ctrl+Z
// 回到原图 —— 只要元素的 `id / x / y / angle` 没动，它占的还是画布上同一个位置。
//
// 这个模块刻意做成纯函数（不碰 scene、不碰 store），画布接线在下一张单。

export type ToolOutputReplacement = {
  fileId: string;
  assetId: string;
  parentAssetId: string;
  /**
   * Provenance tag on `customData.toolSource`。
   *
   * 40T 起放宽成 `tool:<任意工具 id>`：服务端执行类工具（去背景等）也走同一条原位替换，
   * 给每个新工具再改一次这个联合类型没有意义，而前缀仍然保证「这个值是工具产物」。
   */
  source: `tool:${string}`;
  /** A crop changes the pixel size; an adjustment keeps it. Omitted = keep. */
  width?: number;
  height?: number;
};

/** Excalidraw's own collision-breaker for element shape (see its versioning). */
function nextVersionNonce(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * ED-00i ④: swap an image element's file for the tool output IN PLACE — same id,
 * position, size, angle; new fileId; customData records the parent so undo and
 * provenance can find it. Returns the next element list (others by reference).
 */
export function replaceImageInPlace(
  elements: readonly any[],
  elementId: string,
  next: ToolOutputReplacement,
): any[] {
  const index = elements.findIndex((element) => element?.id === elementId);
  // An unknown id or a non-image element must not grow the history stack: hand
  // the caller back the very same array so `setState` sees no change at all.
  if (index === -1) return elements as any[];

  const element = elements[index];
  if (!element || element.type !== "image") return elements as any[];

  const replaced: any = {
    ...element,
    fileId: next.fileId,
    version: (element.version ?? 1) + 1,
    versionNonce: nextVersionNonce(),
    updated: Date.now(),
    customData: {
      ...element.customData,
      toolSource: next.source,
      parentAssetId: next.parentAssetId,
      assetId: next.assetId,
    },
  };
  // Only a crop resizes; `undefined` must not wipe an existing width/height.
  if (next.width !== undefined) replaced.width = next.width;
  if (next.height !== undefined) replaced.height = next.height;

  const output = elements.slice() as any[];
  output[index] = replaced;
  return output;
}
