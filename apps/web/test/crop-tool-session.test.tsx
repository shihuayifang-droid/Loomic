import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";

import { CROP_STAGE_BOX, CropToolSession } from "../src/components/canvas/crop-tool-session";
import { type CropRect, type Size, resizeByHandle } from "../src/lib/crop-geometry";

/**
 * 工单 35W · ED-02 裁剪会话：叠层接到面板上（验收 3「拖裁剪框手柄，W/H 同步变化」）。
 *
 * 期望值**不手写魔法数**：拖手柄的结果一律先在这里用同一个 `resizeByHandle` 算出来，
 * 再断言面板输入框显示的就是那个值 —— 几何规则的真源只有 `@/lib/crop-geometry` 一处。
 *
 * jsdom 里没有 `PointerEvent`（`CropOverlay` 文件头已说明），所以拖拽走 mouse 事件。
 */
afterEach(() => {
  cleanup();
});

const SOURCE: Size = { width: 1254, height: 1254 };
const FULL_RECT: CropRect = { x: 0, y: 0, width: 1254, height: 1254 };

/** 叠层与测试共用的显示缩放比：长边缩到预览盒里。 */
const SCALE = Math.min(1, CROP_STAGE_BOX / Math.max(SOURCE.width, SOURCE.height));

function widthInput(): HTMLInputElement {
  return screen.getByTestId("crop-width-input") as HTMLInputElement;
}

function heightInput(): HTMLInputElement {
  return screen.getByTestId("crop-height-input") as HTMLInputElement;
}

function renderSession(sourceDataUrl?: string) {
  return render(
    <CropToolSession
      source={SOURCE}
      {...(sourceDataUrl === undefined ? {} : { sourceDataUrl })}
      onCancel={() => {}}
      onDone={() => {}}
    />,
  );
}

describe("CropToolSession（ED-02 叠层接入）", () => {
  it("ED-02: the crop box sits over the original", () => {
    renderSession("data:x");

    const stage = screen.getByTestId("crop-stage");
    const image = stage.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("src")).toContain("data:x");
    // 长边 = 预览盒（1254 × 280/1254 = 280）。
    expect(stage.style.width).toBe(`${CROP_STAGE_BOX}px`);
    // 叠层就在 stage 里面（覆盖在原图上）。
    expect(stage.querySelector("[data-testid='crop-overlay']")).not.toBeNull();
  });

  it("ED-02: dragging a handle updates W and H", () => {
    renderSession("data:x");

    // 屏幕 -28px ÷ 显示缩放比 = 原图位移（与 CropOverlay 里那一步完全一致）。
    const expected = resizeByHandle(FULL_RECT, "se", -28 / SCALE, -28 / SCALE, SOURCE, null);
    expect(expected.width).toBeLessThan(SOURCE.width);

    fireEvent.mouseDown(screen.getByTestId("crop-handle-se"), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: -28, clientY: -28 });
    fireEvent.mouseUp(window);

    expect(widthInput().value).toBe(String(expected.width));
    expect(heightInput().value).toBe(String(expected.height));
  });

  it("ED-02: a ratio preset constrains the drag", () => {
    renderSession("data:x");

    fireEvent.click(screen.getByTestId("crop-preset-1-1"));

    // 只改 x 方向：dy 为 0，高由 [1,1] 联动出来。
    const expected = resizeByHandle(FULL_RECT, "se", -28 / SCALE, 0, SOURCE, [1, 1]);

    fireEvent.mouseDown(screen.getByTestId("crop-handle-se"), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: -28, clientY: 0 });
    fireEvent.mouseUp(window);

    expect(widthInput().value).toBe(String(expected.width));
    expect(heightInput().value).toBe(String(expected.height));
    // 比例约束下拖出来的框是正方形。
    expect(widthInput().value).toBe(heightInput().value);
  });

  it("ED-02: without the original no stage is shown", () => {
    renderSession();

    expect(screen.queryByTestId("crop-stage")).toBeNull();
    expect(screen.getByTestId("crop-panel")).toBeTruthy();
    expect(widthInput().value).toBe("1254");
    expect(heightInput().value).toBe("1254");
  });
});
