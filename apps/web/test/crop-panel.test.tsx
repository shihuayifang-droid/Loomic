import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { CropOverlay } from "../src/components/canvas/crop-overlay";
import { CropPanel } from "../src/components/canvas/crop-panel";
import type { CropRect, Size, SizePreset } from "../src/lib/crop-geometry";

/**
 * 工单 30J T5 · ED-02 裁剪面板与叠层。
 *
 * 覆盖规格 ED-02 的验收 1/2/3（联动、超限文案、拖手柄宽高同步）与 §3-T5 点名的其余项。
 *
 * **预设是 fixture**：web 代码里不许出现具体预设名（裁决 4，X-P11 由服务端下发），
 * 所以这里自己造三条，`id` 用业务键（`free` / `xhs-3-4` / `ratio-1-1`），显示名用中性中文。
 *
 * jsdom 里 `typeof window.PointerEvent === "undefined"`，组件的拖拽走 mouse 事件
 * （工单 §6 允许），所以这里用 `fireEvent.mouseDown` + window 上的 `mousemove`。
 */
afterEach(() => {
  cleanup();
});

const SOURCE: Size = { width: 1254, height: 1254 };

const PRESETS: SizePreset[] = [
  { id: "free", name: "通用", ratio: null },
  { id: "xhs-3-4", name: "三比四", ratio: [3, 4] },
  { id: "ratio-1-1", name: "一比一", ratio: [1, 1] },
];

const FULL_RECT: CropRect = { x: 0, y: 0, width: 1254, height: 1254 };

/**
 * 受控外壳：`CropPanel` 自己不持有裁剪框，测试要「点预设 → 框变 → 再改 W」这种连续流程，
 * 就得有一个真的会把 `onRectChange` 写回去的父组件。
 */
function Harness({
  initialRect = FULL_RECT,
  presets = PRESETS,
  onDone = () => {},
  onCancel = () => {},
}: {
  initialRect?: CropRect;
  presets?: SizePreset[];
  onDone?: (rect: CropRect) => void;
  onCancel?: () => void;
}) {
  const [rect, setRect] = useState<CropRect>(initialRect);
  return (
    <CropPanel
      source={SOURCE}
      presets={presets}
      rect={rect}
      onRectChange={setRect}
      onCancel={onCancel}
      onDone={onDone}
    />
  );
}

describe("CropPanel（ED-02）", () => {
  it("预设列表：role=tablist + aria-label「裁剪比例」，每项 role=tab 且带 crop-preset-{id}", () => {
    render(<Harness />);

    const tablist = screen.getByRole("tablist", { name: "裁剪比例" });
    expect(tablist).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    for (const preset of PRESETS) {
      expect(screen.getByTestId(`crop-preset-${preset.id}`)).toBeTruthy();
    }
    // 默认选中第一个（通用）
    expect(screen.getByTestId("crop-preset-free").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("crop-preset-xhs-3-4").getAttribute("aria-selected")).toBe("false");
  });

  it("W/H 输入框存在，初始值为整图尺寸", () => {
    render(<Harness />);

    expect((screen.getByTestId("crop-width-input") as HTMLInputElement).value).toBe("1254");
    expect((screen.getByTestId("crop-height-input") as HTMLInputElement).value).toBe("1254");
  });

  it("选 xhs-3-4：裁剪框换成最大 3:4 矩形（941×1254），aria-selected 跟着走", () => {
    render(<Harness />);

    fireEvent.click(screen.getByTestId("crop-preset-xhs-3-4"));

    expect((screen.getByTestId("crop-width-input") as HTMLInputElement).value).toBe("941");
    expect((screen.getByTestId("crop-height-input") as HTMLInputElement).value).toBe("1254");
    expect(screen.getByTestId("crop-preset-xhs-3-4").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("crop-preset-free").getAttribute("aria-selected")).toBe("false");
  });

  it("验收 1：选 xhs-3-4 后把 W 改为 900 → H 输入框显示 1200", () => {
    render(<Harness />);

    fireEvent.click(screen.getByTestId("crop-preset-xhs-3-4"));
    const width = screen.getByTestId("crop-width-input");
    fireEvent.change(width, { target: { value: "900" } });

    expect((width as HTMLInputElement).value).toBe("900");
    expect((screen.getByTestId("crop-height-input") as HTMLInputElement).value).toBe("1200");
    // 联动之后「完成」可以点（框已经不是整图了）
    expect(screen.getByTestId("crop-done-button")).not.toBeDisabled();
  });

  it("改 H 也按比例联动 W（1200 → 900）", () => {
    render(<Harness />);

    fireEvent.click(screen.getByTestId("crop-preset-xhs-3-4"));
    fireEvent.change(screen.getByTestId("crop-height-input"), { target: { value: "1200" } });

    expect((screen.getByTestId("crop-width-input") as HTMLInputElement).value).toBe("900");
  });

  it("「通用」不联动：改 W 只动宽", () => {
    render(<Harness />);

    fireEvent.change(screen.getByTestId("crop-width-input"), { target: { value: "900" } });

    expect((screen.getByTestId("crop-width-input") as HTMLInputElement).value).toBe("900");
    expect((screen.getByTestId("crop-height-input") as HTMLInputElement).value).toBe("1254");
  });

  it("验收 2：W 输入 2000 → 「完成」disabled，crop-reason 为「不能超过原图宽度 1254」，输入框 aria-invalid", () => {
    render(<Harness />);

    const width = screen.getByTestId("crop-width-input");
    fireEvent.change(width, { target: { value: "2000" } });

    expect(screen.getByTestId("crop-done-button")).toBeDisabled();
    expect(screen.getByTestId("crop-reason").textContent).toBe("不能超过原图宽度 1254");
    expect(width.getAttribute("aria-invalid")).toBe("true");
    expect(width.getAttribute("aria-describedby")).toBe("crop-reason");
  });

  it("非法输入不会改写裁剪框（W/H 的显示留着用户敲的值）", () => {
    render(<Harness />);

    const height = screen.getByTestId("crop-height-input");
    fireEvent.change(height, { target: { value: "abc" } });

    expect((height as HTMLInputElement).value).toBe("abc");
    expect(screen.getByTestId("crop-reason").textContent).toBe("必须是正整数");
    expect((screen.getByTestId("crop-width-input") as HTMLInputElement).value).toBe("1254");
  });

  it("rect 为整图时「完成」disabled，title 为「未做裁剪」", () => {
    render(<Harness />);

    const done = screen.getByTestId("crop-done-button");
    expect(done).toBeDisabled();
    expect(done.getAttribute("title")).toBe("未做裁剪");
    expect(screen.getByTestId("crop-reason").textContent).toBe("未做裁剪");
  });

  it("可点时「完成」不 disabled、没有 title，点击把当前 rect 交给 onDone", () => {
    const onDone = vi.fn();
    render(<Harness initialRect={{ x: 157, y: 0, width: 941, height: 1254 }} onDone={onDone} />);

    const done = screen.getByTestId("crop-done-button");
    expect(done).not.toBeDisabled();
    expect(done.getAttribute("title")).toBeNull();

    fireEvent.click(done);

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith({ x: 157, y: 0, width: 941, height: 1254 });
  });

  it("「取消」调 onCancel", () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);

    fireEvent.click(screen.getByTestId("crop-cancel-button"));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("面板根节点的 testid 是 crop-panel", () => {
    render(<Harness />);
    expect(screen.getByTestId("crop-panel")).toBeTruthy();
  });
});

describe("CropOverlay（ED-02 验收 3：拖手柄后 W/H 同步）", () => {
  const SRC: Size = { width: 1254, height: 1254 };
  const RECT: CropRect = { x: 100, y: 100, width: 500, height: 500 };

  function renderOverlay(overrides: Partial<Parameters<typeof CropOverlay>[0]> = {}) {
    const onRectChange = vi.fn();
    render(
      <CropOverlay
        source={SRC}
        displayScale={0.5}
        rect={RECT}
        ratio={null}
        onRectChange={onRectChange}
        {...overrides}
      />,
    );
    return { onRectChange };
  }

  it("8 个手柄都在，且各有 aria-label", () => {
    renderOverlay();

    const labels: ReadonlyArray<[string, string]> = [
      ["crop-handle-n", "上边手柄"],
      ["crop-handle-s", "下边手柄"],
      ["crop-handle-e", "右边手柄"],
      ["crop-handle-w", "左边手柄"],
      ["crop-handle-ne", "右上角手柄"],
      ["crop-handle-nw", "左上角手柄"],
      ["crop-handle-se", "右下角手柄"],
      ["crop-handle-sw", "左下角手柄"],
    ];
    for (const [testid, label] of labels) {
      const handle = screen.getByTestId(testid);
      expect(handle.getAttribute("aria-label"), `${testid} 的 aria-label`).toBe(label);
      expect(screen.getByRole("button", { name: label })).toBe(handle);
    }
  });

  it("验收 3：displayScale=0.5 时把 crop-handle-se 拖 +50px，宽高各 +100", () => {
    const { onRectChange } = renderOverlay();

    // 屏幕 +50px ÷ 0.5 = 原图 +100px
    fireEvent.mouseDown(screen.getByTestId("crop-handle-se"), { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 150, clientY: 150 });

    expect(onRectChange).toHaveBeenCalledTimes(1);
    expect(onRectChange).toHaveBeenLastCalledWith({ x: 100, y: 100, width: 600, height: 600 });
  });

  it("拖 crop-box 整体平移：位移同样除以 displayScale，尺寸不变", () => {
    const { onRectChange } = renderOverlay();

    fireEvent.mouseDown(screen.getByTestId("crop-box"), { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 30 });

    // +20px ÷ 0.5 = +40 原图像素
    expect(onRectChange).toHaveBeenLastCalledWith({ x: 140, y: 140, width: 500, height: 500 });
  });

  it("松开鼠标后 mousemove 不再改框（window 监听已解除拖动状态）", () => {
    const { onRectChange } = renderOverlay();

    fireEvent.mouseDown(screen.getByTestId("crop-handle-e"), { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 300, clientY: 300 });

    expect(onRectChange).not.toHaveBeenCalled();
  });

  it("有比例时拖角手柄按比例联动（游标 dy 被忽略）", () => {
    const { onRectChange } = renderOverlay({ ratio: [3, 4] });

    // 宽 +100 → 600，高按 3:4 联动 = 800
    fireEvent.mouseDown(screen.getByTestId("crop-handle-se"), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 50, clientY: 999 });

    expect(onRectChange).toHaveBeenLastCalledWith({ x: 100, y: 100, width: 600, height: 800 });
  });

  it("裁剪框与整张图一样大时，四条遮罩都是 0 面积（没有压暗区）", () => {
    render(
      <CropOverlay
        source={SRC}
        displayScale={1}
        rect={{ x: 0, y: 0, width: 1254, height: 1254 }}
        ratio={null}
        onRectChange={() => {}}
      />,
    );

    const masks = screen.getAllByTestId("crop-mask");
    expect(masks).toHaveLength(4);
    for (const mask of masks) {
      const style = (mask as HTMLElement).style;
      const width = Number.parseFloat(style.width === "" ? "0" : style.width);
      const height = Number.parseFloat(style.height === "" ? "0" : style.height);
      expect(width * height).toBe(0);
    }
  });

  it("裁剪框比整图小时，遮罩面积之和等于「整图 − 裁剪框」的显示面积", () => {
    // displayScale = 1，rect 500×500 在原图正中：1254² − 500² = 1572916 − 250000
    render(
      <CropOverlay
        source={SRC}
        displayScale={1}
        rect={{ x: 377, y: 377, width: 500, height: 500 }}
        ratio={null}
        onRectChange={() => {}}
      />,
    );

    const area = screen
      .getAllByTestId("crop-mask")
      .map((mask) => (mask as HTMLElement).style)
      .reduce(
        (sum, style) =>
          sum +
          Number.parseFloat(style.width === "" ? "0" : style.width) *
            Number.parseFloat(style.height === "" ? "0" : style.height),
        0,
      );
    expect(area).toBe(1254 * 1254 - 500 * 500);
  });
});
