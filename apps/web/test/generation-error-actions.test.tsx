import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

/**
 * 工单 30C T2 + T3：错误目录的入口按钮、handler 的分类接线、两个生成面板的接线，
 * 以及 X-05 的验收点（图像/视频两个 prompt 输入框 testid 相同、用 data-mode 区分）。
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

/** tier toast 有 Next router 依赖，这条单只关心「有没有走 tier 分支」，换成 spy。 */
const tierMock = vi.hoisted(() => ({ showTierLimit: vi.fn() }));
vi.mock("@/components/credits/tier-limit-toast", () => ({
  useTierLimitToast: () => ({ showTierLimit: tierMock.showTierLimit }),
}));

// --- server-api：保留真类（instanceof 要用），只把网络函数换成 spy -----------
const apiMock = vi.hoisted(() => ({
  fetchImageModels: vi.fn(),
  generateImageDirect: vi.fn(),
  fetchVideoModels: vi.fn(),
  submitVideoJob: vi.fn(),
}));
vi.mock("../src/lib/server-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/server-api")>();
  return { ...actual, ...apiMock };
});

import { ToastProvider } from "../src/components/toast";
import { ImageGeneratorPanel } from "../src/components/canvas/image-generator-panel";
import { VideoGeneratorPanel } from "../src/components/canvas/video-generator-panel";
import { useGenerationErrorHandler } from "../src/hooks/use-generation-error-handler";
import { JobFailed } from "../src/lib/await-job";
import { APP_ERROR_CATALOG, lookupError } from "../src/lib/error-catalog";
import { ApiApplicationError } from "../src/lib/server-api";

const Wrapper = ({ children }: { children: ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);

function handlerWith(actions?: {
  editParams?: () => void;
  retry?: () => void;
}) {
  const { result } = renderHook(
    () => useGenerationErrorHandler(actions),
    { wrapper: Wrapper },
  );
  return result.current.handleGenerationError;
}

/** 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  apiMock.fetchImageModels.mockResolvedValue({ models: [] });
  apiMock.fetchVideoModels.mockResolvedValue({ models: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useGenerationErrorHandler 按目录类别出入口（T2）", () => {
  it("invalid_request + editParams：按钮写「修改参数」，点击回调被调用", () => {
    const editParams = vi.fn();
    const handle = handlerWith({ editParams });

    let handled = false;
    act(() => {
      handled = handle(new ApiApplicationError("invalid_request", "bad params", 400));
    });

    expect(handled).toBe(false);
    const action = screen.getByTestId("toast-action");
    expect(action).toHaveTextContent("修改参数");
    expect(screen.getByTestId("toast-item")).toHaveTextContent(
      APP_ERROR_CATALOG.invalid_request.message,
    );

    fireEvent.click(action);
    expect(editParams).toHaveBeenCalledTimes(1);
  });

  it("JobFailed(timeout) + retry：按钮写「稍后重试」", () => {
    const retry = vi.fn();
    const handle = handlerWith({ retry });

    act(() => {
      handle(new JobFailed("job-1", "timeout", "upstream 504"));
    });

    const action = screen.getByTestId("toast-action");
    expect(action).toHaveTextContent("稍后重试");
    fireEvent.click(action);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("没有对应回调时只显示文案，不显示按钮", () => {
    // user_fixable 的条目 + 只给了 retry（不给 editParams）
    const handle = handlerWith({ retry: vi.fn() });

    act(() => {
      handle(new ApiApplicationError("invalid_request", "bad params", 400));
    });

    expect(screen.getByTestId("toast-item")).toHaveTextContent(
      APP_ERROR_CATALOG.invalid_request.message,
    );
    expect(screen.queryByTestId("toast-action")).toBeNull();
  });

  it("完全没有 actions 时也不显示按钮（旧调用形态保持不变）", () => {
    const handle = handlerWith();

    act(() => {
      handle(new JobFailed("job-1", "upstream_busy", "busy"));
    });

    expect(screen.queryByTestId("toast-action")).toBeNull();
    expect(screen.getByTestId("toast-item")).toBeInTheDocument();
  });

  it("insufficient_credits 仍返回 true，且不显示任何 toast", () => {
    const handle = handlerWith({ editParams: vi.fn(), retry: vi.fn() });

    let handled = false;
    act(() => {
      handled = handle(new ApiApplicationError("insufficient_credits", "no credits", 402));
    });

    expect(handled).toBe(true);
    expect(screen.queryByTestId("toast-item")).toBeNull();
    expect(tierMock.showTierLimit).not.toHaveBeenCalled();
  });

  it("TIER 码仍走 tier toast，不发普通 toast", () => {
    const handle = handlerWith({ editParams: vi.fn(), retry: vi.fn() });

    let handled = false;
    act(() => {
      handled = handle(new ApiApplicationError("concurrency_limit", "limit reached", 429));
    });

    expect(handled).toBe(true);
    expect(tierMock.showTierLimit).toHaveBeenCalledWith({
      code: "concurrency_limit",
      message: "limit reached",
    });
    expect(screen.queryByTestId("toast-item")).toBeNull();
  });

  it("未知错误显示 service 文案，有 retry 回调时带重试入口", () => {
    const retry = vi.fn();
    const handle = handlerWith({ retry });

    act(() => {
      handle(new Error("kaboom"));
    });

    expect(screen.getByTestId("toast-item")).toHaveTextContent(
      lookupError(undefined).message,
    );
    expect(screen.getByTestId("toast-action")).toHaveTextContent("稍后重试");
  });

  it("quota 类（非 insufficient_credits、非 tier 码）没有入口按钮", () => {
    const handle = handlerWith({ editParams: vi.fn(), retry: vi.fn() });

    act(() => {
      handle(new ApiApplicationError("personal_cap_reached", "cap", 429));
    });

    expect(screen.getByTestId("toast-item")).toHaveTextContent(
      lookupError("personal_cap_reached").message,
    );
    expect(screen.queryByTestId("toast-action")).toBeNull();
  });
});

// --- T3 + X-05：两个生成面板 ------------------------------------------------

const BOUNDS = { x: 0, y: 0, width: 300, height: 200 };
const SCROLL_ZOOM = { scrollX: 0, scrollY: 0, zoom: 1 };
const NOOP_API = { getSceneElements: () => [], updateScene: () => {}, addFiles: () => {} };

function renderImagePanel() {
  return render(
    <ToastProvider>
      <ImageGeneratorPanel
        elementId="el-1"
        elementBounds={BOUNDS}
        data={{
          type: "image-generator",
          status: "idle",
          prompt: "画一只猫",
          model: "test/model",
          aspectRatio: "1:1",
          quality: "hd",
        }}
        excalidrawApi={NOOP_API}
        accessToken="token"
        canvasScrollZoom={SCROLL_ZOOM}
        onClose={() => {}}
      />
    </ToastProvider>,
  );
}

function renderVideoPanel() {
  return render(
    <ToastProvider>
      <VideoGeneratorPanel
        elementId="el-2"
        elementBounds={BOUNDS}
        data={{
          type: "video-generator",
          status: "idle",
          prompt: "拍一段海浪",
          model: "test/model",
          aspectRatio: "16:9",
          duration: 4,
          resolution: "720p",
        }}
        excalidrawApi={NOOP_API}
        accessToken="token"
        canvasScrollZoom={SCROLL_ZOOM}
        onClose={() => {}}
      />
    </ToastProvider>,
  );
}

describe("X-05 验收：图像/视频的 prompt 输入框 testid 相同、data-mode 区分", () => {
  it("图像面板：canvas-generator-prompt + data-mode=image", () => {
    renderImagePanel();

    const prompt = screen.getByTestId("canvas-generator-prompt");
    expect(prompt.tagName).toBe("TEXTAREA");
    expect(prompt).toHaveAttribute("data-mode", "image");
    expect(prompt).toHaveValue("画一只猫");
  });

  it("视频面板：同一个 testid + data-mode=video", () => {
    renderVideoPanel();

    const prompt = screen.getByTestId("canvas-generator-prompt");
    expect(prompt.tagName).toBe("TEXTAREA");
    expect(prompt).toHaveAttribute("data-mode", "video");
    expect(prompt).toHaveValue("拍一段海浪");
  });
});

describe("T3 面板接线：图像面板的两个入口", () => {
  it("user_fixable 错误显示「修改参数」，点它把焦点送回 prompt 输入框", async () => {
    apiMock.generateImageDirect.mockRejectedValue(
      new ApiApplicationError("invalid_request", "bad params", 400),
    );
    renderImagePanel();

    fireEvent.click(screen.getByTestId("canvas-image-generator-submit"));

    const action = await screen.findByTestId("toast-action");
    expect(action).toHaveTextContent("修改参数");

    // 先把焦点挪走，才能证明是按钮把它送回输入框的
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(action);

    expect(document.activeElement).toBe(screen.getByTestId("canvas-generator-prompt"));
  });

  it("service 错误显示「稍后重试」，点它走面板现有的提交函数再跑一次", async () => {
    apiMock.generateImageDirect.mockRejectedValue(
      new ApiApplicationError("generation_failed", "boom", 502),
    );
    renderImagePanel();

    fireEvent.click(screen.getByTestId("canvas-image-generator-submit"));
    await waitFor(() => expect(apiMock.generateImageDirect).toHaveBeenCalledTimes(1));

    const action = await screen.findByTestId("toast-action");
    expect(action).toHaveTextContent("稍后重试");

    fireEvent.click(action);

    await waitFor(() => expect(apiMock.generateImageDirect).toHaveBeenCalledTimes(2));
    // 重试用的是同一条提交路径：请求参数还是面板上那一份
    expect(apiMock.generateImageDirect).toHaveBeenLastCalledWith(
      "token",
      "画一只猫",
      expect.objectContaining({ aspectRatio: "1:1" }),
    );
  });

  it("图像面板不再写死「图片生成失败，请重试或更换模型。」，文案取自目录", async () => {
    apiMock.generateImageDirect.mockRejectedValue(
      new ApiApplicationError("invalid_request", "bad params", 400),
    );
    renderImagePanel();

    fireEvent.click(screen.getByTestId("canvas-image-generator-submit"));

    await screen.findByTestId("toast-action");
    expect(screen.queryByText("图片生成失败，请重试或更换模型。")).toBeNull();
    expect(
      screen.getAllByText(APP_ERROR_CATALOG.invalid_request.message).length,
    ).toBeGreaterThan(0);
  });
});

