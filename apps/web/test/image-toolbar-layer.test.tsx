import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * 工单 30Q §5 · `ImageToolbarLayer`（逐图工具条接到画布上）。
 *
 * 三个替身，理由都写在工单里：
 *
 * 1. `useToolDefinitions` 走真身会发 `GET /api/tools`，本单不测取数 → 直接给一份定义，
 *    其中 `flip_rotate` 与 `adjust` 放在 `default_slot: "main"`，这样它们才出现在主工具条上。
 * 2. `@excalidraw/excalidraw` 只用到 `newElementWith`，包是 client-only 且体积巨大，
 *    按工单 §5 给一个「递增 version」的最小替身（真实行为由浏览器确认）。
 * 3. `useToast` 换成可断言的 spy：本单要验的是「点了某个工具会弹提示」，
 *    不是 toast 组件自己的动画（那是 `toast-action.test.tsx` 的范围）。
 *
 * 假 API 的 `onChange` 把回调存下来，测试里手动 `push()` 一帧 —— 这是工单 §5 要求的写法，
 * 因为 `onSelectionChange` 只在 id 集合变化时触发，跟随必须走 `onChange`。
 */

const toastMock = vi.hoisted(() => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/toast", () => ({ useToast: () => toastMock }));

const toolDefinitions = vi.hoisted(() => [
  {
    id: "flip_rotate",
    label: "翻转与旋转",
    icon: "flip_rotate",
    testid: "image-toolbar-flip-rotate",
    form: "subbar",
    default_slot: "main",
    removable: true,
    consumes: false,
    pricing: null,
    output_kind: "none",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
  },
  {
    id: "adjust",
    label: "调整",
    icon: "adjust",
    testid: "image-toolbar-adjust",
    form: "panel",
    default_slot: "main",
    removable: true,
    consumes: false,
    pricing: null,
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [{ id: "no_adjustment", message: "未做任何调整" }],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
  },
  // ED-05：主工具条的「下载」（服务端定义见 `apps/server/.../tool-definitions.ts` L120）。
  {
    id: "download",
    label: "下载",
    icon: "download",
    testid: "image-toolbar-download",
    form: "direct",
    default_slot: "main",
    removable: false,
    consumes: false,
    pricing: null,
    output_kind: "none",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
  },
]);

vi.mock("@/hooks/use-tool-definitions", () => ({
  useToolDefinitions: () => ({ status: "ready", tools: toolDefinitions }),
}));

/**
 * ED-05：只替身 `getAssetDownloadUrl`（本单要断言「有没有去问服务端要下载地址」），
 * 其余导出用 `importOriginal` 保留原样 —— 被测组件与这个文件都还需要 server-api 的其他成员。
 */
const getAssetDownloadUrlMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAssetDownloadUrl: getAssetDownloadUrlMock,
}));

vi.mock("@excalidraw/excalidraw", () => ({
  newElementWith: (element: Record<string, unknown>, updates: Record<string, unknown>) => ({
    ...element,
    ...updates,
    version: ((element["version"] as number | undefined) ?? 1) + 1,
  }),
}));

import {
  DOWNLOAD_FAILED_MESSAGE,
  ImageToolbarLayer,
  SCROLL_ZOOM_SETTLE_MS,
  TOOL_PENDING_MESSAGE,
} from "../src/components/canvas/image-toolbar-layer";

// 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收。
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  toastMock.toast.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

// --- 夹具 -------------------------------------------------------------------

type Element = Record<string, unknown>;
type AppState = Record<string, unknown>;

/** 一张普通的图片元素（版本 3，方便断言 newElementWith 把它推到 4）。 */
function imageElement(overrides: Element = {}): Element {
  return {
    id: "img-1",
    type: "image",
    x: 100,
    y: 200,
    width: 80,
    height: 60,
    angle: 0,
    scale: [1, 1],
    fileId: "file-1",
    version: 3,
    isDeleted: false,
    customData: { fileName: "cat.png" },
    ...overrides,
  };
}

/** 一个不该影响判定的矩形（用来验「其他元素原样返回」）。 */
function rectangleElement(): Element {
  return {
    id: "rect-1",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    fileId: null,
    version: 1,
    isDeleted: false,
  };
}

function makeAppState(overrides: AppState = {}): AppState {
  return {
    selectedElementIds: { "img-1": true },
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    width: 1000,
    selectedElementsAreBeingDragged: false,
    isResizing: false,
    isRotating: false,
    isCropping: false,
    ...overrides,
  };
}

type FakeApi = {
  onChange: ReturnType<typeof vi.fn>;
  updateScene: ReturnType<typeof vi.fn>;
  getFiles: ReturnType<typeof vi.fn>;
};

/**
 * 渲染 + 推第一帧。返回假 API 和「再推一帧」的函数。
 *
 * `push()` 包在 `act()` 里：帧是外部事件（Excalidraw 的 onChange）驱动进来的，
 * 不包的话 setState 在 act 之外发生，React 会警告且断言可能看到旧树。
 */
type HarnessOptions = {
  files?: Record<string, unknown>;
  download?: ReturnType<typeof vi.fn>;
  /** ED-05：注入「打开下载地址」的 spy（组件内部是造 anchor 并 click）。 */
  openDownload?: ReturnType<typeof vi.fn>;
  /** ED-05：有的用例要换 token（默认 `"test-token"`）。 */
  accessToken?: string | null;
};

function setup(options: HarnessOptions = {}) {
  const listeners: Array<(elements: Element[], appState: AppState) => void> = [];
  const api: FakeApi = {
    onChange: vi.fn((listener: (elements: Element[], appState: AppState) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    updateScene: vi.fn(),
    getFiles: vi.fn(
      () =>
        options.files ?? {
          "file-1": { dataURL: "data:image/png;base64,AAAA", mimeType: "image/png" },
        },
    ),
  };

  // 不给 `download` 时**连 prop 都不传**，走组件默认的 `downloadTransformed`。
  const props: Parameters<typeof ImageToolbarLayer>[0] = {
    excalidrawApi: api as never,
    accessToken: options.accessToken === undefined ? "test-token" : options.accessToken,
  };
  if (options.download !== undefined) props.download = options.download;
  if (options.openDownload !== undefined) props.openDownload = options.openDownload;

  render(<ImageToolbarLayer {...props} />);

  const push = (elements: Element[], appState: AppState) => {
    act(() => {
      for (const listener of listeners) listener(elements, appState);
    });
  };

  return { api, push };
}

/** 一次「选中一张图」的普通开局。 */
function setupSelectedImage(options: HarnessOptions = {}) {
  const harness = setup(options);
  harness.push([imageElement(), rectangleElement()], makeAppState());
  return harness;
}

/** 进入二级条（点主工具条上的「翻转与旋转」）。 */
function enterFlipRotate(): void {
  fireEvent.click(screen.getByTestId("image-toolbar-flip-rotate"));
}

/** 二级条当前状态。 */
function layerState(): string | null {
  return screen.getByTestId("image-toolbar-layer").getAttribute("data-state");
}

// --- 用例 -------------------------------------------------------------------

describe("ImageToolbarLayer：只在恰好选中 1 张图时出现", () => {
  it("恰好选中 1 张图 → 出现，且 root 带 data-state=toolbar", () => {
    setupSelectedImage();

    expect(screen.getByTestId("image-toolbar-layer")).toBeInTheDocument();
    expect(screen.getByTestId("image-toolbar")).toBeInTheDocument();
    expect(layerState()).toBe("toolbar");
  });

  it("选中 0 个 → 不出现", () => {
    const { push } = setup();
    push([imageElement()], makeAppState({ selectedElementIds: {} }));

    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();
  });

  it("选中 2 张图 → 不出现", () => {
    const { push } = setup();
    push(
      [imageElement(), imageElement({ id: "img-2", fileId: "file-2" })],
      makeAppState({ selectedElementIds: { "img-1": true, "img-2": true } }),
    );

    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();
  });

  it("选中 1 个文本 → 不出现", () => {
    const { push } = setup();
    push(
      [imageElement({ id: "text-1", type: "text", fileId: null })],
      makeAppState({ selectedElementIds: { "text-1": true } }),
    );

    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();
  });

  it("选中 1 个正在生成的占位 → 不出现", () => {
    const { push } = setup();
    push(
      [imageElement({ customData: { generating: true } })],
      makeAppState({ selectedElementIds: { "img-1": true } }),
    );

    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();
  });

  it("选中集合里有元素映射成 null（embeddable）→ 不出现", () => {
    const { push } = setup();
    push(
      [imageElement(), imageElement({ id: "embed-1", type: "embeddable", fileId: null })],
      makeAppState({ selectedElementIds: { "img-1": true, "embed-1": true } }),
    );

    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();
  });

  it("选中的图片被删掉（isDeleted）不算选中", () => {
    const { push } = setup();
    push([imageElement({ isDeleted: true })], makeAppState());

    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();
  });
});

describe("ImageToolbarLayer：拖动 / 缩放期间隐藏", () => {
  it("推送一帧 selectedElementsAreBeingDragged=true 后消失，推送 false 后恢复", () => {
    const { push } = setupSelectedImage();
    expect(screen.getByTestId("image-toolbar-layer")).toBeInTheDocument();

    push([imageElement(), rectangleElement()], makeAppState({ selectedElementsAreBeingDragged: true }));
    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();

    push([imageElement(), rectangleElement()], makeAppState({ selectedElementsAreBeingDragged: false }));
    expect(screen.getByTestId("image-toolbar-layer")).toBeInTheDocument();
  });

  it.each(["isResizing", "isRotating", "isCropping"])("%s=true 时同样隐藏", (flag) => {
    const { push } = setupSelectedImage();
    expect(screen.getByTestId("image-toolbar-layer")).toBeInTheDocument();

    push([imageElement(), rectangleElement()], makeAppState({ [flag]: true }));
    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();
  });

  it("zoom 变化后立即消失，推进 150ms 后恢复", () => {
    vi.useFakeTimers();
    const { push } = setupSelectedImage();
    expect(screen.getByTestId("image-toolbar-layer")).toBeInTheDocument();

    push([imageElement(), rectangleElement()], makeAppState({ zoom: { value: 2 } }));
    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();

    // 差 1ms 还没恢复：证明它是「150ms 计时」而不是别的原因导致的隐藏
    act(() => {
      vi.advanceTimersByTime(SCROLL_ZOOM_SETTLE_MS - 1);
    });
    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("image-toolbar-layer")).toBeInTheDocument();
  });

  it("滚动变化也会重新计时（scrollX 与 scrollY 都算）", () => {
    vi.useFakeTimers();
    const { push } = setupSelectedImage();

    push([imageElement(), rectangleElement()], makeAppState({ scrollX: -10 }));
    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(SCROLL_ZOOM_SETTLE_MS - 1);
    });
    expect(screen.queryByTestId("image-toolbar-layer")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("image-toolbar-layer")).toBeInTheDocument();
  });
});

describe("ImageToolbarLayer：翻转与旋转二级条", () => {
  it("点 image-toolbar-flip-rotate 后 root 变 flip-rotate，主工具条被替换", () => {
    setupSelectedImage();

    // 进之前：这个 testid 是主工具条上的按钮
    expect(screen.getByTestId("image-toolbar-flip-rotate").tagName).toBe("BUTTON");

    enterFlipRotate();

    expect(layerState()).toBe("flip-rotate");
    expect(screen.queryByTestId("image-toolbar")).toBeNull();
    // 进之后：同一个 testid 现在是二级条的容器
    expect(screen.getByTestId("image-toolbar-flip-rotate").tagName).toBe("DIV");
    expect(screen.getByTestId("image-toolbar-flip-rotate-angle")).toBeInTheDocument();
  });

  it("点「水平翻转」：updateScene 1 次，scale [-1,1]，version 递增，captureUpdate=IMMEDIATELY，其他元素同引用", async () => {
    const other = rectangleElement();
    const { api, push } = setup();
    push([imageElement(), other], makeAppState());
    enterFlipRotate();

    fireEvent.click(screen.getByTestId("image-toolbar-flip-rotate-flip-h"));

    await waitFor(() => expect(api.updateScene).toHaveBeenCalledTimes(1));

    const scene = api.updateScene.mock.calls[0]?.[0] as {
      elements: Element[];
      captureUpdate: string;
    };
    expect(scene.captureUpdate).toBe("IMMEDIATELY");

    const updated = scene.elements.find((element) => element["id"] === "img-1");
    expect(updated?.["scale"]).toEqual([-1, 1]);
    // 夹具里是 3，替身 newElementWith 递增到 4
    expect(updated?.["version"]).toBe(4);

    // 其他元素原样返回：必须是同一个引用，不是复制出来的等值对象
    expect(scene.elements.find((element) => element["id"] === "rect-1")).toBe(other);
  });

  it("角度框输入 450 回车：写入的 angle ≈ Math.PI / 2（误差 1e-9）", async () => {
    const { api } = setupSelectedImage();
    enterFlipRotate();

    const input = screen.getByTestId("image-toolbar-flip-rotate-angle");
    fireEvent.change(input, { target: { value: "450" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(api.updateScene).toHaveBeenCalledTimes(1));

    const scene = api.updateScene.mock.calls[0]?.[0] as { elements: Element[] };
    const updated = scene.elements.find((element) => element["id"] === "img-1");
    const angle = updated?.["angle"] as number;
    expect(Math.abs(angle - Math.PI / 2)).toBeLessThan(1e-9);
  });

  it("按 Esc 回到 data-state=toolbar", () => {
    setupSelectedImage();
    enterFlipRotate();
    expect(layerState()).toBe("flip-rotate");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(layerState()).toBe("toolbar");
    expect(screen.getByTestId("image-toolbar")).toBeInTheDocument();
  });

  it("选中集合变化时也回到主工具条", () => {
    const { push } = setupSelectedImage();
    enterFlipRotate();
    expect(layerState()).toBe("flip-rotate");

    // 换成另一张图（仍然恰好 1 张图，但已经不是二级条绑定的那个元素）
    push(
      [imageElement({ id: "img-2", fileId: "file-2" }), rectangleElement()],
      makeAppState({ selectedElementIds: { "img-2": true } }),
    );

    expect(layerState()).toBe("toolbar");
    expect(screen.getByTestId("image-toolbar")).toBeInTheDocument();
  });
});

describe("ImageToolbarLayer：未接入的工具只弹 toast", () => {
  it("点 image-toolbar-adjust：toast 被调用 1 次，updateScene 0 次", () => {
    const { api } = setupSelectedImage();

    fireEvent.click(screen.getByTestId("image-toolbar-adjust"));

    expect(toastMock.toast).toHaveBeenCalledTimes(1);
    expect(toastMock.toast).toHaveBeenCalledWith(TOOL_PENDING_MESSAGE);
    expect(api.updateScene).toHaveBeenCalledTimes(0);
  });
});

describe("ImageToolbarLayer：二级条的下载", () => {
  it("files 的 dataURL 为空时点下载不抛错，并给 toast 提示", () => {
    setupSelectedImage({ files: { "file-1": { dataURL: "", mimeType: "image/png" } } });
    enterFlipRotate();

    expect(() => {
      fireEvent.click(screen.getByTestId("image-toolbar-flip-rotate-download"));
    }).not.toThrow();

    expect(toastMock.toast).toHaveBeenCalledWith(DOWNLOAD_FAILED_MESSAGE);
  });

  it("元素没有 fileId 时也走「拿不到原图」这条路，不抛错", () => {
    const { push } = setup({ files: {} });
    push([imageElement({ fileId: null, customData: {} })], makeAppState());
    enterFlipRotate();

    expect(() => {
      fireEvent.click(screen.getByTestId("image-toolbar-flip-rotate-download"));
    }).not.toThrow();

    expect(toastMock.toast).toHaveBeenCalledWith(DOWNLOAD_FAILED_MESSAGE);
  });

  it("有原图时：下载函数收到 dataURL、customData 里的文件名和当前状态", () => {
    const download = vi.fn();
    setupSelectedImage({ download });
    enterFlipRotate();

    fireEvent.click(screen.getByTestId("image-toolbar-flip-rotate-download"));

    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith("data:image/png;base64,AAAA", "cat.png", {
      angle: 0,
      flipH: false,
      flipV: false,
    });
    expect(toastMock.toast).not.toHaveBeenCalled();
  });

  it("先水平翻转再下载：state 带 flipH=true", async () => {
    const download = vi.fn();
    const { api } = setupSelectedImage({ download });
    enterFlipRotate();

    fireEvent.click(screen.getByTestId("image-toolbar-flip-rotate-flip-h"));
    await waitFor(() => expect(api.updateScene).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("image-toolbar-flip-rotate-download"));

    const lastCall = download.mock.calls[download.mock.calls.length - 1];
    expect(lastCall?.[2]).toEqual({ angle: 0, flipH: true, flipV: false });
    expect(lastCall?.[1]).toBe("cat.png");
  });
});

describe("ED-05：工具条下载走服务端原图", () => {
  /** 服务端画布读投影带回的文件记录（`file.assetId`，见 `app/canvas/page.tsx` L298）。 */
  const filesWithAsset = {
    "file-1": {
      dataURL: "data:image/png;base64,AAAA",
      mimeType: "image/png",
      assetId: "asset-9",
    },
  };

  beforeEach(() => {
    getAssetDownloadUrlMock.mockReset();
  });

  it("ED-05: 有 assetId 时向服务端要下载地址并打开它", async () => {
    const openDownload = vi.fn();
    getAssetDownloadUrlMock.mockResolvedValue({ url: "https://x/sign?token=1" });
    setupSelectedImage({ files: filesWithAsset, openDownload, accessToken: "tok" });

    fireEvent.click(screen.getByTestId("image-toolbar-download"));

    await waitFor(() => expect(openDownload).toHaveBeenCalledWith("https://x/sign?token=1"));
    expect(getAssetDownloadUrlMock).toHaveBeenCalledWith("tok", "asset-9");
  });

  it("ED-05: 不在前端转 dataURL", async () => {
    const download = vi.fn();
    const openDownload = vi.fn();
    getAssetDownloadUrlMock.mockResolvedValue({ url: "https://x/sign?token=1" });
    setupSelectedImage({ files: filesWithAsset, download, openDownload, accessToken: "tok" });

    fireEvent.click(screen.getByTestId("image-toolbar-download"));

    await waitFor(() => expect(openDownload).toHaveBeenCalledTimes(1));
    // 二级条那条「导出变换后的图」的下载路径一次都不该走。
    expect(download).toHaveBeenCalledTimes(0);
  });

  it("ED-05: 没有 assetId 时给下载失败提示，不请求", () => {
    const openDownload = vi.fn();
    setupSelectedImage({
      files: { "file-1": { dataURL: "data:image/png;base64,AAAA", mimeType: "image/png" } },
      openDownload,
      accessToken: "tok",
    });

    fireEvent.click(screen.getByTestId("image-toolbar-download"));

    expect(toastMock.toast).toHaveBeenCalledWith(DOWNLOAD_FAILED_MESSAGE);
    expect(getAssetDownloadUrlMock).toHaveBeenCalledTimes(0);
    expect(openDownload).toHaveBeenCalledTimes(0);
  });

  it("ED-05: 服务端拒绝时给下载失败提示", async () => {
    const openDownload = vi.fn();
    getAssetDownloadUrlMock.mockRejectedValue(new Error("403"));
    setupSelectedImage({ files: filesWithAsset, openDownload, accessToken: "tok" });

    fireEvent.click(screen.getByTestId("image-toolbar-download"));

    await waitFor(() =>
      expect(toastMock.toast).toHaveBeenCalledWith(DOWNLOAD_FAILED_MESSAGE),
    );
    expect(openDownload).toHaveBeenCalledTimes(0);
  });
});
