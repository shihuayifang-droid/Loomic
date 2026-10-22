// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * 工单 39S / BL-40 / X-40：tier 提示条只讲「并发 / 白名单 / 额度」，没有购买入口。
 *
 * framer-motion 照 `toast-action.test.tsx` 的写法换成直通 div：这张单要验的是
 * 「标题与正文出现 / 没有 CTA / 关闭后消失」，不是退出动画；真动画在 jsdom 里靠
 * requestAnimationFrame 跑，元素会卡在退出动画里不卸载，断言就变成在测动画库。
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

import {
  TierLimitToastProvider,
  useTierLimitToast,
} from "../src/components/credits/tier-limit-toast";

/** 一个按钮 = 一次 `showTierLimit()` 调用，和 provider 的真实用法一致。 */
function Harness({ code, message }: { code: string; message: string }) {
  const { showTierLimit } = useTierLimitToast();
  return (
    <button
      data-testid="tier-toast-trigger"
      type="button"
      onClick={() => showTierLimit({ code, message })}
    >
      trigger
    </button>
  );
}

function renderToast(code: string, message: string) {
  render(
    <TierLimitToastProvider>
      <Harness code={code} message={message} />
    </TierLimitToastProvider>,
  );
  fireEvent.click(screen.getByTestId("tier-toast-trigger"));
}

describe("TierLimitToast", () => {
  afterEach(() => {
    cleanup();
  });

  it("BL-40: a concurrency limit shows 并发已满 and the server message", () => {
    renderToast("concurrency_limit", "并发已满（4/4），请等待当前任务完成");

    expect(screen.getByText("并发已满")).toBeInTheDocument();
    expect(
      screen.getByText("并发已满（4/4），请等待当前任务完成"),
    ).toBeInTheDocument();
  });

  it("BL-40: the toast has no upgrade text and no cta button", () => {
    renderToast("concurrency_limit", "并发已满（4/4），请等待当前任务完成");

    expect(screen.queryByText(/升级/)).toBeNull();
    expect(screen.queryByText(/套餐/)).toBeNull();
    expect(screen.queryByTestId("credits-tier-limit-cta")).toBeNull();
  });

  it("BL-40: the dismiss button closes the toast", () => {
    renderToast("concurrency_limit", "并发已满（4/4），请等待当前任务完成");

    fireEvent.click(screen.getByTestId("credits-tier-limit-dismiss"));

    expect(screen.queryByTestId("credits-tier-limit-dismiss")).toBeNull();
    expect(screen.queryByText("并发已满")).toBeNull();
  });

  it("a non tier code such as personal_cap_reached shows no toast", () => {
    renderToast("personal_cap_reached", "今日额度已用完");

    expect(screen.queryByTestId("credits-tier-limit-dismiss")).toBeNull();
    expect(screen.queryByText("并发已满")).toBeNull();
    expect(screen.queryByText("今日额度已用完")).toBeNull();
  });
});
