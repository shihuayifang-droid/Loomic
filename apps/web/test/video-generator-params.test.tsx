import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

import type { VideoModelInfo } from "../src/lib/server-api";

/**
 * 工单 41E：视频生成面板的「时长滑块 + 生成方式（首尾帧）」（AG-07 视频侧）。
 *
 * 面板这一侧只做四件事：
 *   1) `currentModel.params` 里有 `duration` 连续参数 → 用共享滑块
 *      （`generator-slider-duration`，带 aria-valuemin/max/now），旧时长 tab 不渲染；
 *   2) 切模型时当前时长不在新参数的取值表 / 区间里 → 回落到该参数下发 `default`；
 *   3) `capabilities.firstLastFrame === true` 才有「生成方式」这一组；选「首尾帧」时
 *      从画布带入选中的两张图（选中顺序 = 首、尾），缺一张 → 按钮 disabled + 逐字提示；
 *   4) 没有 `params` 的旧模型与改动前一致（旧时长 tab、帧可选）。
 *
 * 询价 hook / 网络函数与 39B 的 precheck 测试同一套替身写法。
 */

// --- toast 的动画库换成直通 div（理由见 toast-action.test.tsx） ----------------
vi.mock("framer-motion", async () => {
  const React = await import("react");
  const FRAMER_PROPS = new Set(["layout", "initial", "animate", "exit", "transition"]);
  const passthrough = (props: Record<string, unknown>) => {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "children" || FRAMER_PROPS.has(key)) continue;
      rest[key] = value;
    }
    return rest;
  };
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    motion: {
      div: (props: Record<string, unknown>) =>
        React.createElement("div", passthrough(props), props.children as ReactNode),
    },
  };
});

/** tier toast 有 Next router 依赖，这条单不关心它，换成 spy。 */
const tierMock = vi.hoisted(() => ({ showTierLimit: vi.fn() }));
vi.mock("@/components/credits/tier-limit-toast", () => ({
  useTierLimitToast: () => ({ showTierLimit: tierMock.showTierLimit }),
}));

/** CV-10 的完成提醒 hook 与本单无关，换替身免得它去动 document.title。 */
vi.mock("@/hooks/use-completion-title", () => ({
  useCompletionTitle: () => ({ begin: vi.fn(), end: vi.fn() }),
}));

// --- 网络函数换成替身：模型列表 / 提交 / 询价 / 等待 --------------------------
const apiMock = vi.hoisted(() => ({
  fetchVideoModels: vi.fn(),
  submitVideoJob: vi.fn(),
  fetchPriceQuote: vi.fn(),
}));

vi.mock("../src/lib/server-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/server-api")>();
  return {
    ...actual,
    fetchVideoModels: apiMock.fetchVideoModels,
    submitVideoJob: apiMock.submitVideoJob,
    fetchPriceQuote: apiMock.fetchPriceQuote,
  };
});

const apiMockAwait = vi.hoisted(() => ({ awaitJobCompletion: vi.fn() }));
vi.mock("../src/lib/await-job", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/await-job")>();
  return { ...actual, awaitJobCompletion: apiMockAwait.awaitJobCompletion };
});

/** 询价 hook 换成替身：本单不验询价，只要预检放行。 */
const quoteMock = vi.hoisted(() => ({
  result: { price: null as unknown, precheck: null as unknown },
}));

vi.mock("@/hooks/use-generation-quote", () => ({
  GENERATION_QUOTE_DEBOUNCE_MS: 300,
  useGenerationQuote: () => quoteMock.result,
}));

import { ToastProvider } from "../src/components/toast";
import { VideoGeneratorPanel } from "../src/components/canvas/video-generator-panel";

const JOB_ID = "job-vid-params";
const BOUNDS = { x: 0, y: 0, width: 300, height: 200 };
const SCROLL_ZOOM = { scrollX: 0, scrollY: 0, zoom: 1 };
const NOOP_API = {
  getSceneElements: () => [],
  updateScene: () => {},
  addFiles: () => {},
};

/** A = metaso 式（收首尾帧、duration 4..15）；B = 只支持 5s / 10s；C = 无 params 的旧模型。 */
const FULL_MODEL = "metaso/kling-first-last";
const LIMITED_MODEL = "test/limited-duration";
const PLAIN_MODEL = "test/no-params";

const DATA_A = "data:image/png;base64,QUFBQQ==";
const DATA_B = "data:image/png;base64,QkJCQg==";

const MODELS: VideoModelInfo[] = [
  {
    id: FULL_MODEL,
    displayName: "Kling 首尾帧",
    description: "",
    provider: "metaso",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      videoToVideo: false,
      audio: false,
      firstLastFrame: true,
    },
    limits: {
      maxDuration: 15,
      allowedDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      maxResolution: "1080p",
      maxInputImages: 2,
    },
    params: {
      maxCount: 1,
      params: [
        {
          type: "continuous",
          id: "duration",
          label: "时长",
          min: 4,
          max: 15,
          step: 1,
          values: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          default: 6,
          unit: "s",
        },
      ],
    },
  },
  {
    id: LIMITED_MODEL,
    displayName: "只支持 5/10 秒",
    description: "",
    provider: "test",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      videoToVideo: false,
      audio: false,
    },
    limits: {
      maxDuration: 10,
      allowedDurations: [5, 10],
      maxResolution: "720p",
      maxInputImages: 1,
    },
    params: {
      maxCount: 1,
      params: [
        {
          type: "continuous",
          id: "duration",
          label: "时长",
          min: 5,
          max: 10,
          step: 1,
          values: [5, 10],
          default: 5,
          unit: "s",
        },
      ],
    },
  },
  {
    id: PLAIN_MODEL,
    displayName: "旧模型",
    description: "",
    provider: "test",
    limits: {
      maxDuration: 8,
      allowedDurations: [4, 5, 6, 8],
      maxResolution: "720p",
      maxInputImages: 1,
    },
  },
];

/** A 的时长默认值：面板初始状态（A 的取值表里有它，滑块与状态同值）。 */
const FULL_DURATION = 6;

type RenderOptions = { model?: string; duration?: number; api?: Record<string, unknown> };

function renderPanel(options: RenderOptions = {}) {
  const props = {
    elementId: "el-41e",
    elementBounds: BOUNDS,
    data: {
      type: "video-generator" as const,
      status: "idle" as const,
      prompt: "拍一段海浪",
      model: options.model ?? FULL_MODEL,
      aspectRatio: "16:9",
      duration: options.duration ?? FULL_DURATION,
      resolution: "720p",
    },
    excalidrawApi: options.api ?? NOOP_API,
    accessToken: "token",
    canvasScrollZoom: SCROLL_ZOOM,
    onClose: () => {},
  };
  return render(
    <ToastProvider>
      <VideoGeneratorPanel {...props} />
    </ToastProvider>,
  );
}

/** 打开「参数」气泡（时长滑块 / 旧时长 tab 都渲染在里面）。 */
function openParams() {
  fireEvent.click(screen.getByTestId("canvas-video-generator-params-trigger"));
}

/** 打开模型下拉并点某一个模型。 */
function selectModel(modelId: string) {
  fireEvent.click(screen.getByTestId("canvas-video-generator-model-trigger"));
  fireEvent.click(
    screen.getByTestId(`canvas-video-generator-model-item-${modelId.replace(/\//g, "-")}`),
  );
}

/** 时长滑块的那个 range input。 */
function durationSliderInput(): HTMLElement {
  return within(screen.getByTestId("generator-slider-duration")).getByRole("slider");
}

/** 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  quoteMock.result = {
    price: { status: "estimating" },
    precheck: { ok: true },
  };
  apiMock.fetchVideoModels.mockResolvedValue({ models: MODELS });
  apiMock.submitVideoJob.mockResolvedValue({ jobId: JOB_ID });
  apiMock.fetchPriceQuote.mockResolvedValue({ items: [] });
  apiMockAwait.awaitJobCompletion.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AG-07 视频面板时长与首尾帧（工单 41E）", () => {
  it("AG-07: the duration slider exposes aria values", async () => {
    renderPanel();
    // 等模型列表落地（A 有 duration 参数）
    openParams();
    await screen.findByTestId("generator-slider-duration");

    selectModel(LIMITED_MODEL);

    // 只有 5/10 两档的模型：滑块值域就是 5~10，当前值 = 回落后的默认值 5
    const input = await waitFor(() => {
      const found = durationSliderInput();
      expect(found).toHaveAttribute("aria-valuemin", "5");
      return found;
    });
    expect(input).toHaveAttribute("aria-valuemax", "10");
    expect(input).toHaveAttribute("aria-valuenow", "5");
    // 有 schema 就不再渲染旧的时长 tab
    expect(screen.queryAllByTestId(/^canvas-video-generator-params-duration-/)).toHaveLength(0);
  });

  it("AG-07: a 5s/10s model only lands on 5 or 10", async () => {
    renderPanel();
    openParams();
    await screen.findByTestId("generator-slider-duration");
    selectModel(LIMITED_MODEL);

    const input = await waitFor(() => durationSliderInput());
    fireEvent.change(input, { target: { value: "8" } });

    fireEvent.click(screen.getByTestId("canvas-video-generator-submit"));
    await waitFor(() => expect(apiMock.submitVideoJob).toHaveBeenCalledTimes(1));

    const submitted = apiMock.submitVideoJob.mock.calls[0]?.[2] as { duration?: number };
    expect([5, 10]).toContain(submitted.duration);
    // 8 更靠近 10（距离 2 对 3）→ 吸附到 10
    expect(submitted.duration).toBe(10);
  });

  it("AG-07: first/last frame needs both frames", async () => {
    renderPanel();

    const modeOption = await screen.findByTestId("generator-mode-option-first_last");
    fireEvent.click(modeOption);

    // 只填首帧 → 按钮 disabled，并逐字写出缺什么
    const firstFile = new File(["png-bytes"], "first.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("canvas-video-generator-first-frame-input"), {
      target: { files: [firstFile] },
    });
    await waitFor(() => expect(screen.getByAltText("首帧")).toBeInTheDocument());

    expect(screen.getByTestId("canvas-video-generator-submit")).toBeDisabled();
    expect(
      screen.getByTestId("canvas-video-generator-frames-missing").textContent,
    ).toBe("请补齐首帧和尾帧");

    // 补上尾帧 → 按钮可用
    const lastFile = new File(["png-bytes-2"], "last.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("canvas-video-generator-last-frame-input"), {
      target: { files: [lastFile] },
    });
    await waitFor(() => expect(screen.getByAltText("尾帧")).toBeInTheDocument());

    expect(screen.queryByTestId("canvas-video-generator-frames-missing")).toBeNull();
    expect(screen.getByTestId("canvas-video-generator-submit")).not.toBeDisabled();
  });

  it("AG-07: two selected canvas images prefill in selection order", async () => {
    const prefillApi = {
      // 键顺序 B 先 → B 是首帧
      getAppState: () => ({ selectedElementIds: { imgB: true, imgA: true } }),
      getSceneElements: () => [
        { id: "imgA", type: "image", fileId: "fileA" },
        { id: "imgB", type: "image", fileId: "fileB" },
        { id: "note", type: "text" },
      ],
      getFiles: () => ({ fileA: { dataURL: DATA_A }, fileB: { dataURL: DATA_B } }),
      updateScene: () => {},
      addFiles: () => {},
    };
    renderPanel({ api: prefillApi });

    fireEvent.click(await screen.findByTestId("generator-mode-option-first_last"));

    const first = await screen.findByAltText("首帧");
    expect(first.getAttribute("src")).toBe(DATA_B);
    expect(screen.getByAltText("尾帧").getAttribute("src")).toBe(DATA_A);
  });

  it("AG-07: the option disappears for a model without first/last frames", async () => {
    renderPanel();

    fireEvent.click(await screen.findByTestId("generator-mode-option-first_last"));
    expect(screen.getByTestId("generator-mode-option-first_last")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    selectModel(LIMITED_MODEL);

    // B 不收首尾帧：整组消失，缺帧提示不存在，按钮不因帧缺失 disabled
    await waitFor(() =>
      expect(screen.queryByTestId("generator-mode-option-first_last")).toBeNull(),
    );
    expect(screen.queryByTestId("canvas-video-generator-frames-missing")).toBeNull();
    expect(screen.getByTestId("canvas-video-generator-submit")).not.toBeDisabled();
  });

  it("a model without params keeps the old duration tabs", async () => {
    renderPanel({ model: PLAIN_MODEL, duration: 4 });
    openParams();

    await screen.findByTestId("canvas-video-generator-params-duration-4");
    expect(screen.queryByTestId("generator-slider-duration")).toBeNull();
    expect(screen.getByTestId("canvas-video-generator-params-duration-8")).toBeInTheDocument();
    // 没有 firstLastFrame 的模型不出现「生成方式」
    expect(screen.queryByTestId("generator-mode-option-first_last")).toBeNull();
  });
});
