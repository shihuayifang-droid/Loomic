import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { FlipRotateBar } from "../src/components/canvas/flip-rotate-bar";
import { TOOLBAR_HEIGHT } from "../src/components/canvas/image-toolbar";
import type { FlipRotateState } from "../src/lib/flip-rotate";

/**
 * 工单 30J T5 · ED-03 二级条（纯展示）。
 *
 * 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收。
 * Esc 的用例直接对 `window` / 输入框 dispatching —— 组件的监听挂在 window 上，
 * 所以「焦点在输入框里按 Esc」和「焦点在别处按 Esc」走的是同一条路径。
 */
afterEach(() => {
  cleanup();
});

/** 初始状态：角度取一个非 0 的值，这样「恢复原值」的断言才有区分度。 */
const BASE: FlipRotateState = { angle: 10, flipH: false, flipV: true };

function renderBar(state: FlipRotateState = BASE) {
  const onChange = vi.fn();
  const onDownload = vi.fn();
  const onExit = vi.fn();
  const view = render(
    <FlipRotateBar state={state} onChange={onChange} onDownload={onDownload} onExit={onExit} />,
  );
  return { ...view, onChange, onDownload, onExit, state };
}

describe("FlipRotateBar（ED-03 二级条，纯展示）", () => {
  it("容器 + 5 项都存在（角度输入、旋转、水平翻转、垂直翻转、下载）", () => {
    renderBar();

    expect(screen.getByTestId("image-toolbar-flip-rotate")).toBeTruthy();
    for (const testid of [
      "image-toolbar-flip-rotate-angle",
      "image-toolbar-flip-rotate-rotate",
      "image-toolbar-flip-rotate-flip-h",
      "image-toolbar-flip-rotate-flip-v",
      "image-toolbar-flip-rotate-download",
    ]) {
      expect(screen.getByTestId(testid), `缺 testid：${testid}`).toBeTruthy();
    }
  });

  it("可访问名称：旋转 90° / 水平翻转 / 垂直翻转 / 下载，角度输入框是「旋转角度」", () => {
    renderBar();

    expect(screen.getByRole("button", { name: "旋转 90°" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "水平翻转" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "垂直翻转" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "旋转角度" })).toBeTruthy();
  });

  it("尺寸与主工具条一致：容器 height === TOOLBAR_HEIGHT（导入常量，不写字面量）", () => {
    renderBar();

    expect(screen.getByTestId("image-toolbar-flip-rotate")).toHaveStyle({
      height: `${TOOLBAR_HEIGHT}px`,
    });
  });

  it("角度输入框显示 state.angle，右侧的 ° 标记是 aria-hidden", () => {
    renderBar();

    const input = screen.getByTestId("image-toolbar-flip-rotate-angle") as HTMLInputElement;
    expect(input.value).toBe("10");

    const container = screen.getByTestId("image-toolbar-flip-rotate");
    const degree = Array.from(container.querySelectorAll("[aria-hidden='true']")).find(
      (element) => element.textContent === "°",
    );
    expect(degree, "没找到 ° 标记").toBeTruthy();
  });

  it("输入 450 后回车：onChange 收到 angle=90（已归一），输入框显示归一后的值", () => {
    const { onChange, state } = renderBar();
    const input = screen.getByTestId("image-toolbar-flip-rotate-angle");

    fireEvent.change(input, { target: { value: "450" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...state, angle: 90 });
    expect((input as HTMLInputElement).value).toBe("90");
  });

  it("输入 abc 后失焦：onChange 没有被调用，输入框恢复为原值", () => {
    const { onChange } = renderBar();
    const input = screen.getByTestId("image-toolbar-flip-rotate-angle") as HTMLInputElement;

    input.focus();
    fireEvent.change(input, { target: { value: "abc" } });
    expect(input.value).toBe("abc");

    /**
     * 用 `focusOut` 而不是 `blur`：React 19 的 `onBlur` 挂在 **`focusout`** 上（冒泡的那个），
     * 而 RTL 的 `fireEvent.blur` 只派发不冒泡的 `blur`，React 收不到（实测：组件完全不响应）。
     * 真实浏览器里两者是同一次「失焦」的两条事件，`focusOut` 才是组件实际监听的那条。
     */
    fireEvent.focusOut(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("10");
  });

  it("输入 12.5 后回车同样算非法（小数不接受）", () => {
    const { onChange } = renderBar();
    const input = screen.getByTestId("image-toolbar-flip-rotate-angle") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "12.5" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("10");
  });

  it("「90°」这种带单位后缀的输入也接受", () => {
    const { onChange, state } = renderBar();

    const input = screen.getByTestId("image-toolbar-flip-rotate-angle");
    fireEvent.change(input, { target: { value: "90°" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith({ ...state, angle: 90 });
  });

  it("翻转按钮的 aria-pressed 随 props 翻转（同一 testid 不改名）", () => {
    const { rerender, onChange, onDownload, onExit } = renderBar({
      angle: 10,
      flipH: false,
      flipV: true,
    });

    const flipH = screen.getByTestId("image-toolbar-flip-rotate-flip-h");
    const flipV = screen.getByTestId("image-toolbar-flip-rotate-flip-v");
    expect(flipH.getAttribute("aria-pressed")).toBe("false");
    expect(flipV.getAttribute("aria-pressed")).toBe("true");

    rerender(
      <FlipRotateBar
        state={{ angle: 10, flipH: true, flipV: false }}
        onChange={onChange}
        onDownload={onDownload}
        onExit={onExit}
      />,
    );

    expect(flipH.getAttribute("aria-pressed")).toBe("true");
    expect(flipV.getAttribute("aria-pressed")).toBe("false");
  });

  it("点「旋转」：onChange 收到 rotateStep 的结果（10° → 100°）", () => {
    const { onChange, state } = renderBar();

    fireEvent.click(screen.getByTestId("image-toolbar-flip-rotate-rotate"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...state, angle: 100 });
  });

  it("点两个翻转按钮：分别调 toggleFlip 的「h」与「v」分支", () => {
    const { onChange, state } = renderBar();

    fireEvent.click(screen.getByTestId("image-toolbar-flip-rotate-flip-h"));
    expect(onChange).toHaveBeenLastCalledWith({ ...state, flipH: true });

    fireEvent.click(screen.getByTestId("image-toolbar-flip-rotate-flip-v"));
    expect(onChange).toHaveBeenLastCalledWith({ ...state, flipV: false });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("点「下载」：onDownload 收到当前的 state", () => {
    const { onDownload, state } = renderBar();

    fireEvent.click(screen.getByTestId("image-toolbar-flip-rotate-download"));

    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledWith(state);
  });

  it("按 Esc 调 onExit（window 级监听，焦点在别处）", () => {
    const { onExit } = renderBar();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("焦点在角度输入框里按 Esc 同样调 onExit", () => {
    const { onExit } = renderBar();
    const input = screen.getByTestId("image-toolbar-flip-rotate-angle") as HTMLInputElement;

    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("卸载后 window 上的 Esc 监听被移除（不会再调 onExit）", () => {
    const { onExit, unmount } = renderBar();

    unmount();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onExit).not.toHaveBeenCalled();
  });

  it("「旋转」按钮的图标按钮带 title（与 aria-label 同为中文，不是 \\uXXXX 原文）", () => {
    renderBar();

    const rotate = screen.getByTestId("image-toolbar-flip-rotate-rotate");
    expect(rotate.getAttribute("title")).toBe("旋转 90°");
    // 反向自检：title 里不许出现字面的反斜杠 u 转义
    expect(rotate.getAttribute("title")).not.toContain("\\u");
  });
});
