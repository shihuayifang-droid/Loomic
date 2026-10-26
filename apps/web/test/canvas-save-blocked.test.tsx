// @vitest-environment jsdom

/**
 * 工单45DF · QA-11 前端故障注入 #2：画布保存被拦截。
 *
 * 注入方式：把全局 `fetch` 换成**恒返回 503** 的替身，于是
 * `saveCanvas`（PUT /api/canvases/:id，本仓的真实实现）每次都拿到 503，
 * 自动保存的两次退避重试全部失败。用 fake timer 推进，不做真实等待。
 *
 * 断言三件事：
 *   ① 用户看得到保存失败提示（canvas-editor 的 role="status" 常驻提示）
 *   ② 本地内容没有丢：写前草稿（src/lib/canvas-draft.ts，真实实现 +
 *      真实 localStorage）里仍有这次改动的元素
 *   ③ 界面没有把状态显示成"已保存"
 *
 * Excalidraw 本体是 client-only 且体积巨大（见仓库既有做法：
 * generator-failure-reason.test.ts），这里只把 `next/dynamic` 换成取到
 * onChange/excalidrawAPI 的桩，画布数据走桩 API，保存链路走真实代码。
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasEditor } from "../src/components/canvas-editor";
import { readCanvasDraft } from "../src/lib/canvas-draft";

const h = vi.hoisted(() => ({
  scene: [] as any[],
  api: {} as any,
  onChange: { current: null as any },
  fetchMock: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: () => {
    function ExcalidrawStub(props: any) {
      h.onChange.current = props.onChange;
      useEffect(() => {
        props.excalidrawAPI?.(h.api);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return null;
    }
    return ExcalidrawStub;
  },
}));

// 画布上挂的两个浮层不在本单断言范围内，且都会对桩 API 调方法
vi.mock("../src/components/canvas-tool-menu", () => ({
  CanvasToolMenu: () => null,
}));
vi.mock("../src/components/canvas/image-toolbar-layer", () => ({
  ImageToolbarLayer: () => null,
}));

/** 一条最小的 Excalidraw 矩形元素。 */
function rect(id: string, x: number) {
  return {
    id,
    type: "rectangle",
    x,
    y: 10,
    width: 100,
    height: 60,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index: null,
  };
}

/** 503 的应答替身（jsdom 没有真的 Response，只用到 saveCanvas 读的三处）。 */
function serviceUnavailable() {
  return {
    ok: false,
    status: 503,
    headers: { get: () => "application/json" },
    json: async () => ({
      error: { code: "service_unavailable", message: "save blocked (injected)" },
    }),
  } as unknown as Response;
}

const SAVE_FAILED_COPY = "改动未保存到服务器，已在本地留存，恢复网络后会自动重试";
const SAVED_COPY = /已保存|保存成功|Saved$/;

beforeEach(() => {
  localStorage.clear();
  h.scene.length = 0;
  h.scene.push(rect("el-1", 0));
  h.onChange.current = null;
  h.fetchMock.mockReset();
  h.fetchMock.mockImplementation(async () => serviceUnavailable());
  vi.stubGlobal("fetch", h.fetchMock);

  Object.assign(h.api, {
    getSceneElements: () => h.scene,
    getFiles: () => ({}),
    getAppState: () => ({
      viewBackgroundColor: "#ffffff",
      gridModeEnabled: false,
      selectedElementIds: {},
    }),
    updateScene: vi.fn(),
    addFiles: vi.fn(),
    scrollToContent: vi.fn(),
    onChange: vi.fn(() => () => {}),
    setActiveTool: vi.fn(),
  });

  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("QA-11 故障注入：画布保存被拦截（PUT 恒 503）", () => {
  it("保存失败：给出可见提示、本地内容仍在、不显示成已保存", async () => {
    render(
      <CanvasEditor
        canvasId="canvas-1"
        projectId="project-1"
        accessToken="token_abc"
        initialContent={{
          elements: [rect("el-1", 0)],
          appState: { viewBackgroundColor: "#ffffff" },
          files: {},
        }}
        initialVersion={1}
      />,
    );

    // 等 Excalidraw 桩把 api 交上来 + idle 回调完成 hydrate
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(h.onChange.current).toBeTypeOf("function");

    // 用户改了一笔：画布多了一个元素
    h.scene.push(rect("el-2", 220));
    await act(async () => {
      h.onChange.current(h.scene.slice(), { selectedElementIds: {} });
    });

    // 推过 debounce(1500) + 两次退避重试(800/2400)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500 + 800 + 2400 + 200);
    });

    // 保存确实发出去了，而且被 503 拦下
    expect(h.fetchMock).toHaveBeenCalled();
    const putCalls = h.fetchMock.mock.calls.filter(
      (call) => (call[1] as any)?.method === "PUT",
    );
    expect(putCalls.length).toBeGreaterThan(0);
    expect(String(putCalls[0]?.[0])).toContain("/api/canvases/canvas-1");

    // ① 用户能看到保存失败提示
    const notice = screen.getByRole("status");
    expect(notice).toBeVisible();
    expect(notice).toHaveTextContent(SAVE_FAILED_COPY);

    // ② 本地内容没有丢：写前草稿里仍有这次改动的元素
    const draft = readCanvasDraft("canvas-1");
    expect(draft).not.toBeNull();
    const draftedIds = (draft?.content.elements ?? []).map((el: any) => el.id);
    expect(draftedIds).toContain("el-1");
    expect(draftedIds).toContain("el-2");
    // 在内存里也还在（不是被清空了的场景）
    expect(h.scene.map((el) => el.id)).toContain("el-2");

    // ③ 不会把界面显示成"已保存"
    expect(screen.queryByText(SAVED_COPY)).toBeNull();
    expect(notice).not.toHaveTextContent(/已保存/);
  });
});
