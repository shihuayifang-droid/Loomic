import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { PriceTag } from "../src/components/ui/price-tag";
import type { PriceState } from "../src/lib/price-display";

/**
 * BL-14 前端 · PriceTag 五态展示
 *
 * 钉住四件事：data-status / 文案 / 获取失败的按钮 / aria-live（估算中→数字能被播报）。
 * 文案本身的逐条断言在 price-display.test.ts 里，这里验组件把状态接到 DOM 上。
 */

// 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收
afterEach(() => {
  cleanup();
});

type StateCase = { status: string; state: PriceState; plainText: string };

const STATE_CASES: StateCase[] = [
  { status: "estimating", state: { status: "estimating" }, plainText: "估算中" },
  { status: "priced", state: { status: "priced", amount: 12 }, plainText: "12" },
  { status: "free", state: { status: "free" }, plainText: "免费" },
  { status: "pending", state: { status: "pending" }, plainText: "待定价" },
  { status: "error", state: { status: "error" }, plainText: "价格获取失败，点击重试" },
];

describe("PriceTag：data-status 与文案", () => {
  it.each(STATE_CASES)("$status 的 data-status 是 $status，文案是「$plainText」", ({ state, status, plainText }) => {
    render(<PriceTag state={state} variant="plain" />);
    const node = screen.getByTestId("price-tag");
    expect(node.dataset.status).toBe(status);
    expect(node).toHaveTextContent(plainText);
  });

  it("同一状态下 variant 只换前缀：button 带「生成 · 」、badge 带「⚡」", () => {
    const { rerender } = render(<PriceTag state={{ status: "priced", amount: 12 }} variant="button" />);
    expect(screen.getByTestId("price-tag")).toHaveTextContent("生成 · 12");

    rerender(<PriceTag state={{ status: "priced", amount: 12 }} variant="badge" />);
    expect(screen.getByTestId("price-tag")).toHaveTextContent("⚡12");
  });

  it("待定价在 DOM 上标成可点，估算中标成不可点", () => {
    const { rerender } = render(<PriceTag state={{ status: "pending" }} variant="badge" />);
    expect(screen.getByTestId("price-tag").dataset.clickable).toBe("true");
    expect(screen.getByTestId("price-tag")).toHaveTextContent("⚡待定价");

    rerender(<PriceTag state={{ status: "estimating" }} variant="badge" />);
    expect(screen.getByTestId("price-tag").dataset.clickable).toBe("false");
  });
});

describe("PriceTag：获取失败（ED-00c）", () => {
  it("error 且有 onRetry：渲染成按钮，点击只调用一次回调", () => {
    const onRetry = vi.fn();
    render(<PriceTag state={{ status: "error" }} variant="plain" onRetry={onRetry} />);

    const retry = screen.getByTestId("price-tag-retry");
    expect(retry.tagName).toBe("BUTTON");
    expect(retry.dataset.status).toBe("error");
    expect(retry).toHaveTextContent("价格获取失败，点击重试");

    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("error 但没有 onRetry：不渲染按钮，只显示文案", () => {
    render(<PriceTag state={{ status: "error" }} variant="plain" />);
    expect(screen.queryByTestId("price-tag-retry")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("price-tag")).toHaveTextContent("价格获取失败，点击重试");
  });

  it("非 error 状态即使传了 onRetry 也不渲染按钮（重试只属于获取失败）", () => {
    const onRetry = vi.fn();
    render(<PriceTag state={{ status: "pending" }} variant="button" onRetry={onRetry} />);
    expect(screen.queryByTestId("price-tag-retry")).toBeNull();
    expect(screen.getByTestId("price-tag").tagName).toBe("SPAN");
  });
});

describe("PriceTag：可访问性与重新渲染", () => {
  it("aria-live=polite 存在，价格从估算中变数字时能播报", () => {
    render(<PriceTag state={{ status: "estimating" }} variant="plain" />);
    expect(screen.getByTestId("price-tag")).toHaveAttribute("aria-live", "polite");
  });

  it("estimating 切到 priced 时重新渲染，文案与 data-status 都跟着变", () => {
    const { rerender } = render(<PriceTag state={{ status: "estimating" }} variant="button" />);
    expect(screen.getByTestId("price-tag")).toHaveTextContent("生成 · 估算中");
    expect(screen.getByTestId("price-tag").dataset.status).toBe("estimating");

    rerender(<PriceTag state={{ status: "priced", amount: 12 }} variant="button" />);
    expect(screen.getByTestId("price-tag")).toHaveTextContent("生成 · 12");
    expect(screen.getByTestId("price-tag").dataset.status).toBe("priced");
  });

  it("数字从询价结果来：amount 变了文案就变，组件自己不记账", () => {
    const { rerender } = render(<PriceTag state={{ status: "priced", amount: 7 }} variant="plain" />);
    expect(screen.getByTestId("price-tag")).toHaveTextContent("7");

    rerender(<PriceTag state={{ status: "priced", amount: 9 }} variant="plain" />);
    expect(screen.getByTestId("price-tag")).toHaveTextContent("9");
  });
});
