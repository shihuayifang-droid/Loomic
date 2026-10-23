/**
 * AG-07 / 41E — 首尾帧模式：从画布当前选中的图片里取「首帧 / 尾帧」。
 *
 * 纯函数，不碰 DOM：面板点「首尾帧」时把 `excalidrawApi` 传进来，这里只读
 * `getAppState().selectedElementIds` / `getSceneElements()` / `getFiles()`。
 *
 * 顺序口径：**键顺序 = 选中先后**（Excalidraw 按选中顺序插入 `selectedElementIds`
 * 的键），所以第一个键是首帧、第二个是尾帧 —— 与需求 AG-07「选中顺序 = 首、尾」
 * 一致。只认有 `files[fileId].dataURL` 的 `type === "image"` 元素；不足两张返回
 * `null`（不猜、不重复用同一张图凑数）。
 */

/** 面板只需要的那几个 Excalidraw API 方法（都可缺省，缺省按「没有选中任何东西」处理）。 */
export type FrameSelectionApi = {
  getAppState?: () => { selectedElementIds?: Record<string, boolean> };
  getSceneElements?: () => readonly any[];
  getFiles?: () => Record<string, { dataURL?: string } | undefined>;
};

export type PickedFrames = { first: string; last: string };

export function pickFramesFromSelection(
  api: FrameSelectionApi,
): PickedFrames | null {
  const selected = api.getAppState?.()?.selectedElementIds ?? {};
  const elements = api.getSceneElements?.() ?? [];
  const files = api.getFiles?.() ?? {};

  const byId = new Map<string, any>();
  for (const element of elements) {
    if (element && typeof element.id === "string") byId.set(element.id, element);
  }

  // `Object.keys` 保留插入顺序：先选中的键排在前面。
  const picked: string[] = [];
  for (const id of Object.keys(selected)) {
    if (selected[id] !== true) continue;
    const element = byId.get(id);
    if (!element || element.type !== "image") continue;
    const fileId = element.fileId;
    const dataURL =
      typeof fileId === "string" ? files[fileId]?.dataURL : undefined;
    if (typeof dataURL !== "string" || dataURL === "") continue;
    picked.push(dataURL);
    if (picked.length === 2) break;
  }

  if (picked.length < 2) return null;
  return { first: picked[0] as string, last: picked[1] as string };
}
