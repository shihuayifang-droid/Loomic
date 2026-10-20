import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ToolDefinition } from "@loomic/shared";

import { AdjustToolSession } from "../src/components/canvas/adjust-tool-session";
import {
  ADJUST_PREVIEW_BOX,
  makePreviewSource,
  previewSize,
  renderPreview,
} from "../src/lib/adjust-preview";
import {
  ZERO_ADJUST,
  renderAdjust,
  type AdjustParams,
  type PixelBuffer,
} from "../src/lib/adjust-render";

/**
 * 工单 35V · ED-01 调整面板实时预览。
 *
 * 规格 ED-01：「预览与导出用同一套渲染函数」——进面板时降采样一次，之后每次改滑块只重跑
 * 小图；验收 2 的半边（拖滑块更新预览、零网络请求）在这里断言。
 *
 * 本仓 vitest 没开 globals，RTL 不会自动 cleanup。
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 造一个 data 不重复的 `width × height` RGBA 缓冲（值域循环，方便看出渲染差异）。 */
function pixels(width: number, height: number, seed = 0): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 7 + seed * 29) % 256;
  return { width, height, data };
}

/** 工具定义：照 30F 的夹具形状，一个组一个滑块 + `no_adjustment` 规则。 */
const TOOL: ToolDefinition = {
  id: "adjust",
  label: "调整",
  icon: "adjust",
  testid: "image-toolbar-adjust",
  form: "panel",
  default_slot: "more",
  removable: true,
  consumes: false,
  pricing: null,
  output_kind: "image",
  output_format: null,
  file_prefix: null,
  event_type: null,
  disabled_rules: [{ id: "no_adjustment", message: "未做任何调整" }],
  param_groups: [
    {
      id: "light",
      label: "光",
      params: [
        {
          id: "exposure",
          label: "曝光",
          min: -100,
          max: 100,
          defaultValue: 0,
          display: { kind: "linear", a: 1, k: 0 },
        },
      ],
    },
  ],
  eta_seconds: null,
  agent_callable: false,
  availability: "enabled",
};

const NO_OP_AUTO = async () => ({
  exposure: 0,
  contrast: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
});

describe("工单 35V · 调整面板实时预览", () => {
  it("ED-01: the preview fits the panel box keeping the ratio", () => {
    expect(previewSize({ width: 1254, height: 836 }, ADJUST_PREVIEW_BOX)).toEqual({
      width: 240,
      height: 160,
    });
  });

  it("ED-01: a small image is never upscaled", () => {
    expect(previewSize({ width: 100, height: 50 }, ADJUST_PREVIEW_BOX)).toEqual({
      width: 100,
      height: 50,
    });
  });

  it("ED-01: the preview uses the same renderer as the export", () => {
    const source = pixels(4, 3);
    const params: AdjustParams = { ...ZERO_ADJUST, exposure: 35, contrast: -20 };
    expect(renderPreview(source, params)).toEqual(renderAdjust(source, params));
  });

  it("ED-01: the preview source is downsampled once to the preview size", () => {
    const source = pixels(800, 600);
    const preview = makePreviewSource(source, ADJUST_PREVIEW_BOX);
    const expected = previewSize(source, ADJUST_PREVIEW_BOX);
    expect({ width: preview.width, height: preview.height }).toEqual(expected);
  });

  it("ED-01: moving a slider repaints the preview", async () => {
    const previewSource = pixels(2, 2);
    const paint = vi.fn();
    render(
      <AdjustToolSession
        tool={TOOL}
        previewSource={previewSource}
        paint={paint}
        onAuto={NO_OP_AUTO}
        onCancel={() => {}}
        onDone={() => {}}
      />,
    );

    expect(screen.getByTestId("adjust-preview")).toBeInTheDocument();
    expect(paint).toHaveBeenCalledTimes(1);

    const slider = within(screen.getByTestId("adjust-slider-exposure")).getByRole("slider");
    fireEvent.change(slider, { target: { value: "40" } });

    await waitFor(() => expect(paint.mock.calls.length).toBeGreaterThan(1));
    const last = paint.mock.calls[paint.mock.calls.length - 1]!;
    expect(last[1]).toEqual(renderPreview(previewSource, { ...ZERO_ADJUST, exposure: 40 }));
  });

  it("ED-01: the preview makes no network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const previewSource = pixels(2, 2);
    const paint = vi.fn();
    render(
      <AdjustToolSession
        tool={TOOL}
        previewSource={previewSource}
        paint={paint}
        onAuto={NO_OP_AUTO}
        onCancel={() => {}}
        onDone={() => {}}
      />,
    );

    const slider = within(screen.getByTestId("adjust-slider-exposure")).getByRole("slider");
    fireEvent.change(slider, { target: { value: "40" } });
    fireEvent.change(slider, { target: { value: "-25" } });
    await waitFor(() => expect(paint.mock.calls.length).toBeGreaterThan(1));

    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});
