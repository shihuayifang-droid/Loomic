import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

/**
 * 工单 30C T1：toast 的可选入口按钮。
 *
 * framer-motion 换成一个直通的 div：这张单要验的是「按钮出现 / 关闭 / 时长」，
 * 不是退出动画；真动画在 jsdom 里靠 requestAnimationFrame 跑，和假定时器混用会把
 * 元素卡在退出动画里不卸载，断言就变成在测动画库。
 */
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

import { ToastProvider, useToast } from "../src/components/toast";

type HarnessProps = {
  onAction?: (() => void) | undefined;
  actionLabel?: string | undefined;
};

/** 把 hook 的三个入口挂到按钮上：测试点这些按钮就等于调用 toast 的公开 API。 */
function Harness({ onAction, actionLabel }: HarnessProps) {
  const { error, success } = useToast();
  return (
    <div>
      <button
        type="button"
        data-testid="call-plain-error"
        onClick={() => error("旧的纯文案错误")}
      >
        纯文案
      </button>
      <button type="button" data-testid="call-success" onClick={() => success("成功了")}>
        成功
      </button>
      <button
        type="button"
        data-testid="call-action-error"
        onClick={() =>
          error("请求内容有误", {
            actionLabel: actionLabel ?? "稍后重试",
            onAction: onAction ?? (() => {}),
          })
        }
      >
        带入口
      </button>
    </div>
  );
}

function renderWithProvider(props: HarnessProps = {}) {
  return render(
    <ToastProvider>
      <Harness {...props} />
    </ToastProvider>,
  );
}

/** 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收 */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("toast 的入口按钮（T1）", () => {
  it("带 action 时出现按钮，文案来自调用方；本体带 toast-item 与 data-variant", () => {
    renderWithProvider({ onAction: vi.fn(), actionLabel: "修改参数" });

    fireEvent.click(screen.getByTestId("call-action-error"));

    const item = screen.getByTestId("toast-item");
    expect(item).toHaveAttribute("data-variant", "error");
    expect(item).toHaveTextContent("请求内容有误");
    expect(screen.getByTestId("toast-action")).toHaveTextContent("修改参数");
  });

  it("点击按钮：onAction 调用 1 次，toast 关闭", () => {
    const onAction = vi.fn();
    renderWithProvider({ onAction });

    fireEvent.click(screen.getByTestId("call-action-error"));
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("toast-action"));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("toast-item")).toBeNull();
  });

  it("点击按钮不冒泡到文档：证明不会连带触发本体的 onClick", () => {
    const documentClick = vi.fn();
    document.addEventListener("click", documentClick);
    try {
      renderWithProvider({ onAction: vi.fn() });
      fireEvent.click(screen.getByTestId("call-action-error"));

      // 对照组：触发按钮那次点击是冒泡到 document 的
      expect(documentClick).toHaveBeenCalledTimes(1);
      documentClick.mockClear();

      fireEvent.click(screen.getByTestId("toast-action"));

      expect(documentClick).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("click", documentClick);
    }
  });

  it("不带 action 时没有按钮，3 秒后消失（fake timers）", () => {
    vi.useFakeTimers();
    renderWithProvider();

    fireEvent.click(screen.getByTestId("call-plain-error"));
    expect(screen.getByTestId("toast-item")).toBeInTheDocument();
    expect(screen.queryByTestId("toast-action")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(screen.getByTestId("toast-item")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByTestId("toast-item")).toBeNull();
  });

  it("带 action 时 6 秒后消失：5.9 秒还在，6 秒后没了（fake timers）", () => {
    vi.useFakeTimers();
    renderWithProvider({ onAction: vi.fn() });

    fireEvent.click(screen.getByTestId("call-action-error"));
    expect(screen.getByTestId("toast-item")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5999);
    });
    // 3 秒那条时长不能套在带按钮的 toast 上，否则这里已经空了
    expect(screen.getByTestId("toast-item")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByTestId("toast-item")).toBeNull();
  });

  it("点击本体（非按钮位置）仍然能关闭 toast", () => {
    renderWithProvider({ onAction: vi.fn() });
    fireEvent.click(screen.getByTestId("call-action-error"));

    fireEvent.click(screen.getByTestId("toast-item"));

    expect(screen.queryByTestId("toast-item")).toBeNull();
  });

  it('旧签名 error("x") 仍然可用：无按钮、点本体能关', () => {
    renderWithProvider();
    fireEvent.click(screen.getByTestId("call-plain-error"));

    expect(screen.getByTestId("toast-item")).toHaveTextContent("旧的纯文案错误");
    expect(screen.queryByTestId("toast-action")).toBeNull();

    fireEvent.click(screen.getByTestId("toast-item"));
    expect(screen.queryByTestId("toast-item")).toBeNull();
  });

  it("success 走原来的 variant 分支，不带按钮", () => {
    renderWithProvider();
    fireEvent.click(screen.getByTestId("call-success"));

    expect(screen.getByTestId("toast-item")).toHaveAttribute("data-variant", "success");
    expect(screen.queryByTestId("toast-action")).toBeNull();
  });
});
