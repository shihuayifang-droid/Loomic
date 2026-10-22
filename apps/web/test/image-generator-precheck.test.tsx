import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

/**
 * 工单 39A：图片生成器面板「提交前显示价格、额度不足时禁用并写原因」（T-109 / BL-45）。
 *
 * 面板这一侧只做四件事：
 *   1) 宿主传了 `availableCredits` 才询价，不传就整块关掉（不发请求、不显示价格）；
 *   2) 询价请求体的参数跟面板当前状态一致（prompt / 模型 / 比例 / 档位）；
 *   3) 预检不过时按钮 disabled，并在按钮上方逐字写清「差多少」；
 *   4) 预检不过时 `handleGenerate` 直接返回 —— 键盘 Enter 也绕过不去。
 *
 * 询价 hook 换成替身：本单验的是面板的接线与文案，`use-generation-quote` 自己的
 * 防抖 / 五态由它自己的测试覆盖；替身同时记录每次收到的实参，用来钉住
 * 「不传 availableCredits 时第二个实参必须是 null」这件事。
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
  /** 每次渲染时面板传给 hook 的三个实参（询问价用的是第二个） */
  calls: [] as QuoteCall[],
  /** 本次用例要让 hook 返回什么 */
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

/** 面板的默认参数：模型 / 比例 / 档位都取这里的值，用例据此断言询价请求体。 */
const DEFAULT_MODEL = "test/model";
const DEFAULT_RATIO = "1:1";
const DEFAULT_QUALITY = "hd";

type RenderOptions = { availableCredits?: number; prompt?: string };

function renderPanel(options: RenderOptions = {}) {
  const data = {
    type: "image-generator" as const,
    status: "idle" as const,
    prompt: options.prompt ?? "cat",
    model: DEFAULT_MODEL,
    aspectRatio: DEFAULT_RATIO,
    quality: DEFAULT_QUALITY,
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

/** 最后一次渲染时面板交给 hook 的实参。 */
function lastQuoteCall(): QuoteCall | undefined {
  return quoteMock.calls[quoteMock.calls.length - 1];
}

const REASON = "积分不足：本次需要 120，当前可用 100";

/** 预检不过时的 hook 返回值（T-109 的核心场景）。 */
function insufficient() {
  quoteMock.result = {
    price: { status: "priced", amount: 120 },
    precheck: { ok: false, reason: "insufficient", required: 120, available: 100 },
  };
}

/** 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  // 每个用例从「没有额度问题」开始，要用预检不过的用例自己调 insufficient()
  quoteMock.calls = [];
  quoteMock.result = {
    price: { status: "estimating" },
    precheck: { ok: true },
  };
  apiMock.fetchImageModels.mockResolvedValue({ models: [] });
  apiMock.submitImageJob.mockResolvedValue({ jobId: JOB_ID });
  apiMock.fetchPriceQuote.mockResolvedValue({ items: [] });
  apiMockAwait.awaitJobCompletion.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("T-109 / BL-45 图片面板提交前预检（工单 39A）", () => {
  it("T-109: the panel shows the price before submit", async () => {
    quoteMock.result = {
      price: { status: "priced", amount: 12 },
      precheck: { ok: true },
    };
    renderPanel({ availableCredits: 100 });

    const tag = await screen.findByTestId("price-tag");
    expect(tag.textContent).toContain("12");
    expect(screen.getByTestId("canvas-image-generator-submit")).not.toBeDisabled();
    // 额度够，就不该有那行原因
    expect(screen.queryByTestId("canvas-image-generator-precheck")).toBeNull();
  });

  it("T-109: not enough credits disables submit with the reason", () => {
    insufficient();
    renderPanel({ availableCredits: 100 });

    const submit = screen.getByTestId("canvas-image-generator-submit");
    expect(submit).toBeDisabled();
    expect(screen.getByTestId("canvas-image-generator-precheck").textContent).toBe(REASON);
    // 悬停与读屏也要拿得到同一条原因
    expect(submit.getAttribute("title")).toBe(REASON);
    expect(submit.getAttribute("aria-label")).toBe(REASON);
  });

  it("T-109: Enter does not bypass the precheck", () => {
    insufficient();
    renderPanel({ availableCredits: 100 });

    fireEvent.keyDown(screen.getByTestId("canvas-generator-prompt"), {
      key: "Enter",
      shiftKey: false,
    });

    // 按钮 disabled 挡不住回车，提交函数自己也要拦
    expect(apiMock.submitImageJob).toHaveBeenCalledTimes(0);
  });

  it("T-109: without availableCredits the panel does not quote", () => {
    renderPanel();

    // 不传额度 = 不能询价：hook 的第二个实参必须是 null（不发请求）
    expect(lastQuoteCall()?.input).toBeNull();
    expect(lastQuoteCall()?.available).toBeNull();
    // 没有价格徽标
    expect(screen.queryByTestId("price-tag")).toBeNull();
    // 按钮行为同今天：有 prompt 就能点
    expect(screen.getByTestId("canvas-image-generator-submit")).not.toBeDisabled();
  });

  it("T-109: the quote input follows the panel parameters", () => {
    renderPanel({ availableCredits: 100, prompt: "" });
    // prompt 为空时不询价
    expect(lastQuoteCall()?.input).toBeNull();

    fireEvent.change(screen.getByTestId("canvas-generator-prompt"), {
      target: { value: "cat" },
    });

    expect(lastQuoteCall()?.input).toEqual({
      kind: "image_generation",
      request: {
        prompt: "cat",
        model: DEFAULT_MODEL,
        aspectRatio: DEFAULT_RATIO,
        quality: DEFAULT_QUALITY,
      },
    });
    expect(lastQuoteCall()?.available).toBe(100);
  });
});
