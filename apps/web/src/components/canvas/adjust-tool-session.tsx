"use client";

import { useEffect, useRef, useState } from "react";

import type { ToolDefinition } from "@loomic/shared";

import type { AutoAdjustResult } from "@/lib/adjust-auto";
import { renderPreview } from "@/lib/adjust-preview";
import { ZERO_ADJUST, type AdjustParams, type PixelBuffer } from "@/lib/adjust-render";

import { AdjustPanel, type AdjustParamGroup } from "./adjust-panel";

/** 把一帧像素画到 canvas 上的实现（测试注入，默认走浏览器 2D 上下文）。 */
export type AdjustPreviewPaint = (canvas: HTMLCanvasElement, pixels: PixelBuffer) => void;

/**
 * 默认画笔：按像素尺寸设 canvas，再 `putImageData`。
 *
 * jsdom 里没有 2D 上下文、也没有 `ImageData` 构造器，缺哪一个都**静默跳过**（DOM 树不受影响）。
 */
function browserPaint(canvas: HTMLCanvasElement, pixels: PixelBuffer): void {
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  // jsdom 的 getContext 会抛 "Not implemented"（没装 canvas 包），拿不到上下文就静默跳过。
  let context: CanvasRenderingContext2D | null | undefined;
  try {
    context = canvas.getContext("2d");
  } catch {
    return;
  }
  if (context === null || context === undefined || typeof context.putImageData !== "function") {
    return;
  }
  const image = context.createImageData(pixels.width, pixels.height);
  image.data.set(pixels.data);
  context.putImageData(image, 0, 0);
}

/**
 * ED-01: holds the slider values for one adjust session and hosts {@link AdjustPanel}.
 *
 * The groups come from the tool definition (`param_groups`, MD-03); the panel never
 * touches pixels, so `onAuto` / `onDone` are supplied by the layer.
 *
 * 预览（工单 35V）：给了 `previewSource`（已降采样的小图）就在面板上方渲染一块 canvas，
 * `values` 一变就用同一个 `renderPreview` 重画小图 —— 不重新解码、不发任何网络请求。
 * 不给就只渲染面板（与 35U 行为相同）。
 */
export function AdjustToolSession(props: {
  tool: ToolDefinition;
  onAuto: () => Promise<AutoAdjustResult>;
  onCancel: () => void;
  onDone: (params: AdjustParams) => void;
  previewSource?: PixelBuffer | undefined;
  paint?: AdjustPreviewPaint | undefined;
}) {
  const { tool, onAuto, onCancel, onDone, previewSource, paint } = props;
  const [values, setValues] = useState<AdjustParams>(ZERO_ADJUST);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const groups: AdjustParamGroup[] = (tool.param_groups ?? []).map((group) => ({
    id: group.id,
    label: group.label,
    // Same shape as ParamSliderConfig; zod types optional keys as `T | undefined`,
    // which `exactOptionalPropertyTypes` rejects, hence the one cast.
    params: group.params as unknown as AdjustParamGroup["params"],
  }));

  // 拖滑块 → 重画小图。只重跑渲染函数，解码与降采样都在进面板时做完了。
  useEffect(() => {
    if (previewSource === undefined) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    (paint ?? browserPaint)(canvas, renderPreview(previewSource, values));
  }, [values, previewSource, paint]);

  const panel = (
    <AdjustPanel
      tool={tool}
      groups={groups}
      values={values}
      onChange={setValues}
      onAuto={() => {
        void onAuto()
          .then((result) => setValues((current) => ({ ...current, ...result })))
          .catch(() => {});
      }}
      onCancel={onCancel}
      onDone={onDone}
    />
  );

  if (previewSource === undefined) return panel;

  return (
    <div className="flex flex-col gap-2">
      <canvas
        ref={canvasRef}
        data-testid="adjust-preview"
        width={previewSource.width}
        height={previewSource.height}
        className="block max-w-full border border-border bg-muted"
      />
      {panel}
    </div>
  );
}
