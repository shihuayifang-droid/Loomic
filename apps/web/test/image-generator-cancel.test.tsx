import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

/**
 * 工单 36T：图片生成器面板「生成中可取消」（GN-32 / CV-02）。
 *
 * 面板这一侧只做三件事：`submitImageJob` 返回后记住 jobId 并露出取消入口；
 * 点取消先弹确认条（文案逐字）；确认之后才调一次 `cancelJob(token, jobId)`。
 *
 * `awaitJobCompletion` 替身返回一个**永不结算**的 promise，这样面板一直停在
 * 「生成中」—— 取消相关的断言都在这个状态上，一旦它自己结算了状态就变了。
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

// --- 网络函数换成替身：提交 / 等待 / 取消 ------------------------------------
const apiMock = vi.hoisted(() => ({
  fetchImageModels: vi.fn(),
  submitImageJob: vi.fn(),
  cancelJob: vi.fn(),
}));

vi.mock("../src/lib/server-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/server-api")>();
  return {
    ...actual,
    fetchImageModels: apiMock.fetchImageModels,
    submitImageJob: apiMock.submitImageJob,
    cancelJob: apiMock.cancelJob,
  };
});

/** 永不结算：面板一直停在「生成中」。 */
const apiMockAwait = vi.hoisted(() => ({ awaitJobCompletion: vi.fn() }));
vi.mock("../src/lib/await-job", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/await-job")>();
  return { ...actual, awaitJobCompletion: apiMockAwait.awaitJobCompletion };
});

import { ToastProvider } from "../src/components/toast";
import { ImageGeneratorPanel } from "../src/components/canvas/image-generator-panel";

const JOB_ID = "job-img-1";
const EXACT_WORDING = "取消这次生成？已开始的任务不退积分";

const BOUNDS = { x: 0, y: 0, width: 300, height: 200 };
const SCROLL_ZOOM = { scrollX: 0, scrollY: 0, zoom: 1 };
const NOOP_API = {
  getSceneElements: () => [],
  updateScene: () => {},
  addFiles: () => {},
};

function renderPanel() {
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

/** 提交一次，并等到「生成中」的取消入口出现。 */
async function startGenerating(): Promise<void> {
  fireEvent.click(screen.getByTestId("canvas-image-generator-submit"));
  await screen.findByTestId("canvas-image-generator-cancel");
}

/** 打开确认条。 */
async function openConfirm(): Promise<HTMLElement> {
  await startGenerating();
  fireEvent.click(screen.getByTestId("canvas-image-generator-cancel"));
  return screen.findByTestId("canvas-image-generator-cancel-confirm");
}

/** 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  apiMock.fetchImageModels.mockResolvedValue({ models: [] });
  apiMock.submitImageJob.mockResolvedValue({ jobId: JOB_ID });
  // 永不结算：停在生成中
  apiMockAwait.awaitJobCompletion.mockImplementation(() => new Promise(() => {}));
  apiMock.cancelJob.mockResolvedValue({
    job: { id: JOB_ID, status: "cancelled" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GN-32 / CV-02 图片面板生成中取消（工单 36T）", () => {
  it("GN-32: a generating image job can be cancelled from the panel", async () => {
    renderPanel();
    await startGenerating();

    expect(
      screen.getByTestId("canvas-image-generator-cancel"),
    ).toBeInTheDocument();
    expect(apiMock.cancelJob).not.toHaveBeenCalled();
  });

  it("CV-02: cancelling from the panel asks first, with the exact wording", async () => {
    renderPanel();
    const bar = await openConfirm();

    expect(bar.textContent).toContain(EXACT_WORDING);
    expect(
      screen.getByTestId("canvas-image-generator-cancel-ok"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("canvas-image-generator-cancel-back"),
    ).toBeInTheDocument();
    // 只是弹出确认条，没发取消请求
    expect(apiMock.cancelJob).toHaveBeenCalledTimes(0);
  });

  it("GN-32: confirming cancels the job by its id", async () => {
    renderPanel();
    await openConfirm();
    fireEvent.click(screen.getByTestId("canvas-image-generator-cancel-ok"));

    await waitFor(() =>
      expect(apiMock.cancelJob).toHaveBeenCalledWith("token", JOB_ID),
    );
    expect(apiMock.cancelJob).toHaveBeenCalledTimes(1);

    // 取消之后入口收起来，面板回到可再次提交
    await waitFor(() =>
      expect(
        screen.queryByTestId("canvas-image-generator-cancel"),
      ).toBeNull(),
    );
    expect(screen.getByTestId("canvas-image-generator-submit")).not.toBeDisabled();
  });

  it("GN-32: going back keeps the job running", async () => {
    renderPanel();
    await openConfirm();
    fireEvent.click(screen.getByTestId("canvas-image-generator-cancel-back"));

    await waitFor(() =>
      expect(
        screen.queryByTestId("canvas-image-generator-cancel-confirm"),
      ).toBeNull(),
    );
    expect(apiMock.cancelJob).toHaveBeenCalledTimes(0);
    // 任务还在跑，取消入口也要还在
    expect(
      screen.getByTestId("canvas-image-generator-cancel"),
    ).toBeInTheDocument();
  });

  it("GN-32: a failed cancel says so", async () => {
    apiMock.cancelJob.mockRejectedValue(new Error("cancel 502"));
    renderPanel();
    await openConfirm();
    fireEvent.click(screen.getByTestId("canvas-image-generator-cancel-ok"));

    await waitFor(() =>
      expect(
        screen.getByTestId("canvas-image-generator-cancel-confirm").textContent,
      ).toContain("取消失败，请重试"),
    );
  });
});
