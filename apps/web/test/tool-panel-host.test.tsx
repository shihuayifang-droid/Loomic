import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

/**
 * 工单 30E T3 · ED-00d 面板生命周期宿主。
 *
 * toast 用 **spy 替代**（工单 §4 允许「spy 替代」或「包一层真的 Provider」二选一）：
 * 这里选 spy，因为本单要验的是「调用了几次、文案是什么、variant 是什么」，
 * 真 Provider 还要处理 3 秒定时器与被移除后的 DOM，会把断言变成在测 toast 组件本身
 * （那是工单 30C 的范围，本单不许改 `components/toast.tsx`）。
 */

const toastSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/components/toast", () => ({
  useToast: () => ({ toast: toastSpy, success: toastSpy, error: toastSpy }),
}));

import {
  SOURCE_DELETED_MESSAGE,
  ToolPanelHostProvider,
  useToolPanelHost,
} from "../src/components/canvas/tool-panel-host";

const HOST_TESTID = "canvas-tool-panel-host";

/** 触发器：全部走 hook 的公开 API，等价于真实调用方。 */
function Triggers() {
  const { openPanel, closePanel, notifySourceDeleted } = useToolPanelHost();
  return (
    <div>
      <button
        type="button"
        data-testid="open-adjust"
        onClick={() => openPanel("adjust", "img-1")}
      >
        调整
      </button>
      <button type="button" data-testid="open-crop" onClick={() => openPanel("crop", "img-1")}>
        裁剪
      </button>
      <button
        type="button"
        data-testid="open-crop-img-2"
        onClick={() => openPanel("crop", "img-2")}
      >
        裁剪另一张
      </button>
      <button type="button" data-testid="close-panel" onClick={() => closePanel()}>
        关闭
      </button>
      <button
        type="button"
        data-testid="delete-img-1"
        onClick={() => notifySourceDeleted("img-1")}
      >
        删 img-1
      </button>
      <button
        type="button"
        data-testid="delete-img-9"
        onClick={() => notifySourceDeleted("img-9")}
      >
        删 img-9
      </button>
    </div>
  );
}

/** 把 `current` 的形状直接摊到 DOM 上，省得每个用例都去翻 renderPanel 的入参。 */
function CurrentProbe() {
  const { current } = useToolPanelHost();
  return (
    <span data-testid="current-probe">
      {current === null ? "null" : `${current.panelId}|${current.sourceId}`}
    </span>
  );
}

/** 模拟「选中状态变化」用的旁挂子树：宿主没有任何 selection 相关的入参。 */
function SelectionLike({ ids }: { ids: string[] }) {
  return <span data-testid="selection-like">{ids.join(",")}</span>;
}

/** 面板内容（render prop）。每次被调用都记一笔，用来证明「任何时刻只有一个面板」。 */
type PanelRenderLog = string[];

function hostTree(options: {
  log?: PanelRenderLog;
  extra?: ReactNode;
}): ReactNode {
  const { log, extra } = options;
  return (
    <ToolPanelHostProvider
      renderPanel={(current) => {
        log?.push(current.panelId);
        return (
          <div data-testid="panel-content" data-panel={current.panelId} data-source={current.sourceId}>
            {current.panelId}
          </div>
        );
      }}
    >
      <Triggers />
      <CurrentProbe />
      {extra}
    </ToolPanelHostProvider>
  );
}

function host(): HTMLElement {
  return screen.getByTestId(HOST_TESTID);
}

/** 页面上现存的「面板内容」节点数。开场一个都不该有；开着时必须有且只有一个。 */
function panelContentCount(): number {
  return document.querySelectorAll('[data-testid="panel-content"]').length;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("ToolPanelHostProvider：开 / 关", () => {
  it("初始 data-state=closed、没有 data-panel、current 为 null、一个内容节点都不渲染", () => {
    render(hostTree({}));

    expect(host()).toHaveAttribute("data-state", "closed");
    expect(host()).not.toHaveAttribute("data-panel");
    expect(screen.getByTestId("current-probe")).toHaveTextContent("null");
    expect(panelContentCount()).toBe(0);
  });

  it("打开后 data-state=open、data-panel 正确，current 带上打开时的 sourceId", () => {
    render(hostTree({}));
    fireEvent.click(screen.getByTestId("open-adjust"));

    expect(host()).toHaveAttribute("data-state", "open");
    expect(host()).toHaveAttribute("data-panel", "adjust");
    expect(screen.getByTestId("current-probe")).toHaveTextContent("adjust|img-1");

    const content = screen.getByTestId("panel-content");
    expect(content).toHaveAttribute("data-panel", "adjust");
    expect(content).toHaveAttribute("data-source", "img-1");
    expect(panelContentCount()).toBe(1);
  });

  it("closePanel 生效：回到 closed，内容节点消失，且不发 toast", () => {
    render(hostTree({}));
    fireEvent.click(screen.getByTestId("open-adjust"));
    expect(host()).toHaveAttribute("data-state", "open");

    fireEvent.click(screen.getByTestId("close-panel"));

    expect(host()).toHaveAttribute("data-state", "closed");
    expect(host()).not.toHaveAttribute("data-panel");
    expect(screen.getByTestId("current-probe")).toHaveTextContent("null");
    expect(panelContentCount()).toBe(0);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("没有面板时 closePanel 是空操作（不抛错、状态仍是 closed）", () => {
    render(hostTree({}));
    expect(() => fireEvent.click(screen.getByTestId("close-panel"))).not.toThrow();
    expect(host()).toHaveAttribute("data-state", "closed");
  });
});

describe("ToolPanelHostProvider：同一时间只开一个面板", () => {
  it("验收 2：先开 adjust 再开 crop，current 变成 crop，调整面板关闭，任何时刻都只有一个", () => {
    const log: PanelRenderLog = [];
    render(hostTree({ log }));

    expect(document.querySelectorAll(`[data-testid="${HOST_TESTID}"]`).length).toBe(1);

    fireEvent.click(screen.getByTestId("open-adjust"));
    expect(host()).toHaveAttribute("data-panel", "adjust");
    expect(panelContentCount()).toBe(1);

    fireEvent.click(screen.getByTestId("open-crop"));
    expect(host()).toHaveAttribute("data-panel", "crop");
    expect(screen.getByTestId("current-probe")).toHaveTextContent("crop|img-1");
    expect(panelContentCount()).toBe(1);
    // 调整面板的内容已经被换掉（不是「又开了一个」）
    expect(screen.getByTestId("panel-content")).toHaveAttribute("data-panel", "crop");

    // 渲染日志：每次打开恰好渲染一次内容，第二次打开覆盖第一次
    expect(log).toEqual(["adjust", "crop"]);
    // 宿主容器始终只有一个
    expect(document.querySelectorAll(`[data-testid="${HOST_TESTID}"]`).length).toBe(1);
  });

  it("换源对象重开同一形态：sourceId 跟着换成新的（面板绑定的是打开时的源对象）", () => {
    render(hostTree({}));
    fireEvent.click(screen.getByTestId("open-adjust"));
    expect(screen.getByTestId("panel-content")).toHaveAttribute("data-source", "img-1");

    fireEvent.click(screen.getByTestId("open-crop-img-2"));
    expect(host()).toHaveAttribute("data-panel", "crop");
    expect(screen.getByTestId("panel-content")).toHaveAttribute("data-source", "img-2");
    expect(panelContentCount()).toBe(1);
  });
});

describe("ToolPanelHostProvider：源对象被删", () => {
  it("验收 3：notifySourceDeleted(当前源 id) → 状态变 closed，toast 调 1 次、文案「源图已删除」", () => {
    render(hostTree({}));
    fireEvent.click(screen.getByTestId("open-adjust"));
    expect(host()).toHaveAttribute("data-state", "open");

    fireEvent.click(screen.getByTestId("delete-img-1"));

    expect(host()).toHaveAttribute("data-state", "closed");
    expect(host()).not.toHaveAttribute("data-panel");
    expect(screen.getByTestId("current-probe")).toHaveTextContent("null");
    expect(panelContentCount()).toBe(0);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith("源图已删除", "info");
    // 文案常量与断言同源，避免两处各写一遍中文
    expect(SOURCE_DELETED_MESSAGE).toBe("源图已删除");
  });

  it("用别的 id 调用：状态一字不变，也不发 toast", () => {
    render(hostTree({}));
    fireEvent.click(screen.getByTestId("open-adjust"));

    fireEvent.click(screen.getByTestId("delete-img-9"));

    expect(host()).toHaveAttribute("data-state", "open");
    expect(host()).toHaveAttribute("data-panel", "adjust");
    expect(screen.getByTestId("current-probe")).toHaveTextContent("adjust|img-1");
    expect(panelContentCount()).toBe(1);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("没有面板时调用：什么都不做，不发 toast", () => {
    render(hostTree({}));
    fireEvent.click(screen.getByTestId("delete-img-1"));

    expect(host()).toHaveAttribute("data-state", "closed");
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("面板已关闭后再删同一张源图：不会补发 toast（面板已经不在了）", () => {
    render(hostTree({}));
    fireEvent.click(screen.getByTestId("open-adjust"));
    fireEvent.click(screen.getByTestId("close-panel"));

    fireEvent.click(screen.getByTestId("delete-img-1"));

    expect(host()).toHaveAttribute("data-state", "closed");
    expect(toastSpy).not.toHaveBeenCalled();
  });
});

describe("ToolPanelHostProvider：宿主不读选中状态", () => {
  it("静态断言：组件里没有 selection 这类入参（工单 §4 允许的替代写法，见回传）", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
      path.resolve(here, "../src/components/canvas/tool-panel-host.tsx"),
      "utf8",
    );
    // 没有 selection / selectedIds 这样的 prop 声明
    expect(source).not.toMatch(/\bselection\s*\??\s*:/);
    expect(source).not.toMatch(/\bselectedIds\b/);
    // 也不读任何「当前选中」来源的模块
    expect(source).not.toMatch(/from\s+"[^"]*excalidraw[^"]*"/);
    expect(source).not.toMatch(/useSelected/);
  });

  it("重新渲染时传不同的「选中」子树，面板保持不变（没有选中入参可影响它）", () => {
    const view = render(hostTree({ extra: <SelectionLike ids={["img-2", "img-3"]} /> }));
    fireEvent.click(screen.getByTestId("open-adjust"));
    expect(host()).toHaveAttribute("data-panel", "adjust");

    view.rerender(hostTree({ extra: <SelectionLike ids={[]} /> }));

    expect(host()).toHaveAttribute("data-state", "open");
    expect(host()).toHaveAttribute("data-panel", "adjust");
    expect(screen.getByTestId("current-probe")).toHaveTextContent("adjust|img-1");
    expect(screen.getByTestId("selection-like")).toBeEmptyDOMElement();
  });
});
