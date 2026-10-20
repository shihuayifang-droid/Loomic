import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

/**
 * 工单 36Y：视频回填按产物实际宽高比放置（GN-02 ⑤），与 36X 的图片面板
 * `fit-result.test.ts` 同口径。
 *
 * 面板拿到 job result 之后，占位框是按**请求**的比例画的，回来的视频可能是
 * 另一种形状；这里断言传给 `convertToExcalidrawElements` 的 embeddable
 * 用的是「按实际宽高 contain 进占位」之后的坐标与尺寸，而不是占位本身的宽高。
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
vi.mock("../src/hooks/use-completion-title", () => ({
  useCompletionTitle: () => ({ begin: vi.fn(), end: vi.fn() }),
}));

/** excalidraw 是 client-only 的巨型包：只要 `convertToExcalidrawElements`，且恒等返回 skeleton，便于断言入参。 */
const excalidrawMock = vi.hoisted(() => ({
  convertToExcalidrawElements: vi.fn((skeletons: unknown[]) => skeletons),
}));
vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: excalidrawMock.convertToExcalidrawElements,
}));

const apiMock = vi.hoisted(() => ({
  fetchVideoModels: vi.fn(),
  submitVideoJob: vi.fn(),
  cancelJob: vi.fn(),
}));

vi.mock("../src/lib/server-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/server-api")>();
  return {
    ...actual,
    fetchVideoModels: apiMock.fetchVideoModels,
    submitVideoJob: apiMock.submitVideoJob,
    cancelJob: apiMock.cancelJob,
  };
});

/** 立即结算：`succeeded` job 带上产物实际宽高。 */
const apiMockAwait = vi.hoisted(() => ({ awaitJobCompletion: vi.fn() }));
vi.mock("../src/lib/await-job", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/await-job")>();
  return { ...actual, awaitJobCompletion: apiMockAwait.awaitJobCompletion };
});

import { ToastProvider } from "../src/components/toast";
import { VideoGeneratorPanel } from "../src/components/canvas/video-generator-panel";

const JOB_ID = "job-vid-fit";

const BOUNDS = { x: 100, y: 50, width: 512, height: 512 };
const SCROLL_ZOOM = { scrollX: 0, scrollY: 0, zoom: 1 };
const NOOP_API = {
  getSceneElements: () => [],
  updateScene: () => {},
  addFiles: () => {},
};

function renderPanel() {
  return render(
    <ToastProvider>
      <VideoGeneratorPanel
        elementId="el-fit"
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

/** 提交一次并等面板把入参递到 excalidraw，取第一个 skeleton。 */
async function generateAndCapture(): Promise<Record<string, unknown>> {
  renderPanel();
  fireEvent.click(screen.getByTestId("canvas-video-generator-submit"));

  await waitFor(() =>
    expect(excalidrawMock.convertToExcalidrawElements).toHaveBeenCalled(),
  );
  const skeletons = excalidrawMock.convertToExcalidrawElements.mock
    .calls[0]?.[0] as unknown as Record<string, unknown>[];
  return skeletons[0]!;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  apiMock.fetchVideoModels.mockResolvedValue({ models: [] });
  apiMock.submitVideoJob.mockResolvedValue({ jobId: JOB_ID });
  apiMock.cancelJob.mockResolvedValue({
    job: { id: JOB_ID, status: "succeeded" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GN-02 视频回填按实际宽高比（工单 36Y）", () => {
  it("GN-02: a landscape video lands at its real aspect ratio", async () => {
    apiMockAwait.awaitJobCompletion.mockResolvedValue({
      jobId: JOB_ID,
      status: "succeeded",
      result: {
        signed_url: "https://cdn.example.com/video.mp4",
        mime_type: "video/mp4",
        duration_seconds: 4,
        width: 1920,
        height: 1080,
      },
    });

    const element = await generateAndCapture();

    // 1920x1080 contain 进 512x512：宽顶满，高 288，垂直居中（上下各空 112）
    expect(element["width"]).toBe(512);
    expect(element["height"] as number).toBeCloseTo(288);
    expect(element["y"] as number).toBeCloseTo(BOUNDS.y + 112);
  });

  it("GN-02: a video without dimensions keeps the slot", async () => {
    apiMockAwait.awaitJobCompletion.mockResolvedValue({
      jobId: JOB_ID,
      status: "succeeded",
      result: {
        signed_url: "https://cdn.example.com/video.mp4",
        mime_type: "video/mp4",
        duration_seconds: 4,
      },
    });

    const element = await generateAndCapture();

    expect(element["width"]).toBe(BOUNDS.width);
    expect(element["height"]).toBe(BOUNDS.height);
    expect(element["x"]).toBe(BOUNDS.x);
    expect(element["y"]).toBe(BOUNDS.y);
  });
});
