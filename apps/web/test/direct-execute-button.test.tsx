import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { DirectExecuteButton } from "../src/components/canvas/direct-execute-button";
import type { DirectExecuteButtonProps } from "../src/components/canvas/direct-execute-button";
import { __resetDirectExecuteLocksForTest } from "../src/hooks/use-direct-execute";

/**
 * ED-00m 前端 · `DirectExecuteButton`（工单 30M T3 / T4）
 *
 * 钉住三件事：`disabled` + `title=reason`（ED-00m「余额不足时禁用，并写明原因」）、
 * 可点时的 `title` 是价格提示（规格第 3 条）、提交中 `aria-busy` 与「提交中」。
 *
 * testid 用 `image-toolbar-vectorize` —— `image-` 前缀在 CONVENTIONS §6 的表里，
 * 组件本身不写任何 testid 字面量，只透传。
 *
 * **必须手动 `cleanup()`**：本仓 `vitest.config.ts` 只有 `environment: "jsdom"`，
 * 没开 `globals: true`，RTL 的自动 cleanup 不生效，上一例的 DOM 会挂在 `document.body` 上
 * （工单 §T4 要求，理由同 30L 的裁决 2）。锁是模块级的，一并重置。
 */

const TESTID = "image-toolbar-vectorize";

function makeProps(overrides: Partial<DirectExecuteButtonProps> = {}): DirectExecuteButtonProps {
  return {
    testid: TESTID,
    label: "矢量",
    price: { status: "priced", amount: 9 },
    toolId: "vectorize",
    sourceId: "img-1",
    available: 100,
    etaSeconds: null,
    submit: async () => ({ jobId: "job-1" }),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  __resetDirectExecuteLocksForTest();
});

describe("DirectExecuteButton：不可点（验收 2）", () => {
  it("余额不足：有 disabled 属性，title 等于原因，价格仍然可见", () => {
    render(<DirectExecuteButton {...makeProps({ available: 8 })} />);

    const button = screen.getByTestId(TESTID);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("disabled");
    expect(button).toHaveAttribute("title", "积分不足：需要 9，当前 8");
    // 价格必须一直可见（ED-00c / 规格第 1 条），禁用也不许把它藏掉
    expect(button).toHaveTextContent("矢量");
    expect(button).toHaveTextContent("生成 · 9");
    // 没有在提交，就不该有 aria-busy
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("estimating：title 是「价格获取中」，也是禁用", () => {
    render(<DirectExecuteButton {...makeProps({ price: { status: "estimating" }, available: 8 })} />);
    const button = screen.getByTestId(TESTID);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "价格获取中");
  });

  it("error：title 是「价格获取失败」", () => {
    render(<DirectExecuteButton {...makeProps({ price: { status: "error" }, available: 8 })} />);
    expect(screen.getByTestId(TESTID)).toHaveAttribute("title", "价格获取失败");
  });

  it("额度未知（available null）时不拦：这是 BL-45 还没做时的既定口径", () => {
    render(<DirectExecuteButton {...makeProps({ available: null })} />);
    const button = screen.getByTestId(TESTID);
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("title", "点击即扣 9 分");
  });
});

describe("DirectExecuteButton：可点（规格第 3 条）", () => {
  it("余额足够：title 是「点击即扣 9 分」，不带 disabled", () => {
    render(<DirectExecuteButton {...makeProps()} />);
    const button = screen.getByTestId(TESTID);
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("title", "点击即扣 9 分");
    expect(button).toHaveTextContent("生成 · 9");
  });

  it("待定价与免费各有自己的 title", () => {
    const { rerender } = render(<DirectExecuteButton {...makeProps({ price: { status: "pending" } })} />);
    expect(screen.getByTestId(TESTID)).toHaveAttribute("title", "待定价，点击即执行");

    rerender(<DirectExecuteButton {...makeProps({ price: { status: "free" } })} />);
    expect(screen.getByTestId(TESTID)).toHaveAttribute("title", "免费，点击即执行");
  });

  it("点一下会真的提交一次，并在提交中把按钮关掉（DOM 层的防连点）", async () => {
    const gate = deferred<{ jobId: string }>();
    const submit = vi.fn(() => gate.promise);
    render(<DirectExecuteButton {...makeProps({ submit })} />);

    const button = screen.getByTestId(TESTID);
    await act(async () => {
      fireEvent.click(button);
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
  });
});

describe("DirectExecuteButton：提交中", () => {
  it("aria-busy=true 并显示「提交中」，价格不消失", async () => {
    const gate = deferred<{ jobId: string }>();
    const submit = vi.fn(() => gate.promise);
    render(<DirectExecuteButton {...makeProps({ submit })} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(TESTID));
    });

    const button = screen.getByTestId(TESTID);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("提交中");
    expect(button).toHaveTextContent("生成 · 9");
    expect(button).toBeDisabled();

    await act(async () => {
      gate.resolve({ jobId: "job-1" });
    });

    expect(screen.getByTestId(TESTID)).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId(TESTID)).not.toHaveTextContent("提交中");
  });
});

describe("DirectExecuteButton：被拦时不提交（验收 2 的 DOM 一侧）", () => {
  it("余额不足时点击不触发 submit（disabled 属性挡住了激活）", async () => {
    const submit = vi.fn(async () => ({ jobId: "never" }));
    const onStart = vi.fn();
    render(<DirectExecuteButton {...makeProps({ available: 8, submit, onStart })} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(TESTID));
    });

    expect(submit).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });
});
