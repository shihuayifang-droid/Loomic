"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { FlipRotateState } from "@/lib/flip-rotate";
import { drawTransformed, fromElementTransform, toElementTransform, transformedFileName, transformedSize } from "@/lib/flip-rotate";
import type { SelectionItemKind, ToolbarKind } from "@/lib/toolbar-kind";
import { elementKind, resolveToolbar } from "@/lib/toolbar-kind";
import { imageToolbarPosition } from "@/lib/toolbar-position";

import { useToast } from "@/components/toast";
import { useToolDefinitions } from "@/hooks/use-tool-definitions";

import { FlipRotateBar } from "./flip-rotate-bar";
import { ImageToolbar } from "./image-toolbar";

/**
 * ED-00 / ED-00a / ED-03 · 逐图工具条接到画布上（工单 30Q）
 *
 * ## 这个组件负责什么
 *
 * - **跟随**：恰好选中 1 张图片时，在图片上方（放不下就在下方）放一条 `ImageToolbar`，
 *   位置随滚动 / 缩放出 {@link imageToolbarPosition} 算。
 * - **隐藏**：拖动 / 拉伸 / 旋转 / 裁剪进行中，或最近 150ms 内滚动过、缩放过，就**不渲染**
 *   （工单 §3 裁决 4 明令不许用 opacity / hover 显隐 —— 那两种写法过不了 a11y-lint）。
 * - **翻转与旋转**：点 `flip_rotate` 后用 `FlipRotateBar` 在同一位置**替换**主工具条，
 *   改动直接写回元素的 `angle` / `scale`，走 Excalidraw 自己的历史记录（`captureUpdate:
 *   "IMMEDIATELY"`），**不产生新文件**（ED-00i ②）。
 *
 * ## 订阅方式
 *
 * `onSelectionChange` 只在选中 id 集合变化时触发，**不能用来做跟随**（工单 §2），
 * 所以这里跟 `canvas-tool-menu.tsx` 一样用 `excalidrawApi.onChange` 订阅每一帧。
 * 但 `onChange` 在拖动时每帧都触发，所以每帧会算一个「渲染摘要」字符串，
 * 摘要没变就**不 setState** —— 否则拖动一张图会把整条工具条子树重渲几百次。
 *
 * ## 本单不接
 *
 * 调整、裁剪、快捷编辑、下载、「更多」菜单里的各项，以及 ED-00c 询价：除 `flip_rotate`
 * 以外的工具统一弹 toast「该工具即将接入」（工单 §3 裁决 6，见 T-78）。
 *
 * ## 状态放在哪
 *
 * 只放在本组件里（`snapshot` 是最近一帧的渲染摘要，`mode` 是「主工具条 / 二级条」）。
 * `canvas-editor.tsx` 只多挂一行，没有任何新状态。
 */

/** 滚动 / 缩放停止后多久恢复工具条（毫秒）。工单 §3 裁决 4。 */
export const SCROLL_ZOOM_SETTLE_MS = 150;

/** 本单未接的工具点了以后统一弹这句（工单 §1 与 §3 裁决 6 给了原文）。 */
export const TOOL_PENDING_MESSAGE = "该工具即将接入";

/** 拿不到原图时的提示（工单 §3 裁决 5：不抛错，给提示）。 */
export const DOWNLOAD_FAILED_MESSAGE = "原图还没准备好，暂时无法下载";

/** 二级条的入口工具 id（工单 §3 裁决 5）。 */
const FLIP_ROTATE_TOOL_ID = "flip_rotate";

/**
 * `excalidrawApi` 在本仓是 `any`（`canvas-editor.tsx:169`），这里只声明用到的 4 个方法。
 * 方法都可选：真实 API 一定都有，但测试里的假 API 按需给（`test/canvas-bottom-bar-zoom.test.tsx`
 * 的 `makeApi()` 就是这种写法）。
 */
export type ExcalidrawApiLike = {
  onChange?:
    | ((listener: (elements: unknown[], appState: unknown) => void) => () => void)
    | undefined;
  getSceneElements?: (() => readonly unknown[]) | undefined;
  getFiles?: (() => Record<string, ExcalidrawFileLike | undefined>) | undefined;
  updateScene?: ((scene: { elements: unknown[]; captureUpdate: string }) => void) | undefined;
};

/** Excalidraw 的 `files` 里本组件只用到 `dataURL`（原图）和 `mimeType`（推扩展名）。 */
export type ExcalidrawFileLike = {
  dataURL?: string | undefined;
  mimeType?: string | undefined;
};

export type ImageToolbarLayerProps = {
  excalidrawApi: ExcalidrawApiLike;
  accessToken: string | null;
};

/** 最近一帧里与渲染有关的全部信息。 */
type Snapshot = {
  /** 恰好选中 1 张图时的那个元素；其他情况一律 `null`（不显示工具条）。 */
  element: unknown;
  /** `element` 的 id（`element` 为 null 时是 null）。单独存，退出二级条时好比较。 */
  elementId: string | null;
  toolbarKind: ToolbarKind;
  scrollX: number;
  scrollY: number;
  zoom: number;
  viewportWidth: number;
  busy: boolean;
};

/** 「主工具条」或「翻转与旋转的二级条」。二级条记住自己是在改哪个元素。 */
type Mode =
  | { kind: "toolbar" }
  | { kind: "flip-rotate"; elementId: string; state: FlipRotateState };

/** 元素上本文件会读的字段（Excalidraw 元素的结构子集）。 */
type ElementLike = {
  id?: unknown;
  isDeleted?: unknown;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  scale?: [number, number] | undefined;
  fileId?: unknown;
  type?: string;
  customData?: { generating?: unknown; fileName?: unknown } | null;
};

/** 把元素上的 `scale` 收成 `[number, number]`：没有就是 `[1, 1]`（未翻转）。 */
function elementScale(el: ElementLike): [number, number] {
  const scale = el.scale;
  if (!Array.isArray(scale) || scale.length < 2) return [1, 1];
  return [scale[0], scale[1]];
}

/** 选中元素 → 工具条形态。任何一个选中元素映射成 `null` 就不显示（工单 §3 裁决 2）。 */
function toolbarKindOf(selected: readonly ElementLike[]): ToolbarKind {
  const kinds = selected.map((el) => elementKind(el));
  if (kinds.some((kind) => kind === null)) return "none";
  return resolveToolbar(kinds.map((kind) => ({ kind: kind as SelectionItemKind })));
}

/**
 * 渲染摘要。**不含** `elements` 数组本身（每帧都是新数组，含进去就等于每帧都重渲）：
 * 只有「哪张图、它多大、转到哪、滚到哪、缩到哪、是不是在拖」这些影响像素的字段。
 */
function snapshotKey(snapshot: Snapshot): string {
  const el = snapshot.element as ElementLike | null;
  const elementPart =
    el === null
      ? "-"
      : [
          String(el.id ?? ""),
          el.x ?? 0,
          el.y ?? 0,
          el.width ?? 0,
          el.height ?? 0,
          el.angle ?? 0,
          elementScale(el)[0],
          elementScale(el)[1],
          String(el.fileId ?? ""),
        ].join(":");
  return [
    snapshot.toolbarKind,
    elementPart,
    snapshot.scrollX,
    snapshot.scrollY,
    snapshot.zoom,
    snapshot.viewportWidth,
    snapshot.busy ? 1 : 0,
  ].join("|");
}

/** mimeType → 扩展名。只列 Excalidraw 会长传到 canvas 的图片类型。 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * 下载文件名的**基名**（变换后缀由 `transformedFileName` 拼）。
 *
 * Excalidraw 的 `BinaryFileData` 里没有原始文件名，只有 `id` / `dataURL` / `mimeType`，
 * 所以优先用元素上记着的 `customData.fileName`（上传那张单写进去的），
 * 没有就退回 `fileId` + 按 mimeType 推的扩展名。
 */
function downloadBaseName(el: ElementLike, file: ExcalidrawFileLike | undefined): string {
  const fromElement = el.customData?.fileName;
  if (typeof fromElement === "string" && fromElement !== "") return fromElement;
  const extension = MIME_EXTENSIONS[file?.mimeType ?? ""] ?? "png";
  const id = typeof el.fileId === "string" && el.fileId !== "" ? el.fileId : "image";
  return `${id}.${extension}`;
}

/**
 * 把原图按当前翻转 / 旋转画出来并下载（工单 §3 裁决 5）。
 *
 * **这一段在 jsdom 里测不了**（没有真正的 2D 上下文、没有 `toBlob`），所以抽成独立函数：
 * 组件只负责把「原图 dataURL / 基名 / 状态」这三样递进来，浏览器里的效果由用户确认。
 *
 * 只读 `dataURL`、只画 canvas，**不碰 files、不碰 customData** —— ED-00i ②：不产生新文件。
 */
export function downloadTransformed(dataUrl: string, name: string, state: FlipRotateState): void {
  const image = new Image();
  image.onload = () => {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const out = transformedSize(width, height, state.angle);

    const canvas = document.createElement("canvas");
    canvas.width = out.width;
    canvas.height = out.height;

    // 拿不到 2D 上下文（jsdom / 被拒绝）就到此为止，不抛错。
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    drawTransformed(ctx, image, width, height, state);

    canvas.toBlob((blob) => {
      if (blob === null) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = transformedFileName(name, state);
      anchor.click();
      URL.revokeObjectURL(url);
    });
  };
  image.src = dataUrl;
}

export function ImageToolbarLayer({ excalidrawApi, accessToken }: ImageToolbarLayerProps) {
  const { toast } = useToast();
  const definitions = useToolDefinitions(accessToken);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "toolbar" });
  /** 最近 150ms 内滚 / 缩过没有。`true` = 已经停下来，可以显示。 */
  const [scrollZoomSettled, setScrollZoomSettled] = useState(true);
  const [toolbarWidth, setToolbarWidth] = useState(0);

  /** 最近一帧的完整元素数组：写回 `angle` / `scale` 时要拿到**全场景**（不只是选中那个）。 */
  const elementsRef = useRef<unknown[]>([]);
  /** 上一帧的滚动 / 缩放值，用来判断「这一帧是不是刚滚过」。 */
  const motionRef = useRef({ initialized: false, scrollX: 0, scrollY: 0, zoom: 1 });
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotKeyRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleChange = useCallback((elements: unknown[], appState: unknown) => {
    elementsRef.current = Array.isArray(elements) ? elements : [];

    const state = (appState ?? {}) as Record<string, any>;
    const selectedIds = (state["selectedElementIds"] ?? {}) as Record<string, unknown>;
    const selected = (elementsRef.current as ElementLike[]).filter(
      (el) => selectedIds[String(el?.id ?? "")] === true && el.isDeleted !== true,
    );

    const toolbarKind = toolbarKindOf(selected);
    // 只有「恰好 1 张图」这一种形态会长工具条（工单 §3 裁决 2 最后一句）。
    const element =
      toolbarKind === "image" && selected.length === 1 ? (selected[0] ?? null) : null;
    const elementId =
      element !== null && typeof element.id === "string" ? element.id : null;

    const scrollX = typeof state["scrollX"] === "number" ? state["scrollX"] : 0;
    const scrollY = typeof state["scrollY"] === "number" ? state["scrollY"] : 0;
    const zoomValue = state["zoom"]?.value;
    const zoom = typeof zoomValue === "number" ? zoomValue : 1;

    // --- 滚动 / 缩放：一变就隐藏，停 150ms 再恢复（每变一次重新计时） ---
    const motion = motionRef.current;
    const moved =
      motion.initialized &&
      (motion.scrollX !== scrollX || motion.scrollY !== scrollY || motion.zoom !== zoom);
    motion.initialized = true;
    motion.scrollX = scrollX;
    motion.scrollY = scrollY;
    motion.zoom = zoom;
    if (moved) {
      setScrollZoomSettled(false);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        setScrollZoomSettled(true);
      }, SCROLL_ZOOM_SETTLE_MS);
    }

    const next: Snapshot = {
      element,
      elementId,
      toolbarKind,
      scrollX,
      scrollY,
      zoom,
      viewportWidth: typeof state["width"] === "number" ? state["width"] : 0,
      // 拖动 / 拉伸 / 旋转 / 裁剪进行中都不显示（工单 §3 裁决 4）。
      busy: Boolean(
        state["selectedElementsAreBeingDragged"] ||
          state["isResizing"] ||
          state["isRotating"] ||
          state["isCropping"],
      ),
    };

    const key = snapshotKey(next);
    if (key === snapshotKeyRef.current) return;
    snapshotKeyRef.current = key;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    const unsubscribe = excalidrawApi.onChange?.(handleChange);
    return () => {
      unsubscribe?.();
    };
  }, [excalidrawApi, handleChange]);

  // 卸载时把没跑完的隐藏计时器收掉，否则它会 setState 到一个已经卸载的组件上。
  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    },
    [],
  );

  // 二级条只在「选中的还是那一张图」时成立：选中集合一变就退回主工具条（工单 §3 裁决 5）。
  const selectedElementId = snapshot?.elementId ?? null;
  useEffect(() => {
    if (mode.kind !== "flip-rotate") return;
    if (selectedElementId !== mode.elementId) setMode({ kind: "toolbar" });
  }, [mode, selectedElementId]);

  const visible =
    snapshot !== null &&
    !snapshot.busy &&
    scrollZoomSettled &&
    snapshot.toolbarKind === "image" &&
    snapshot.element !== null;

  // 测量工具条宽度（`toolbarWidth` 是定位的入参）。jsdom 里恒为 0，组件必须能处理 0。
  useEffect(() => {
    const node = containerRef.current;
    if (node === null) return;
    const measure = () => {
      const width = node.offsetWidth;
      setToolbarWidth((previous) => (previous === width ? previous : width));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, mode.kind]);

  /** 进入二级条：把元素当前的 `angle` / `scale` 翻成 `FlipRotateState` 当初始状态。 */
  const enterFlipRotate = useCallback(() => {
    const el = snapshot?.element as ElementLike | null | undefined;
    if (!el || typeof el.id !== "string") return;
    setMode({
      kind: "flip-rotate",
      elementId: el.id,
      state: fromElementTransform({ angle: el.angle ?? 0, scale: elementScale(el) }),
    });
  }, [snapshot]);

  /**
   * 二级条改动 → 写回元素属性。
   *
   * **必须用 `newElementWith`**：它会递增 `version` / `versionNonce`，Excalidraw 的历史记录
   * 才不会把这一步当成「没变」而漏掉（工单 §3 裁决 5）。
   *
   * `excalidraw` 是动态 import 的（本仓口径见 `lib/canvas-elements.ts:378`：
   * 包是 client-only，不能在模块顶层 import），所以这个回调是 async 的。
   */
  const handleFlipChange = useCallback(
    async (next: FlipRotateState) => {
      const el = snapshot?.element as ElementLike | null | undefined;
      if (!el || typeof el.id !== "string") return;

      const { newElementWith } = await import("@excalidraw/excalidraw");
      /**
       * 包里的签名是 `<TElement extends ExcalidrawElement>(element, updates, force?)`。
       * 本文件用的是自己声明的 `ElementLike`（工单 §7：不许为了类型去改 canvas-editor），
       * 所以这里只把**调用形状**收窄成实际用到的那两个参数，不做 `any` 铺开。
       */
      const applyTransform = newElementWith as unknown as (
        element: unknown,
        updates: { angle: number; scale: [number, number] },
      ) => unknown;
      const updated = applyTransform(el, toElementTransform(next));

      // 写回要有「整场景」：拿不到场景就别写 —— 写空数组等于把画布清空。
      const scene =
        elementsRef.current.length > 0
          ? elementsRef.current
          : Array.from(excalidrawApi.getSceneElements?.() ?? []);
      if (scene.length === 0) return;

      excalidrawApi.updateScene?.({
        elements: scene.map((item) => {
          const candidate = item as ElementLike;
          return candidate?.id === el.id ? updated : item;
        }),
        captureUpdate: "IMMEDIATELY",
      });

      setMode({ kind: "flip-rotate", elementId: el.id, state: next });
    },
    [snapshot, excalidrawApi],
  );

  const handleDownload = useCallback(
    (state: FlipRotateState) => {
      const el = snapshot?.element as ElementLike | null | undefined;
      if (!el) return;
      const files = excalidrawApi.getFiles?.() ?? {};
      const fileId = typeof el.fileId === "string" ? el.fileId : "";
      const file = fileId === "" ? undefined : files[fileId];
      const dataUrl = file?.dataURL;

      // 拿不到原图就只提示，不抛错（工单 §5 用例 9）。
      if (typeof dataUrl !== "string" || dataUrl === "") {
        toast(DOWNLOAD_FAILED_MESSAGE);
        return;
      }
      downloadTransformed(dataUrl, downloadBaseName(el, file), state);
    },
    [snapshot, excalidrawApi, toast],
  );

  const exitFlipRotate = useCallback(() => setMode({ kind: "toolbar" }), []);

  const handleToolSelect = useCallback(
    (toolId: string) => {
      if (toolId === FLIP_ROTATE_TOOL_ID) {
        enterFlipRotate();
        return;
      }
      // 其余工具本单都不接（工单 §3 裁决 6）。
      toast(TOOL_PENDING_MESSAGE);
    },
    [enterFlipRotate, toast],
  );

  if (
    !visible ||
    snapshot === null ||
    snapshot.element === null
  ) {
    return null;
  }

  const el = snapshot.element as ElementLike;
  const position = imageToolbarPosition({
    el: {
      x: el.x ?? 0,
      y: el.y ?? 0,
      width: el.width ?? 0,
      height: el.height ?? 0,
      angle: el.angle ?? 0,
    },
    scrollX: snapshot.scrollX,
    scrollY: snapshot.scrollY,
    zoom: snapshot.zoom,
    viewportWidth: snapshot.viewportWidth,
    toolbarWidth,
  });

  return (
    <div
      ref={containerRef}
      data-testid="image-toolbar-layer"
      data-state={mode.kind === "flip-rotate" ? "flip-rotate" : "toolbar"}
      data-placement={position.placement}
      className="absolute z-20"
      style={{ left: position.x, top: position.y }}
    >
      {mode.kind === "flip-rotate" ? (
        <FlipRotateBar
          state={mode.state}
          onChange={handleFlipChange}
          onDownload={handleDownload}
          onExit={exitFlipRotate}
        />
      ) : (
        <ImageToolbar tools={definitions.tools} onToolSelect={handleToolSelect} />
      )}
    </div>
  );
}
