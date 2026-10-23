import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

import type { ImageModelInfo } from "../src/lib/server-api";

/**
 * 工单 41D：图片生成面板按服务端下发的参数 schema 渲染（AG-07 图像侧）。
 *
 * 面板这一侧只做四件事：
 *   1) `currentModel.params` 存在 → 渲染 `GeneratorParamControls`，**不渲染**旧的
 *      质量 / 比例下拉；只有 schema 下发的选项，前端不补任何组合；
 *   2) 进一个模型（首次选中 / 切换模型）就把参数值重置为该模型的默认值；
 *   3) 询价与提交的请求体来自所选参数：`size` 参数的取值 → `size`，该选项的
 *      `tier` → `quality`；带 `size` 时**不发** `aspectRatio`（服务端按 size
 *      自行推比例，shared 的比例枚举里也没有 3:2 / 2:3）；
 *   4) `currentModel.params` 不存在 → 与改动前完全一致（旧下拉、旧 testid）。
 *
 * 询价 hook 与 39A 的 precheck 测试一样换成替身：本单验的是面板交给询价的是什么，
 * 防抖 / 五态由 `use-generation-quote` 自己的测试覆盖；替身同时记录每次实参。
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
  fetchImageModels: vi.fn(),
  submitImageJob: vi.fn(),
  fetchPriceQuote: vi.fn(),
}));

vi.mock("../src/lib/server-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/server-api")>();
  return {
    ...actual,
    fetchImageModels: apiMock.fetchImageModels,
    submitImageJob: apiMock.submitImageJob,
    fetchPriceQuote: apiMock.fetchPriceQuote,
  };
});

const apiMockAwait = vi.hoisted(() => ({ awaitJobCompletion: vi.fn() }));
vi.mock("../src/lib/await-job", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/await-job")>();
  return { ...actual, awaitJobCompletion: apiMockAwait.awaitJobCompletion };
});

// --- 询价 hook 换成替身：直接控制 price / precheck，并记录每次的实参 -----------
type QuoteCall = { token: unknown; input: unknown; available: unknown };

const quoteMock = vi.hoisted(() => ({
  calls: [] as QuoteCall[],
  result: { price: null as unknown, precheck: null as unknown },
}));

vi.mock("@/hooks/use-generation-quote", () => ({
  GENERATION_QUOTE_DEBOUNCE_MS: 300,
  useGenerationQuote: (token: unknown, input: unknown, available: unknown) => {
    quoteMock.calls.push({ token, input, available });
    return quoteMock.result;
  },
}));

import { ToastProvider } from "../src/components/toast";
import { ImageGeneratorPanel } from "../src/components/canvas/image-generator-panel";

const JOB_ID = "job-img-1";
const BOUNDS = { x: 0, y: 0, width: 300, height: 200 };
const SCROLL_ZOOM = { scrollX: 0, scrollY: 0, zoom: 1 };
const NOOP_API = {
  getSceneElements: () => [],
  updateScene: () => {},
  addFiles: () => {},
};

/** 三个模型：GPT Image 2（7 档 size，带计价档）、Flux Kontext（5 档比例）、无 schema。 */
const GPT_MODEL = "kwjm/gpt-image-2";
const FLUX_MODEL = "black-forest-labs/flux-kontext-pro";
const PLAIN_MODEL = "test/no-params";

/** 41A 下发的 7 档（看的是「不出现 schema 里没有的组合」，所以这里抄的是同一组值）。 */
const GPT_SIZES = [
  { value: "1:1", label: "1:1", tier: "standard" as const },
  { value: "3:2", label: "3:2", tier: "standard" as const },
  { value: "2:3", label: "2:3", tier: "standard" as const },
  { value: "1:1-2k", label: "1:1 · 2K", tier: "hd" as const },
  { value: "16:9-2k", label: "16:9 · 2K", tier: "hd" as const },
  { value: "16:9-4k", label: "16:9 · 4K", tier: "ultra" as const },
  { value: "9:16-4k", label: "9:16 · 4K", tier: "ultra" as const },
];

const FLUX_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"].map((value) => ({
  value,
  label: value,
}));

const QUALITY_TIERS = [
  { key: "standard" as const, output: "1K", label: "1K" },
  { key: "hd" as const, output: "2K", label: "2K" },
  { key: "ultra" as const, output: "4K", label: "4K" },
];

const MODELS: ImageModelInfo[] = [
  {
    id: GPT_MODEL,
    displayName: "GPT Image 2",
    description: "",
    provider: "kwjm",
    quality: QUALITY_TIERS,
    params: {
      maxCount: 1,
      params: [
        { type: "discrete", id: "size", label: "尺寸", default: "1:1", options: GPT_SIZES },
      ],
    },
  },
  {
    id: FLUX_MODEL,
    displayName: "Flux Kontext",
    description: "",
    provider: "black-forest-labs",
    params: {
      maxCount: 1,
      params: [
        {
          type: "discrete",
          id: "aspectRatio",
          label: "比例",
          default: "1:1",
          options: FLUX_RATIOS,
        },
      ],
    },
  },
  {
    id: PLAIN_MODEL,
    displayName: "Plain Model",
    description: "",
    provider: "test",
  },
];

type RenderOptions = { model?: string; availableCredits?: number };

function renderPanel(options: RenderOptions = {}) {
  const data = {
    type: "image-generator" as const,
    status: "idle" as const,
    prompt: "cat",
    model: options.model ?? GPT_MODEL,
    aspectRatio: "1:1",
    quality: "hd",
  };
  const props = {
    elementId: "el-1",
    elementBounds: BOUNDS,
    data,
    excalidrawApi: NOOP_API,
    accessToken: "token",
    canvasScrollZoom: SCROLL_ZOOM,
    onClose: () => {},
    // `exactOptionalPropertyTypes` 下不能显式传 undefined：不传就整个不带这个键。
    ...(options.availableCredits === undefined
      ? {}
      : { availableCredits: options.availableCredits }),
  };
  return render(
    <ToastProvider>
      <ImageGeneratorPanel {...props} />
    </ToastProvider>,
  );
}

/** 最后一次渲染时面板交给询价 hook 的实参（= 这次询价要发的请求体）。 */
function lastQuoteCall(): QuoteCall | undefined {
  return quoteMock.calls[quoteMock.calls.length - 1];
}

/** 打开模型下拉并点某一个模型。 */
function selectModel(modelId: string) {
  fireEvent.click(screen.getByTestId("canvas-image-generator-model-trigger"));
  fireEvent.click(
    screen.getByTestId(`canvas-image-generator-model-item-${modelId.replace(/\//g, "-")}`),
  );
}

/** 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  quoteMock.calls = [];
  quoteMock.result = {
    price: { status: "priced", amount: 10 },
    precheck: { ok: true },
  };
  apiMock.fetchImageModels.mockResolvedValue({ models: MODELS });
  apiMock.submitImageJob.mockResolvedValue({ jobId: JOB_ID });
  apiMock.fetchPriceQuote.mockResolvedValue({ items: [] });
  apiMockAwait.awaitJobCompletion.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AG-07 图像生成面板按服务端参数渲染（工单 41D）", () => {
  it("AG-07: GPT Image 2 shows exactly the seven sizes", async () => {
    renderPanel({ availableCredits: 100 });

    const options = await screen.findAllByTestId(/^generator-size-option-/);
    expect(options).toHaveLength(7);
    // 只有 schema 下发的项，前端不造 schema 里没有的组合
    expect(screen.queryByTestId("generator-size-option-3:2-4k")).toBeNull();
    // 有 schema 就不再用旧的质量 / 比例下拉
    expect(screen.queryByTestId("canvas-image-generator-ratio-trigger")).toBeNull();
    expect(screen.queryByTestId("canvas-image-generator-quality-trigger")).toBeNull();
  });

  it("AG-07: Flux shows one aspect-ratio group", async () => {
    renderPanel({ availableCredits: 100 });
    await screen.findByTestId("generator-size-option-1:1");

    selectModel(FLUX_MODEL);

    const options = await screen.findAllByTestId(/^generator-aspectRatio-option-/);
    expect(options).toHaveLength(5);
    expect(screen.queryAllByTestId(/^generator-size/)).toHaveLength(0);
  });

  it("AG-07: picking 16:9 · 4K quotes and submits at the ultra tier with the size", async () => {
    renderPanel({ availableCredits: 100 });

    fireEvent.click(await screen.findByTestId("generator-size-option-16:9-4k"));

    // 询价：档位取所选项的 tier，尺寸原样带上；带 size 就不发 aspectRatio
    expect(lastQuoteCall()?.input).toEqual({
      kind: "image_generation",
      request: {
        prompt: "cat",
        model: GPT_MODEL,
        quality: "ultra",
        size: "16:9-4k",
      },
    });

    fireEvent.click(screen.getByTestId("canvas-image-generator-submit"));
    await waitFor(() => expect(apiMock.submitImageJob).toHaveBeenCalledTimes(1));

    const submittedOptions = apiMock.submitImageJob.mock.calls[0]?.[2];
    expect(submittedOptions).toMatchObject({
      size: "16:9-4k",
      quality: "ultra",
    });
    expect("aspectRatio" in (submittedOptions as Record<string, unknown>)).toBe(false);
  });

  it("AG-07: the 3:2 size is sent as a size, never as an aspect ratio", async () => {
    renderPanel({ availableCredits: 100 });

    fireEvent.click(await screen.findByTestId("generator-size-option-3:2"));

    // 询价：`3:2` 原样当 size 发，质量取 standard，且请求体里没有 aspectRatio 键
    // （shared 的 `generateImageRequestSchema.aspectRatio` 只收 1:1 / 16:9 / 9:16 /
    // 4:3 / 3:4，带上 3:2 会被服务端 400）。
    const quoteCall = lastQuoteCall();
    const quoteRequest = (quoteCall?.input as { request: Record<string, unknown> })
      .request;
    expect(quoteRequest.size).toBe("3:2");
    expect(quoteRequest.quality).toBe("standard");
    expect("aspectRatio" in quoteRequest).toBe(false);

    fireEvent.click(screen.getByTestId("canvas-image-generator-submit"));
    await waitFor(() => expect(apiMock.submitImageJob).toHaveBeenCalledTimes(1));

    const submittedOptions = apiMock.submitImageJob.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(submittedOptions.size).toBe("3:2");
    expect(submittedOptions.quality).toBe("standard");
    expect("aspectRatio" in submittedOptions).toBe(false);
  });

  it("AG-07: switching model falls back to the new model's default", async () => {
    renderPanel({ availableCredits: 100 });

    fireEvent.click(await screen.findByTestId("generator-size-option-9:16-4k"));
    expect(screen.getByTestId("generator-size-option-9:16-4k")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    selectModel(FLUX_MODEL);
    await screen.findByTestId("generator-aspectRatio-option-1:1");

    selectModel(GPT_MODEL);
    const backToOne = await screen.findByTestId("generator-size-option-1:1");
    expect(backToOne).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("generator-size-option-9:16-4k")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("a model without params keeps the old dropdowns", async () => {
    renderPanel({ model: PLAIN_MODEL, availableCredits: 100 });

    await screen.findByTestId("canvas-image-generator-ratio-trigger");
    expect(screen.queryAllByTestId(/^generator-/)).toHaveLength(0);
  });
});


describe("AG-07 张数控件与多占位（工单 41G）", () => {
  /** GPT Image 2 offering 10 images; Flux stays at 1; the plain model has no params. */
  function withTenImages(): ImageModelInfo[] {
    return MODELS.map((model) =>
      model.id === GPT_MODEL && model.params
        ? { ...model, params: { ...model.params, maxCount: 10 } }
        : model,
    );
  }

  /** A scene that actually stores what updateScene gives it. */
  function sceneApi() {
    let elements: any[] = [
      {
        id: "el-1",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        isDeleted: false,
        customData: {
          type: "image-generator",
          status: "idle",
          prompt: "cat",
          model: GPT_MODEL,
          aspectRatio: "1:1",
          quality: "hd",
        },
      },
    ];
    const updateScene = vi.fn((scene: { elements: any[] }) => {
      elements = scene.elements;
    });
    return {
      api: { getSceneElements: () => elements, updateScene, addFiles: () => {} },
      updateScene,
      placeholders: () =>
        elements.filter((el) => el.customData?.type === "image-generator" && !el.isDeleted),
    };
  }

  function renderWithApi(api: unknown) {
    const props = {
      elementId: "el-1",
      elementBounds: BOUNDS,
      data: {
        type: "image-generator" as const,
        status: "idle" as const,
        prompt: "cat",
        model: GPT_MODEL,
        aspectRatio: "1:1",
        quality: "hd",
      },
      excalidrawApi: api,
      accessToken: "token",
      canvasScrollZoom: SCROLL_ZOOM,
      onClose: () => {},
      availableCredits: 100,
    };
    return render(
      <ToastProvider>
        <ImageGeneratorPanel {...props} />
      </ToastProvider>,
    );
  }

  it("AG-07: GPT Image 2 offers 1 to 10 images", async () => {
    apiMock.fetchImageModels.mockResolvedValue({ models: withTenImages() });
    renderPanel({ availableCredits: 100 });

    const options = await screen.findAllByTestId(/^generator-count-option-/);
    expect(options).toHaveLength(10);
    for (let n = 1; n <= 10; n++) {
      expect(screen.getByTestId(`generator-count-option-${n}`)).toBeInTheDocument();
    }
  });

  it("AG-07: a model without params has no count control", async () => {
    apiMock.fetchImageModels.mockResolvedValue({ models: withTenImages() });
    renderPanel({ model: PLAIN_MODEL, availableCredits: 100 });

    await screen.findByTestId("canvas-image-generator-ratio-trigger");
    expect(screen.queryAllByTestId(/^generator-count-/)).toHaveLength(0);
  });

  it("AG-07 acceptance 2: choosing 10 quotes with count 10", async () => {
    apiMock.fetchImageModels.mockResolvedValue({ models: withTenImages() });
    renderPanel({ availableCredits: 100 });

    fireEvent.click(await screen.findByTestId("generator-count-option-10"));

    const request = (lastQuoteCall()?.input as { request: Record<string, unknown> }).request;
    expect(request.count).toBe(10);
  });

  it("AG-07: ten images draw ten placeholders", async () => {
    apiMock.fetchImageModels.mockResolvedValue({ models: withTenImages() });
    const jobIds = Array.from({ length: 10 }, (_, i) => `job-${i}`);
    apiMock.submitImageJob.mockResolvedValue({ jobId: "job-0", jobIds });
    const scene = sceneApi();
    renderWithApi(scene.api);

    fireEvent.click(await screen.findByTestId("generator-count-option-10"));
    fireEvent.click(screen.getByTestId("canvas-image-generator-submit"));

    await waitFor(() => expect(apiMock.submitImageJob).toHaveBeenCalledTimes(1));
    expect(apiMock.submitImageJob.mock.calls[0]?.[2]).toMatchObject({ count: 10 });
    await waitFor(() => expect(scene.placeholders()).toHaveLength(10));
  });

  it("count 1 keeps the single-job path", async () => {
    apiMock.fetchImageModels.mockResolvedValue({ models: withTenImages() });
    const scene = sceneApi();
    renderWithApi(scene.api);

    await screen.findByTestId("generator-count-option-1");
    expect(
      (lastQuoteCall()?.input as { request: Record<string, unknown> }).request,
    ).not.toHaveProperty("count");

    fireEvent.click(screen.getByTestId("canvas-image-generator-submit"));
    await waitFor(() => expect(apiMock.submitImageJob).toHaveBeenCalledTimes(1));

    const submitted = apiMock.submitImageJob.mock.calls[0]?.[2] as Record<string, unknown>;
    expect("count" in submitted).toBe(false);
    expect(scene.placeholders()).toHaveLength(1);
  });
});