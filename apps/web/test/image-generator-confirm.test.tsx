import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

import type { ImageModelInfo } from "../src/lib/server-api";
import { ApiApplicationError } from "../src/lib/server-api";

/**
 * 工单 41H：画布图像面板多张提交合计超门槛时出确认卡（AG-10 / AG-07 · T-122）。
 *
 * 面板这一侧只做四件事：
 *   1) 提交撞上 409 `confirmation_required` → 摆确认卡，卡上的数字就是服务端给的
 *      那一组（用户点「确认生成」之后金额不会再算一遍，两次请求必须同一组参数）；
 *   2) 「确认生成」→ 同一组参数再提交一次，只多一个 `confirmed: true`；
 *   3) 「取消」→ 一张都不提交，面板回到可编辑状态；
 *   4) 其他错误仍走原来的错误路径，确认卡不出现。
 *
 * 网络、询价与等待都换成替身（写法同 `image-generator-params.test.tsx`）：本单验的
 * 是面板怎么用那个 409，服务端怎么发出来由 server 侧与 `server-api` 的测试覆盖。
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

/**
 * 旧错误路径换成替身：本单只需要知道它有没有被调用（确认卡的 409 不该走它）。
 * 返回值沿用真实 hook 的口径：`false` = 没处理完，调用方自己显示错误行。
 */
const handlerMock = vi.hoisted(() => ({
  handleGenerationError: vi.fn((_error: unknown): boolean => false),
}));
vi.mock("../src/hooks/use-generation-error-handler", () => ({
  useGenerationErrorHandler: () => ({
    handleGenerationError: handlerMock.handleGenerationError,
  }),
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

// --- 询价 hook 换成替身：额度够、价格有，本单不验询价 ------------------------
const quoteMock = vi.hoisted(() => ({
  result: { price: null as unknown, precheck: null as unknown },
}));

vi.mock("@/hooks/use-generation-quote", () => ({
  GENERATION_QUOTE_DEBOUNCE_MS: 300,
  useGenerationQuote: () => quoteMock.result,
}));

import { ToastProvider } from "../src/components/toast";
import { ImageGeneratorPanel } from "../src/components/canvas/image-generator-panel";

const GPT_MODEL = "kwjm/gpt-image-2";
const BOUNDS = { x: 0, y: 0, width: 300, height: 200 };
const SCROLL_ZOOM = { scrollX: 0, scrollY: 0, zoom: 1 };

/** GPT Image 2 允许 1–10 张，尺寸走 schema 的 `size` 参数（默认 1:1）。 */
const MODELS: ImageModelInfo[] = [
  {
    id: GPT_MODEL,
    displayName: "GPT Image 2",
    description: "",
    provider: "kwjm",
    params: {
      maxCount: 10,
      params: [
        {
          type: "discrete",
          id: "size",
          label: "尺寸",
          default: "1:1",
          options: [
            { value: "1:1", label: "1:1", tier: "standard" as const },
            { value: "16:9-4k", label: "16:9 · 4K", tier: "ultra" as const },
          ],
        },
      ],
    },
  },
];

/** 41F 的 409 体：`confirmation` 是这一批的原始参数，`error.message` 是英文。 */
const CONFIRMATION_BODY = {
  error: {
    code: "confirmation_required",
    message: "Confirmation required: 10 images cost 80 credits",
  },
  confirmation: {
    jobType: "image_generation",
    model: GPT_MODEL,
    count: 10,
    creditsCost: 80,
    prompt: "cat",
    size: "1:1",
  },
};

function overThreshold(): ApiApplicationError {
  return new ApiApplicationError(
    "confirmation_required",
    "Confirmation required: 10 images cost 80 credits",
    409,
    CONFIRMATION_BODY,
  );
}

function renderPanel() {
  const data = {
    type: "image-generator" as const,
    status: "idle" as const,
    prompt: "cat",
    model: GPT_MODEL,
    aspectRatio: "1:1",
    quality: "hd",
  };
  return render(
    <ToastProvider>
      <ImageGeneratorPanel
        elementId="el-1"
        elementBounds={BOUNDS}
        data={data}
        excalidrawApi={NOOP_API}
        accessToken="token"
        canvasScrollZoom={SCROLL_ZOOM}
        onClose={() => {}}
      />
    </ToastProvider>,
  );
}

const NOOP_API = {
  getSceneElements: () => [],
  updateScene: () => {},
  addFiles: () => {},
};

/** 一个真的会存下 `updateScene` 的场景，用来读占位元素的状态。 */
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
      version: 1,
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
    statusOf: (id: string): string | undefined =>
      elements.find((el) => el.id === id)?.customData?.status,
    placeholders: () =>
      elements.filter(
        (el) => el.customData?.type === "image-generator" && !el.isDeleted,
      ),
  };
}

function renderWithScene(api: unknown) {
  const data = {
    type: "image-generator" as const,
    status: "idle" as const,
    prompt: "cat",
    model: GPT_MODEL,
    aspectRatio: "1:1",
    quality: "hd",
  };
  return render(
    <ToastProvider>
      <ImageGeneratorPanel
        elementId="el-1"
        elementBounds={BOUNDS}
        data={data}
        excalidrawApi={api}
        accessToken="token"
        canvasScrollZoom={SCROLL_ZOOM}
        onClose={() => {}}
      />
    </ToastProvider>,
  );
}

/** 选中 10 张，再点提交。返回时第一次提交已经发出。 */
async function submitTen(): Promise<void> {
  fireEvent.click(await screen.findByTestId("generator-count-option-10"));
  fireEvent.click(screen.getByTestId("canvas-image-generator-submit"));
}

/** 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  quoteMock.result = {
    price: { status: "priced", amount: 80 },
    precheck: { ok: true },
  };
  apiMock.fetchImageModels.mockResolvedValue({ models: MODELS });
  apiMock.fetchPriceQuote.mockResolvedValue({ items: [] });
  apiMockAwait.awaitJobCompletion.mockImplementation(() => new Promise(() => {}));
  handlerMock.handleGenerationError.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AG-10 画布面板的门槛确认卡（工单 41H）", () => {
  it("AG-10: an over-threshold batch shows the confirm card instead of an error", async () => {
    apiMock.submitImageJob.mockRejectedValueOnce(overThreshold());
    const scene = sceneApi();
    renderWithScene(scene.api);

    await submitTen();

    const card = await screen.findByTestId("chat-confirm-card");
    expect(card).toHaveTextContent("生成 10 张");
    expect(card).toHaveTextContent("消耗 80 分");
    expect(screen.getByTestId("chat-confirm-card-ok")).toHaveTextContent(
      "确认生成 · 80",
    );
    // 409 是「问一句」：旧错误路径没有被调用，占位也没被标成失败。
    expect(handlerMock.handleGenerationError).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-confirm-card-error")).toBeNull();
    await waitFor(() => expect(scene.statusOf("el-1")).toBe("idle"));
    expect(screen.getByTestId("canvas-generator-prompt")).not.toBeDisabled();
  });

  it("AG-10: confirming submits again with confirmed: true", async () => {
    const jobIds = Array.from({ length: 10 }, (_, i) => `job-${i}`);
    apiMock.submitImageJob
      .mockRejectedValueOnce(overThreshold())
      .mockResolvedValue({ jobId: "job-0", jobIds });
    const scene = sceneApi();
    renderWithScene(scene.api);

    await submitTen();
    fireEvent.click(await screen.findByTestId("chat-confirm-card-ok"));

    await waitFor(() => expect(apiMock.submitImageJob).toHaveBeenCalledTimes(2));
    // 第二次是同一组参数 + confirmed：数量与尺寸跟第一次撞门槛的那次一致。
    expect(apiMock.submitImageJob.mock.calls[1]?.[2]).toMatchObject({
      confirmed: true,
      count: 10,
      size: "1:1",
    });
    await waitFor(() => expect(screen.queryByTestId("chat-confirm-card")).toBeNull());
  });

  it("AG-10: cancelling submits nothing", async () => {
    apiMock.submitImageJob.mockRejectedValueOnce(overThreshold());
    renderPanel();

    await submitTen();
    fireEvent.click(await screen.findByTestId("chat-confirm-card-cancel"));

    await waitFor(() => expect(screen.queryByTestId("chat-confirm-card")).toBeNull());
    expect(apiMock.submitImageJob).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("canvas-generator-prompt")).not.toBeDisabled();
  });

  it("other errors keep the old path", async () => {
    apiMock.submitImageJob.mockRejectedValueOnce(
      new ApiApplicationError("insufficient_credits", "not enough credits", 402),
    );
    renderPanel();

    fireEvent.click(await screen.findByTestId("canvas-image-generator-submit"));

    await waitFor(() =>
      expect(handlerMock.handleGenerationError).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByTestId("chat-confirm-card")).toBeNull();
  });
});
