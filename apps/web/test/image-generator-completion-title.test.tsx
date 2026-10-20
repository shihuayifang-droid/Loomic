import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

/**
 * 工单 36R：图片生成器接入 CV-10 完成提醒。
 *
 * 面板这一侧只做两件事：提交成功时 `begin(jobId)`，到达终态时 `end(jobId, ok)`。
 * 「改不改标题」由 hook 决定（`use-completion-title.test.tsx` 已覆盖），所以这里把
 * hook 换成替身，只钉住「面板有没有把这两个事件报出去、报的 id 对不对」。
 *
 * 断言里的 `job-img-1` 就是 `submitImageJob` 替身返回的 jobId —— 面板必须用它，
 * 而不是自己另造一个 id，否则「本轮」永远凑不齐。
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

/** tier toast 有 Next router 依赖，这条单只关心完成提醒，换成 spy。 */
const tierMock = vi.hoisted(() => ({ showTierLimit: vi.fn() }));
vi.mock("@/components/credits/tier-limit-toast", () => ({
  useTierLimitToast: () => ({ showTierLimit: tierMock.showTierLimit }),
}));

// --- CV-10：hook 换替身，只记录 begin / end --------------------------------
const completionMock = vi.hoisted(() => ({
  begin: vi.fn(),
  end: vi.fn(),
}));
vi.mock("@/hooks/use-completion-title", () => ({
  useCompletionTitle: () => ({
    begin: completionMock.begin,
    end: completionMock.end,
  }),
}));

// --- 网络函数换成替身：submit / await / 下载 ---------------------------------
const apiMock = vi.hoisted(() => ({
  fetchImageModels: vi.fn(),
  submitImageJob: vi.fn(),
  awaitJobCompletion: vi.fn(),
  fetchAsDataURL: vi.fn(),
}));

vi.mock("../src/lib/server-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/server-api")>();
  return {
    ...actual,
    fetchImageModels: apiMock.fetchImageModels,
    submitImageJob: apiMock.submitImageJob,
  };
});

vi.mock("../src/lib/await-job", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/await-job")>();
  return { ...actual, awaitJobCompletion: apiMock.awaitJobCompletion };
});

vi.mock("../src/lib/canvas-elements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/canvas-elements")>();
  return { ...actual, fetchAsDataURL: apiMock.fetchAsDataURL };
});

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

/** 一整个成功 job 的最小形状：`imageResultFromJob` 只认 `result.signed_url`。 */
const SUCCEEDED_JOB = {
  status: "succeeded",
  result: { signed_url: "https://cdn.example.com/cat.png", mime_type: "image/png" },
};

function renderPanel(onClose: () => void = () => {}) {
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
        onClose={onClose}
      />
    </ToastProvider>,
  );
}

/** 点「生成」并等面板把提交走完。 */
function submit() {
  fireEvent.click(screen.getByTestId("canvas-image-generator-submit"));
}

/** 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  // 每个例子从「这一轮还没开始」重新数，否则上一例的 begin / end 会漏到下一例。
  completionMock.begin.mockReset();
  completionMock.end.mockReset();
  apiMock.fetchImageModels.mockResolvedValue({ models: [] });
  apiMock.fetchAsDataURL.mockResolvedValue("data:image/png;base64,AAAA");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CV-10 图片面板接线（工单 36R）", () => {
  it("CV-10: an image job joins the round when it is submitted", async () => {
    apiMock.submitImageJob.mockResolvedValue({ jobId: JOB_ID });
    apiMock.awaitJobCompletion.mockResolvedValue(SUCCEEDED_JOB);

    renderPanel();
    submit();

    await waitFor(() =>
      expect(completionMock.begin).toHaveBeenCalledWith(JOB_ID),
    );
    expect(completionMock.begin).toHaveBeenCalledTimes(1);
  });

  it("CV-10: a finished image job settles the round as a success", async () => {
    apiMock.submitImageJob.mockResolvedValue({ jobId: JOB_ID });
    apiMock.awaitJobCompletion.mockResolvedValue(SUCCEEDED_JOB);

    renderPanel();
    submit();

    await waitFor(() =>
      expect(completionMock.end).toHaveBeenCalledWith(JOB_ID, true),
    );
    expect(completionMock.end).toHaveBeenCalledTimes(1);
  });

  it("CV-10: a failed image job settles the round as a failure", async () => {
    apiMock.submitImageJob.mockResolvedValue({ jobId: JOB_ID });
    apiMock.awaitJobCompletion.mockRejectedValue(new Error("upstream 502"));

    renderPanel();
    submit();

    await waitFor(() =>
      expect(completionMock.end).toHaveBeenCalledWith(JOB_ID, false),
    );
    expect(completionMock.end).toHaveBeenCalledTimes(1);
  });
});
