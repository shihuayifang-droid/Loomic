"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CropRect, Size } from "@/lib/crop-geometry";
import type { FlipRotateState } from "@/lib/flip-rotate";
import { drawTransformed, fromElementTransform, toElementTransform, transformedFileName, transformedSize } from "@/lib/flip-rotate";
import type { SelectionItemKind, ToolbarKind } from "@/lib/toolbar-kind";
import { elementKind, resolveToolbar } from "@/lib/toolbar-kind";
import { placePanel } from "@/lib/panel-placement";
import { elementScreenRect, imageToolbarPosition } from "@/lib/toolbar-position";
import { fetchAsDataURL } from "@/lib/canvas-elements";
import { browserRenderCrop, commitCropOutput } from "@/lib/crop-commit";
import { replaceImageInPlace } from "@/lib/tool-output-replace";
import { createServerToolRunner } from "@/lib/server-tool-run";
import { awaitJobCompletion } from "@/lib/await-job";
import { browserDecode, browserEncode, commitAdjustOutput } from "@/lib/adjust-commit";
import type { AutoAdjustResult } from "@/lib/adjust-auto";
import { autoAdjust } from "@/lib/adjust-auto";
import { ADJUST_PREVIEW_BOX, makePreviewSource } from "@/lib/adjust-preview";
import type { AdjustParams, PixelBuffer } from "@/lib/adjust-render";

import { useToast } from "@/components/toast";
import { useToolDefinitions } from "@/hooks/use-tool-definitions";
import { useToolPrices } from "@/hooks/use-tool-prices";
import {
  downloadAssetsZip,
  getAssetDownloadUrl,
  getAssetUrl,
  runTool,
  uploadToolOutput,
} from "@/lib/server-api";

import { AdjustToolSession } from "./adjust-tool-session";
import { CropToolSession } from "./crop-tool-session";
import { DownloadAllBar } from "./download-all-bar";
import { FlipRotateBar } from "./flip-rotate-bar";
import { ImageToolbar } from "./image-toolbar";
import { SOURCE_DELETED_MESSAGE } from "./tool-panel-host";

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

/** ED-05：多选里一个带 `assetId` 的图片都没有时给的提示（原话见工单 34W 任务 T3）。 */
export const NO_DOWNLOADABLE_MESSAGE = "没有可下载的对象";

/** ED-05：zip 包名里的项目名缺省值（服务端按它拼包名）。 */
const DEFAULT_PROJECT_NAME = "画布";

/** 二级条的入口工具 id（工单 §3 裁决 5）。 */
const FLIP_ROTATE_TOOL_ID = "flip_rotate";

/**
 * ED-05：主工具条的「下载」工具 id。
 *
 * 它下载的是**服务端原图**（ED-00j），不是前端把 dataURL 转出来的那张 —— 所以走服务端
 * 签发的带 `Content-Disposition` 的地址，原格式、原文件名都由服务端决定。
 */
const DOWNLOAD_TOOL_ID = "download";

/** ED-02: the main toolbar crop tool id. */
const CROP_TOOL_ID = "crop";

/** ED-01: the main toolbar adjust tool id. */
const ADJUST_TOOL_ID = "adjust";

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
  /** ED-00i: register a new file (the crop output) with the scene. */
  addFiles?: ((files: any[]) => void) | undefined;
};

/**
 * Excalidraw 的 `files` 里本组件只用到 `dataURL`（原图）、`mimeType`（推扩展名）
 * 和 `assetId`（ED-05：服务端画布读投影带回的文件记录 id，`app/canvas/page.tsx` 已在用）。
 */
export type ExcalidrawFileLike = {
  dataURL?: string | undefined;
  mimeType?: string | undefined;
  assetId?: string | undefined;
  /** Original pixel size, when the file record carries it. */
  width?: number | undefined;
  height?: number | undefined;
};

export type ImageToolbarLayerProps = {
  excalidrawApi: ExcalidrawApiLike;
  accessToken: string | null;
  /**
   * 下载函数，默认 {@link downloadTransformed}。
   * 只有测试会传：模块内的 `downloadTransformed` 用 `vi.spyOn` 截不到，只能从外面注入。
   */
  download?: ((dataUrl: string, name: string, state: FlipRotateState) => void) | undefined;
  /**
   * ED-05：把服务端签发的下载地址交给浏览器打开，默认 {@link openDownloadAnchor}。
   * 同样只给测试注入：jsdom 里 `anchor.click()` 没有可断言的行为。
   */
  openDownload?: ((url: string) => void) | undefined;
  /** ED-05：zip 包名里的项目名，缺省 `"画布"`（服务端按它拼包名）。 */
  projectName?: string | undefined;
  /**
   * ED-05：把 zip 交给浏览器保存，默认 {@link defaultSaveBlob}。
   * 只有测试会传：jsdom 里没有 `URL.createObjectURL`，走默认实现会抛。
   */
  saveBlob?: ((blob: Blob, fileName: string) => void) | undefined;
  /** ED-02: read the original pixel size of a data URL. Test-injectable; default is the browser Image. */
  readImageSize?: ((dataUrl: string) => Promise<Size>) | undefined;
  /** ED-02: render the crop to a PNG Blob. Test-injectable; default is {@link browserRenderCrop}. */
  renderCrop?: ((sourceDataUrl: string, rect: CropRect) => Promise<Blob>) | undefined;
  /** ED-00j: load the original (signed URL) as a data URL. Test-injectable; default is fetchAsDataURL. */
  loadOriginal?: ((url: string) => Promise<string>) | undefined;
  /** ED-01: decode a data URL to pixels. Test-injectable; default is {@link browserDecode}. */
  decodePixels?: ((dataUrl: string) => Promise<PixelBuffer>) | undefined;
  /** ED-01: encode pixels to a PNG Blob. Test-injectable; default is {@link browserEncode}. */
  encodePixels?: ((pixels: PixelBuffer) => Promise<Blob>) | undefined;
  /**
   * ED-00d：测量面板容器的宽高（`placePanel` 的 `panel` 入参）。
   * 默认 {@link defaultMeasurePanel}（`getBoundingClientRect`）；只有测试会传，
   * 因为 jsdom 里量出来恒为 0。
   */
  measurePanel?: ((el: HTMLElement) => { width: number; height: number }) | undefined;
};

/** ED-02 default size reader: load the data URL into an Image and read naturalWidth/Height. */
function defaultReadImageSize(dataUrl: string): Promise<Size> {
  return new Promise<Size>((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      });
    image.onerror = () => reject(new Error("failed to load image"));
    image.src = dataUrl;
  });
}

function newCropFileId(): string {
  return `crop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * ED-00m：每次**真正发出**的服务端工具运行一个去重 id（`client_request_id`）。
 *
 * 单调不撞比密码学强度重要得多；`crypto.randomUUID` 不在时（老浏览器 / jsdom）退回
 * 时间戳 + 随机串，这个值只要求在途的这些请求之间不重复。
 */
function newToolRequestId(): string {
  const source = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const make = source?.randomUUID;
  if (typeof make === "function") return make.call(source);
  return `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** ED-05 的默认「打开下载地址」：造一个带 `download` 的 anchor 直接点。 */
function defaultOpenDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.rel = "noopener";
  anchor.click();
}

/** ED-05 的默认「保存 zip」：objectURL + 带 `download` 的 anchor，点完立刻回收。 */
function defaultSaveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  URL.revokeObjectURL(url);
}

/** ED-00d：默认的面板量法 —— 真实 DOM 里就是 `getBoundingClientRect`（jsdom 量出来是 0）。 */
function defaultMeasurePanel(el: HTMLElement): { width: number; height: number } {
  const rect = el.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

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
  /** ED-00d：视口高度（`appState.height`，与 `viewportWidth` 同一写法）—— 面板夹边要用。 */
  viewportHeight: number;
  busy: boolean;
  /**
   * ED-05：多选「下载全部」时选中元素的**合并外接框**（场景坐标，`angle: 0` ——
   * 各元素可能各自带角度，并起来以后没有单一角度可言）。其他形态一律 `null`。
   */
  downloadAllBox: SelectionBox | null;
};

/** 一组选中元素并起来的外接框（场景坐标）。 */
type SelectionBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 恒为 0：见 `Snapshot.downloadAllBox` 的注释。 */
  angle: number;
};

/** 「主工具条」或「翻转与旋转的二级条」。二级条记住自己是在改哪个元素。 */
type Mode =
  | { kind: "toolbar" }
  | { kind: "flip-rotate"; elementId: string; state: FlipRotateState }
  | {
      kind: "crop";
      elementId: string;
      source: Size;
      sourceDataUrl: string;
      assetId: string;
      fileName: string;
    }
  | {
      kind: "adjust";
      elementId: string;
      sourceDataUrl: string;
      assetId: string;
      fileName: string;
    };

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

/**
 * 把选中的一组元素并成一个外接框；一个都没有（或坐标不是有限数）就是 `null`。
 *
 * 不参与旋转：`imageToolbarPosition` 的入参本来是「一张图 + 它的角度」，多选没有那个角度，
 * 所以并框时按未旋转的 `x` / `y` / `width` / `height` 算，`angle` 给 0。
 */
function selectionBoxOf(selected: readonly ElementLike[]): SelectionBox | null {
  if (selected.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const el of selected) {
    const x = el.x ?? 0;
    const y = el.y ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (el.width ?? 0));
    maxY = Math.max(maxY, y + (el.height ?? 0));
  }
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, angle: 0 };
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
  // ED-05：多选「下载全部」的位置只取决于合并外接框，选中集合换了框就得重算。
  const box = snapshot.downloadAllBox;
  const boxPart = box === null ? "-" : [box.x, box.y, box.width, box.height].join(":");
  return [
    snapshot.toolbarKind,
    elementPart,
    boxPart,
    snapshot.scrollX,
    snapshot.scrollY,
    snapshot.zoom,
    snapshot.viewportWidth,
    snapshot.viewportHeight,
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

export function ImageToolbarLayer({
  excalidrawApi,
  accessToken,
  download,
  openDownload,
  projectName = DEFAULT_PROJECT_NAME,
  saveBlob,
  readImageSize,
  renderCrop,
  loadOriginal,
  decodePixels,
  encodePixels,
  measurePanel,
}: ImageToolbarLayerProps) {
  const { toast } = useToast();
  const definitions = useToolDefinitions(accessToken);
  // ED-00f：「更多」菜单里直接执行类菜单项的标价，一次询价覆盖全部可询价工具。
  const prices = useToolPrices(accessToken, definitions.tools);

  /**
   * ED-07 / ED-00m：服务端执行类工具（`form === "direct"` 且计价）的运行器。
   *
   * `useMemo` 不是优化而是语义：`runOnce` 的「在途去重表」要活过重渲染，否则连点 3 次会发
   * 3 个请求、扣 3 次积分。依赖只有 token 与被注入的原图读取函数。
   */
  const toolRunner = useMemo(
    () =>
      createServerToolRunner({
        run: (toolId, body) => {
          if (accessToken === null || accessToken === "") {
            return Promise.reject(new Error(DOWNLOAD_FAILED_MESSAGE));
          }
          return runTool(accessToken, toolId, body);
        },
        wait: (jobId) => {
          if (accessToken === null || accessToken === "") {
            return Promise.reject(new Error(DOWNLOAD_FAILED_MESSAGE));
          }
          // 本组件没有 ws：等待走 `awaitJobCompletion` 的 REST 轮询兜底。
          return awaitJobCompletion(accessToken, jobId);
        },
        loadAsDataUrl: (url) => (loadOriginal ?? fetchAsDataURL)(url),
        newRequestId: newToolRequestId,
      }),
    [accessToken, loadOriginal],
  );

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "toolbar" });
  /** 最近 150ms 内滚 / 缩过没有。`true` = 已经停下来，可以显示。 */
  const [scrollZoomSettled, setScrollZoomSettled] = useState(true);
  const [toolbarWidth, setToolbarWidth] = useState(0);
  /**
   * ED-00d：裁剪 / 调整面板的实测尺寸（`placePanel` 的 `panel` 入参）。
   * jsdom 里量出来是 `{0, 0}`，组件必须能处理 —— 那时面板按「零尺寸」定位。
   */
  const [panelSize, setPanelSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  /** ED-05：zip 请求进行中（按钮 disabled + 文案「打包中…」）。 */
  const [downloadAllBusy, setDownloadAllBusy] = useState(false);
  /**
   * ED-01 预览：进调整面板时解码一次原图，结果留在这里。
   * 预览小图由它降采样得到，「自动调整」的直方图也复用它，不再解码第二遍。
   * `sourceDataUrl` 用来确认缓存和当前这张图是同一张。
   */
  const [adjustDecode, setAdjustDecode] = useState<{
    sourceDataUrl: string;
    pixels: PixelBuffer;
  } | null>(null);

  /**
   * ED-00d：`handleChange` 是 `[]` 依赖的订阅回调（每帧都要跑，不能因为 `mode` 变了就重订阅），
   * 所以要判断「开着的面板绑的是哪张源图」只能从这里读最新值。
   */
  const modeRef = useRef<Mode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  /** 最近一帧的完整元素数组：写回 `angle` / `scale` 时要拿到**全场景**（不只是选中那个）。 */
  const elementsRef = useRef<unknown[]>([]);
  /** ED-05：最近一帧 `toolbarKind === "download_all"` 时的选中元素（只读快照）。 */
  const downloadAllSelectionRef = useRef<readonly ElementLike[]>([]);
  /** 上一帧的滚动 / 缩放值，用来判断「这一帧是不是刚滚过」。 */
  const motionRef = useRef({ initialized: false, scrollX: 0, scrollY: 0, zoom: 1 });
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotKeyRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  /**
   * ED-00m：正在跑的「元素 id + 工具 id」。`createServerToolRunner` 的在途表保证连点只发**一个**
   * 请求，但每次点击都会在**同一个** Promise 上继续，替换动作必须只做一次 —— 所以这一层再挡一次。
   */
  const activeToolRunsRef = useRef(new Set<string>());

  const handleChange = useCallback((elements: unknown[], appState: unknown) => {
    elementsRef.current = Array.isArray(elements) ? elements : [];

    /**
     * ED-00d：面板绑的是**打开时那张源图的 id**，所以选中集合怎么变都不收面板；
     * 只有那张源图自己没了（不在场景里 / `isDeleted === true`）才收，并且只提示一次。
     * 先改 `modeRef` 再 `setMode`：同一批里接着来的那一帧就不会重复 toast。
     */
    const opened = modeRef.current;
    if (opened.kind === "crop" || opened.kind === "adjust") {
      const source = (elementsRef.current as ElementLike[]).find(
        (element) => element?.id === opened.elementId,
      );
      if (source === undefined || source.isDeleted === true) {
        modeRef.current = { kind: "toolbar" };
        setMode({ kind: "toolbar" });
        toast(SOURCE_DELETED_MESSAGE);
      }
    }

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

    // ED-05：多选「下载全部」时要留住「当时那批选中元素」—— 点击发生在之后某一帧，
    // 而 `snapshot` 只装渲染摘要、不装选择集本身。
    const downloadAllBox = toolbarKind === "download_all" ? selectionBoxOf(selected) : null;
    downloadAllSelectionRef.current = toolbarKind === "download_all" ? selected : [];

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
      viewportHeight: typeof state["height"] === "number" ? state["height"] : 0,
      downloadAllBox,
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
  }, [toast]);

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
  // ED-00d：这一条**只留给 flip-rotate**（它是二级工具条，点画布空白就该退出）；
  // crop / adjust 是**面板**，绑定打开时的源对象，不随选中变化关闭 —— 源图被删的处理在
  // `handleChange` 里，见那里的注释。
  const selectedElementId = snapshot?.elementId ?? null;
  useEffect(() => {
    if (mode.kind !== "flip-rotate") return;
    if (selectedElementId !== mode.elementId) setMode({ kind: "toolbar" });
  }, [mode, selectedElementId]);

  const visibleImage =
    snapshot !== null &&
    !snapshot.busy &&
    scrollZoomSettled &&
    snapshot.toolbarKind === "image" &&
    snapshot.element !== null;

  // ED-05：多选（≥2）时同一位置只放「下载全部」，与单图工具条互斥 —— 两者不会同时可见。
  const visibleDownloadAll =
    snapshot !== null &&
    !snapshot.busy &&
    scrollZoomSettled &&
    snapshot.toolbarKind === "download_all" &&
    snapshot.downloadAllBox !== null;

  const visible = visibleImage || visibleDownloadAll;

  /** ED-00d：裁剪 / 调整是「面板」，位置按「右 → 左 → 下」算；其余形态仍是工具条。 */
  const panelMode = mode.kind === "crop" || mode.kind === "adjust";

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

  // ED-00d：量面板容器尺寸（`placePanel` 的 `panel`），与上面量工具条宽度同一套办法：先量一次，
  // 有 `ResizeObserver` 就跟。jsdom 里量出来是 0（真实尺寸只能浏览器里看）。
  useEffect(() => {
    if (!panelMode) return;
    const node = containerRef.current;
    if (node === null) return;
    const measure = () => {
      const next = (measurePanel ?? defaultMeasurePanel)(node);
      setPanelSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [panelMode, visible, measurePanel]);

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

  const exitFlipRotate = useCallback(() => setMode({ kind: "toolbar" }), []);

  /**
   * ED-05：主工具条的「下载」→ 服务端原图（ED-00j）。
   *
   * **不在前端转 dataURL**（规格原文）：只问服务端要一条带 `Content-Disposition`（原名）的
   * 签名地址，交给浏览器自己下。老对象没有 `assetId`、或还没有 token，就只提示，不回落。
   */
  const handleDownloadOriginal = useCallback(async () => {
    const el = snapshot?.element as ElementLike | null | undefined;
    if (!el) return;
    const files = excalidrawApi.getFiles?.() ?? {};
    const fileId = typeof el.fileId === "string" ? el.fileId : "";
    const file = fileId === "" ? undefined : files[fileId];
    const assetId = file?.assetId;

    if (
      typeof assetId !== "string" ||
      assetId === "" ||
      accessToken === null ||
      accessToken === ""
    ) {
      toast(DOWNLOAD_FAILED_MESSAGE);
      return;
    }

    try {
      const { url } = await getAssetDownloadUrl(accessToken, assetId);
      if (typeof url !== "string" || url === "") {
        toast(DOWNLOAD_FAILED_MESSAGE);
        return;
      }
      (openDownload ?? defaultOpenDownload)(url);
    } catch {
      toast(DOWNLOAD_FAILED_MESSAGE);
    }
  }, [snapshot, excalidrawApi, toast, accessToken, openDownload]);

  /**
   * ED-00j: load the ORIGINAL (signed URL) of a selected image as a data URL, never the canvas
   * display copy. Shared by crop and adjust. Toasts and returns null when it cannot be had.
   */
  const loadOriginalOf = useCallback(
    async (
      el: ElementLike,
    ): Promise<{ assetId: string; original: string; fileName: string } | null> => {
      const files = excalidrawApi.getFiles?.() ?? {};
      const fileId = typeof el.fileId === "string" ? el.fileId : "";
      const file = fileId === "" ? undefined : files[fileId];
      const assetId = file?.assetId;
      if (
        typeof assetId !== "string" ||
        assetId === "" ||
        accessToken === null ||
        accessToken === ""
      ) {
        toast(DOWNLOAD_FAILED_MESSAGE);
        return null;
      }
      try {
        const { url } = await getAssetUrl(accessToken, assetId);
        if (typeof url !== "string" || url === "") {
          toast(DOWNLOAD_FAILED_MESSAGE);
          return null;
        }
        const original = await (loadOriginal ?? fetchAsDataURL)(url);
        return { assetId, original, fileName: downloadBaseName(el, file) };
      } catch {
        toast(DOWNLOAD_FAILED_MESSAGE);
        return null;
      }
    },
    [excalidrawApi, toast, loadOriginal, accessToken],
  );

  /**
   * 二级条（翻转 / 旋转）的「下载」—— ED-00j：**必须用原图**。
   *
   * 画布里的 `files[fileId].dataURL` 是**显示版**（服务端 `storageUrl` 的 1024 webp 变换，GN-14），
   * 拿它下载等于把翻转后的图再缩一遍，违反「翻转 = 原图」。所以：
   *
   * - 有 `assetId`（服务端产物）→ 先 `loadOriginalOf` 取原图字节（assetId → 签名 URL → 原图），
   *   成功才用 `loaded.original` + `loaded.fileName` 下载；拿不到时它自己已 toast，这里直接返回。
   * - 没有 `assetId`（本地尚未上传的图）→ 只有 `dataURL` 这一份，**它就是原图**，保持原行为；
   *   连 `dataURL` 都没有才 toast（工单 §5 用例 9）。
   *
   * 依赖里放 `loadOriginalOf`，所以这个回调必须声明在它之后（否则求值依赖数组时进 TDZ）。
   */
  const handleDownload = useCallback(
    async (state: FlipRotateState) => {
      const el = snapshot?.element as ElementLike | null | undefined;
      if (!el) return;
      const files = excalidrawApi.getFiles?.() ?? {};
      const fileId = typeof el.fileId === "string" ? el.fileId : "";
      const file = fileId === "" ? undefined : files[fileId];

      const assetId = file?.assetId;
      if (typeof assetId === "string" && assetId !== "") {
        const loaded = await loadOriginalOf(el);
        // 拿不到原图就不下载显示版（loadOriginalOf 已经提示过）。
        if (loaded === null) return;
        (download ?? downloadTransformed)(loaded.original, loaded.fileName, state);
        return;
      }

      const dataUrl = file?.dataURL;

      // 本地图只有 dataURL 这一份（它就是原图）；拿不到就只提示，不抛错（工单 §5 用例 9）。
      if (typeof dataUrl !== "string" || dataUrl === "") {
        toast(DOWNLOAD_FAILED_MESSAGE);
        return;
      }
      (download ?? downloadTransformed)(dataUrl, downloadBaseName(el, file), state);
    },
    [snapshot, excalidrawApi, toast, download, loadOriginalOf],
  );

  /** ED-02: enter the crop panel for the selected image (needs dataURL, assetId and a known size). */
  const enterCrop = useCallback(async () => {
    const el = snapshot?.element as ElementLike | null | undefined;
    if (!el || typeof el.id !== "string") return;
    const elementId = el.id;
    const loaded = await loadOriginalOf(el);
    if (loaded === null) return;
    try {
      const source: Size = await (readImageSize ?? defaultReadImageSize)(loaded.original);
      if (!(source.width > 0) || !(source.height > 0)) {
        toast(DOWNLOAD_FAILED_MESSAGE);
        return;
      }
      setMode({
        kind: "crop",
        elementId,
        source,
        sourceDataUrl: loaded.original,
        assetId: loaded.assetId,
        fileName: loaded.fileName,
      });
    } catch {
      toast(DOWNLOAD_FAILED_MESSAGE);
    }
  }, [snapshot, toast, readImageSize, loadOriginalOf]);

  /** ED-01: enter the adjust panel on the original of the selected image. */
  const enterAdjust = useCallback(async () => {
    const el = snapshot?.element as ElementLike | null | undefined;
    if (!el || typeof el.id !== "string") return;
    if (!definitions.tools.some((tool) => tool.id === ADJUST_TOOL_ID)) return;
    const elementId = el.id;
    const loaded = await loadOriginalOf(el);
    if (loaded === null) return;
    setMode({
      kind: "adjust",
      elementId,
      sourceDataUrl: loaded.original,
      assetId: loaded.assetId,
      fileName: loaded.fileName,
    });
    // 预览（35V）：先上面板，再解码一次原图留缓存；解码失败就不显示预览，面板照常可用。
    try {
      const pixels = await (decodePixels ?? browserDecode)(loaded.original);
      setAdjustDecode({ sourceDataUrl: loaded.original, pixels });
    } catch {
      setAdjustDecode(null);
    }
  }, [snapshot, definitions.tools, loadOriginalOf, decodePixels]);

  /** ED-01: auto-adjust from the histogram of the original（复用进面板时解码的缓存）。 */
  const handleAdjustAuto = useCallback(async (): Promise<AutoAdjustResult> => {
    if (mode.kind !== "adjust") throw new Error("not in adjust mode");
    const cached =
      adjustDecode !== null && adjustDecode.sourceDataUrl === mode.sourceDataUrl
        ? adjustDecode.pixels
        : null;
    const pixels = cached ?? (await (decodePixels ?? browserDecode)(mode.sourceDataUrl));
    return autoAdjust(pixels);
  }, [mode, decodePixels, adjustDecode]);

  /** ED-01 预览：缓存的原图 → 面板尺寸小图。只在缓存或模式变化时降采样一次。 */
  const adjustPreviewSource = useMemo(() => {
    if (mode.kind !== "adjust" || adjustDecode === null) return undefined;
    if (adjustDecode.sourceDataUrl !== mode.sourceDataUrl) return undefined;
    return makePreviewSource(adjustDecode.pixels, ADJUST_PREVIEW_BOX);
  }, [mode, adjustDecode]);

  /** ED-00i ①: render at the original size → upload as tool:adjust → replace in place (no resize). */
  const handleAdjustDone = useCallback(
    async (params: AdjustParams) => {
      if (mode.kind !== "adjust") return;
      const { elementId, sourceDataUrl, assetId, fileName } = mode;
      if (accessToken === null || accessToken === "") {
        toast(DOWNLOAD_FAILED_MESSAGE);
        return;
      }
      try {
        const output = await commitAdjustOutput(
          {
            decode: decodePixels ?? browserDecode,
            encode: encodePixels ?? browserEncode,
            upload: (file, parent) =>
              uploadToolOutput(accessToken, {
                file,
                source: "tool:adjust",
                parentArtifactId: parent,
              }).then((r) => ({ assetId: r.asset.id, url: r.url })),
            loadAsDataUrl: fetchAsDataURL,
            addFile: (f) => excalidrawApi.addFiles?.([f]),
            newFileId: newCropFileId,
          },
          { sourceDataUrl, parentAssetId: assetId, params, fileName },
        );
        const scene =
          elementsRef.current.length > 0
            ? elementsRef.current
            : Array.from(excalidrawApi.getSceneElements?.() ?? []);
        if (scene.length === 0) return;
        excalidrawApi.updateScene?.({
          // No width/height: an adjustment never changes the size.
          elements: replaceImageInPlace(scene, elementId, {
            fileId: output.fileId,
            assetId: output.assetId,
            parentAssetId: assetId,
            source: "tool:adjust",
          }),
          captureUpdate: "IMMEDIATELY",
        });
        setAdjustDecode(null);
        setMode({ kind: "toolbar" });
      } catch (err) {
        toast(err instanceof Error && err.message !== "" ? err.message : DOWNLOAD_FAILED_MESSAGE);
      }
    },
    [mode, accessToken, decodePixels, encodePixels, excalidrawApi, toast],
  );

  const exitAdjust = useCallback(() => {
    setAdjustDecode(null);
    setMode({ kind: "toolbar" });
  }, []);

  /** ED-00i ①: crop at source pixels → upload as tool:crop → replace the element in place. */
  const handleCropDone = useCallback(
    async (rect: CropRect) => {
      if (mode.kind !== "crop") return;
      const { elementId, sourceDataUrl, assetId, fileName } = mode;
      if (accessToken === null || accessToken === "") {
        toast(DOWNLOAD_FAILED_MESSAGE);
        return;
      }
      try {
        const output = await commitCropOutput(
          {
            renderCrop: renderCrop ?? browserRenderCrop,
            upload: (file, parent) =>
              uploadToolOutput(accessToken, {
                file,
                source: "tool:crop",
                parentArtifactId: parent,
              }).then((r) => ({ assetId: r.asset.id, url: r.url })),
            loadAsDataUrl: fetchAsDataURL,
            addFile: (f) => excalidrawApi.addFiles?.([f]),
            newFileId: newCropFileId,
          },
          { sourceDataUrl, parentAssetId: assetId, rect, fileName },
        );
        const scene =
          elementsRef.current.length > 0
            ? elementsRef.current
            : Array.from(excalidrawApi.getSceneElements?.() ?? []);
        if (scene.length === 0) return;
        excalidrawApi.updateScene?.({
          elements: replaceImageInPlace(scene, elementId, {
            fileId: output.fileId,
            assetId: output.assetId,
            parentAssetId: assetId,
            source: "tool:crop",
            width: output.width,
            height: output.height,
          }),
          captureUpdate: "IMMEDIATELY",
        });
        setMode({ kind: "toolbar" });
      } catch (err) {
        toast(err instanceof Error && err.message !== "" ? err.message : DOWNLOAD_FAILED_MESSAGE);
      }
    },
    [mode, accessToken, renderCrop, excalidrawApi, toast],
  );

  const exitCrop = useCallback(() => setMode({ kind: "toolbar" }), []);

  /**
   * ED-07 / ED-00m：直接执行类工具（去背景等）→ 服务端跑 → 产物**原位替换**原图。
   *
   * 与裁剪 / 调整同一套写法（`replaceImageInPlace` + `addFiles` + `updateScene`），差别只有：
   * 像素不是这台浏览器算的，产物已经是存储里的一个 asset（GN-24：**不下载再上传**），
   * 前端只是把签名地址的字节读进 `files[fileId].dataURL` 让画布能画出来。
   *
   * 占位期间只给一句 loading（本单不新增组件，ED-07 允许的最小做法）；失败只提示、不替换。
   */
  const runServerTool = useCallback(
    async (toolId: string, label: string) => {
      const el = snapshot?.element as ElementLike | null | undefined;
      if (!el || typeof el.id !== "string") return;
      const files = excalidrawApi.getFiles?.() ?? {};
      const fileId = typeof el.fileId === "string" ? el.fileId : "";
      const file = fileId === "" ? undefined : files[fileId];
      const assetId = file?.assetId;
      if (
        typeof assetId !== "string" ||
        assetId === "" ||
        accessToken === null ||
        accessToken === ""
      ) {
        toast(DOWNLOAD_FAILED_MESSAGE);
        return;
      }

      const elementId = el.id;
      // ED-00m：连点期间这一次已经在跑 —— 不发第二次请求，也不做第二次替换。
      const runKey = `${elementId}:${toolId}`;
      if (activeToolRunsRef.current.has(runKey)) return;
      activeToolRunsRef.current.add(runKey);

      toast(`${label}处理中…`);
      try {
        // ED-00m：key = 元素 + 工具，在途期间重复点击复用同一个请求。
        const output = await toolRunner.runOnce(runKey, toolId, {
          artifactId: assetId,
        });
        const outputFileId = newCropFileId();
        excalidrawApi.addFiles?.([
          {
            id: outputFileId,
            dataURL: output.dataUrl,
            mimeType: output.mimeType,
            created: Date.now(),
            // 后续工具还要拿这个 assetId 当源，所以它必须跟着文件记录走。
            assetId: output.assetId,
          },
        ]);
        const scene =
          elementsRef.current.length > 0
            ? elementsRef.current
            : Array.from(excalidrawApi.getSceneElements?.() ?? []);
        if (scene.length === 0) return;
        excalidrawApi.updateScene?.({
          elements: replaceImageInPlace(scene, elementId, {
            fileId: outputFileId,
            assetId: output.assetId,
            parentAssetId: assetId,
            source: `tool:${toolId}`,
            ...(output.width === undefined ? {} : { width: output.width }),
            ...(output.height === undefined ? {} : { height: output.height }),
          }),
          captureUpdate: "IMMEDIATELY",
        });
      } catch (err) {
        toast(err instanceof Error && err.message !== "" ? err.message : DOWNLOAD_FAILED_MESSAGE);
      } finally {
        // 无论成功失败，这个「元素 + 工具」重新可以点。
        activeToolRunsRef.current.delete(runKey);
      }
    },
    [snapshot, excalidrawApi, accessToken, toast, toolRunner],
  );

  const handleToolSelect = useCallback(
    (toolId: string) => {
      if (toolId === CROP_TOOL_ID) {
        void enterCrop();
        return;
      }
      if (toolId === ADJUST_TOOL_ID) {
        void enterAdjust();
        return;
      }
      if (toolId === FLIP_ROTATE_TOOL_ID) {
        enterFlipRotate();
        return;
      }
      // ED-05：主工具条的下载走服务端原图；二级条的下载（导出变换后的图）不受影响。
      if (toolId === DOWNLOAD_TOOL_ID) {
        void handleDownloadOriginal();
        return;
      }
      // ED-07：定义里是「直接执行」且计价的服务端工具 → 直接执行，不进面板、不确认。
      const tool = definitions.tools.find((candidate) => candidate.id === toolId);
      if (tool !== undefined && tool.form === "direct" && tool.pricing !== null) {
        void runServerTool(tool.id, tool.label);
        return;
      }
      // 其余工具本单都不接（工单 §3 裁决 6）。
      toast(TOOL_PENDING_MESSAGE);
    },
    [
      enterFlipRotate,
      enterCrop,
      enterAdjust,
      handleDownloadOriginal,
      definitions.tools,
      runServerTool,
      toast,
    ],
  );

  /**
   * ED-05：多选「下载全部」→ 服务端打包 zip（34G `POST /api/uploads/zip`）。
   *
   * 只有「`type === "image"` 且 `files[fileId].assetId` 是非空字符串」的才进 `assetIds`；
   * 生成中 / 失败占位、没有 `assetId` 的老图、其他类型的选中项一律**本地跳过**并计数，
   * 完成后把「本地跳过 + 服务端 skipped」一起报给用户（ED-05 原话「已跳过 N 个未完成对象」）。
   *
   * 服务端拒绝时 `message` 就是规格文案（如「选中过多，请分批下载」），原样显示，不改写。
   *
   * 已知口径（工单 34W 明确接受）：`elementKind` 把**失败占位**映射成 `null`，所以多选里
   * 混进失败占位时整条形态变成 `none`、这个按钮根本不出现；生成中占位能参与并会被跳过。
   */
  const handleDownloadAll = useCallback(async () => {
    const files = excalidrawApi.getFiles?.() ?? {};
    const assetIds: string[] = [];
    let localSkipped = 0;

    for (const el of downloadAllSelectionRef.current) {
      const fileId = typeof el.fileId === "string" ? el.fileId : "";
      const file = fileId === "" ? undefined : files[fileId];
      const assetId = file?.assetId;
      if (el.type === "image" && typeof assetId === "string" && assetId !== "") {
        assetIds.push(assetId);
      } else {
        localSkipped += 1;
      }
    }

    if (assetIds.length === 0) {
      toast(NO_DOWNLOADABLE_MESSAGE);
      return;
    }
    // 没有 token 就没有 zip 请求可发：与单图下载同一条提示，不弹服务端文案。
    if (accessToken === null || accessToken === "") {
      toast(DOWNLOAD_FAILED_MESSAGE);
      return;
    }

    setDownloadAllBusy(true);
    try {
      const { blob, fileName, skipped } = await downloadAssetsZip(accessToken, {
        assetIds,
        projectName,
      });
      (saveBlob ?? defaultSaveBlob)(blob, fileName);

      const skippedTotal = localSkipped + skipped;
      if (skippedTotal > 0) toast(`已跳过 ${skippedTotal} 个未完成对象`);
    } catch (err) {
      toast(err instanceof Error ? err.message : DOWNLOAD_FAILED_MESSAGE);
    } finally {
      setDownloadAllBusy(false);
    }
  }, [excalidrawApi, toast, accessToken, projectName, saveBlob]);

  // 「下载全部」用合并外接框，单图工具条用那张图自己的框（含旋转）；两者互斥，同时只一个非空。
  const anchor: ElementLike | SelectionBox | null =
    (snapshot?.element as ElementLike | null | undefined) ??
    snapshot?.downloadAllBox ??
    null;

  if (!visible || snapshot === null || anchor === null) {
    return null;
  }

  const adjustTool = definitions.tools.find((tool) => tool.id === ADJUST_TOOL_ID);

  const anchorRect = elementScreenRect({
    el: {
      x: anchor.x ?? 0,
      y: anchor.y ?? 0,
      width: anchor.width ?? 0,
      height: anchor.height ?? 0,
      angle: anchor.angle ?? 0,
    },
    scrollX: snapshot.scrollX,
    scrollY: snapshot.scrollY,
    zoom: snapshot.zoom,
  });

  const toolbarPosition = imageToolbarPosition({
    el: {
      x: anchor.x ?? 0,
      y: anchor.y ?? 0,
      width: anchor.width ?? 0,
      height: anchor.height ?? 0,
      angle: anchor.angle ?? 0,
    },
    scrollX: snapshot.scrollX,
    scrollY: snapshot.scrollY,
    zoom: snapshot.zoom,
    viewportWidth: snapshot.viewportWidth,
    toolbarWidth,
  });

  /**
   * ED-00d：面板按「右 → 左 → 下」定位，并夹进视口（规格原文：面板不得超出视口）。
   * 坐标系与 `elementScreenRect` 一致（画布容器坐标），视口从 `(0, 0)` 起算 —— 本组件
   * 挂在画布容器里，容器的左上角就是视口的左上角。
   */
  const panelPlacement = panelMode
    ? placePanel({
        anchor: anchorRect,
        panel: panelSize,
        viewport: { x: 0, y: 0, width: snapshot.viewportWidth, height: snapshot.viewportHeight },
      })
    : null;

  const position: { x: number; y: number; placement: "above" | "below" | "right" | "left" } =
    panelPlacement !== null
      ? { x: panelPlacement.x, y: panelPlacement.y, placement: panelPlacement.side }
      : {
          x: toolbarPosition.x,
          y: toolbarPosition.y,
          placement: toolbarPosition.placement,
        };

  /**
   * ED-05：多选「下载全部」**用自己的容器**，不复用 `image-toolbar-layer`。
   *
   * 已有契约 `image-toolbar-layer` 只在「恰好选中 1 张图」时出现（`test/image-toolbar-layer.test.tsx`
   * 「选中 2 张图 → 不出现」），多选条的容器混进去就会破掉它 —— 两者是两张不同的浮层。
   */
  if (visibleDownloadAll) {
    return (
      <div
        ref={containerRef}
        data-testid="image-toolbar-download-all-layer"
        data-placement={position.placement}
        className="absolute z-20"
        style={{ left: position.x, top: position.y }}
      >
        <DownloadAllBar onDownload={() => void handleDownloadAll()} busy={downloadAllBusy} />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="image-toolbar-layer"
      data-state={
        mode.kind === "flip-rotate"
          ? "flip-rotate"
          : mode.kind === "crop"
            ? "crop"
            : mode.kind === "adjust"
              ? "adjust"
              : "toolbar"
      }
      data-placement={position.placement}
      className="absolute z-20"
      style={{ left: position.x, top: position.y }}
    >
      {mode.kind === "adjust" && adjustTool !== undefined ? (
        <AdjustToolSession
          tool={adjustTool}
          previewSource={adjustPreviewSource}
          onAuto={handleAdjustAuto}
          onCancel={exitAdjust}
          onDone={(params) => void handleAdjustDone(params)}
        />
      ) : mode.kind === "crop" ? (
        <CropToolSession
          source={mode.source}
          sourceDataUrl={mode.sourceDataUrl}
          onCancel={exitCrop}
          onDone={(rect) => void handleCropDone(rect)}
        />
      ) : mode.kind === "flip-rotate" ? (
        <FlipRotateBar
          state={mode.state}
          onChange={handleFlipChange}
          onDownload={(s) => void handleDownload(s)}
          onExit={exitFlipRotate}
        />
      ) : (
        <ImageToolbar tools={definitions.tools} onToolSelect={handleToolSelect} prices={prices} />
      )}
    </div>
  );
}
