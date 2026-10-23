import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * 工单 40U · ED-06 快捷编辑面板
 *
 * 面板本身是纯展示 + 委托：草稿、询价、提交都在 `image-toolbar-layer.tsx`。
 * 所以这里直接渲染组件、给 props，断言的是「用户看得见的那几个字」：
 * 空输入点不了、价格从询价来、提示常显、Esc 交回上层、一期没有框选按钮。
 *
 * `ChatComposer` 用真身（ED-06 要求「与 Agent 输入框同一组件」，
 * 换成替身这条要求就测不到了）；jsdom 里它就是一个 contenteditable 的 div。
 */

import {
  QUICK_EDIT_EMPTY_TITLE,
  QUICK_EDIT_HINT,
  QUICK_EDIT_PLACEHOLDER,
  QuickEditPanel,
} from "../src/components/canvas/quick-edit-panel";

// 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收。
afterEach(() => {
  cleanup();
});

function renderPanel(overrides: Partial<Parameters<typeof QuickEditPanel>[0]> = {}) {
  const onTextChange = vi.fn();
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(
    <QuickEditPanel
      initialText=""
      price={undefined}
      submitting={false}
      error={null}
      onTextChange={onTextChange}
      onSubmit={onSubmit}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onTextChange, onSubmit, onClose };
}

/** 往 contenteditable 里写一段文字，并走一遍组件真正监听的那个事件。 */
function typePrompt(text: string): void {
  const input = screen.getByTestId("quickedit-input");
  input.textContent = text;
  fireEvent.input(input);
}

describe("ED-06：快捷编辑面板（工单 40U）", () => {
  it("ED-06: an empty prompt cannot be submitted", () => {
    renderPanel();

    const submit = screen.getByTestId("quickedit-submit");
    expect(submit).toBeDisabled();
    expect(submit.getAttribute("title")).toBe(QUICK_EDIT_EMPTY_TITLE);
    expect(QUICK_EDIT_EMPTY_TITLE).toBe("请先描述要怎么改");

    // 只打空格也算空：去空白后为空就不许提交
    typePrompt("   ");
    expect(screen.getByTestId("quickedit-submit")).toBeDisabled();

    // 有内容才能点得到
    typePrompt("改成蓝色");
    expect(screen.getByTestId("quickedit-submit")).not.toBeDisabled();
  });

  it("ED-06: the button shows the quoted price", () => {
    renderPanel({ price: { status: "priced", amount: 8 } });

    expect(screen.getByTestId("quickedit-submit").textContent).toBe("生成 · 8");
  });

  it("ED-06: the whole-image hint is always shown", () => {
    renderPanel();

    expect(screen.getByTestId("quickedit-hint").textContent).toBe(
      "将按描述重新生成整张图，非编辑部分可能变化",
    );
    expect(QUICK_EDIT_HINT).toBe("将按描述重新生成整张图，非编辑部分可能变化");
    // 输入框占位符也是规格原文
    expect(screen.getByTestId("quickedit-input").getAttribute("data-placeholder")).toBe(
      QUICK_EDIT_PLACEHOLDER,
    );
  });

  it("ED-06: Esc closes the panel", () => {
    const { onClose } = renderPanel();

    fireEvent.keyDown(screen.getByTestId("quickedit-panel"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ED-06: no region-select button in phase one", () => {
    renderPanel({ price: { status: "priced", amount: 8 } });

    const panel = screen.getByTestId("quickedit-panel");
    // 框选区域按钮在 ED-06 里是「未解决前隐藏」，一期只上整图编辑。
    expect(panel.querySelectorAll("[aria-pressed]")).toHaveLength(0);
  });
});
