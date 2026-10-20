/**
 * ED-01 · 调整面板的实时预览（纯函数，工单 35V）
 *
 * 预览与导出共用 {@link renderAdjust}：进面板时把原图 {@link downsample} 一次到面板尺寸，
 * 之后每次拖滑块只重跑小图。两者用同一套渲染函数，所以预览与导出不会「看起来不一样」。
 *
 * 本文件不碰 DOM、不发请求，像素操作全部来自 `adjust-render`。
 */

import {
  downsample,
  renderAdjust,
  type AdjustParams,
  type PixelBuffer,
} from "./adjust-render";

/** 预览框的边长（px）：预览图的最长边不会超过它。 */
export const ADJUST_PREVIEW_BOX = 240;

/**
 * ED-01: the preview size — fit inside `box` keeping the ratio, never upscale, at least 1×1.
 */
export function previewSize(
  source: { width: number; height: number },
  box: number,
): { width: number; height: number } {
  const limit = Math.max(1, box);
  const longest = Math.max(source.width, source.height);
  // 小图不放大：比例上限 1。
  const scale = longest > 0 ? Math.min(1, limit / longest) : 1;
  return {
    width: Math.max(1, Math.min(source.width, Math.round(source.width * scale))),
    height: Math.max(1, Math.min(source.height, Math.round(source.height * scale))),
  };
}

/**
 * ED-01: downsample once, then every slider change re-renders the small buffer with the SAME renderAdjust.
 */
export function makePreviewSource(src: PixelBuffer, box: number): PixelBuffer {
  const size = previewSize(src, box);
  return downsample(src, size.width, size.height);
}

/** ED-01: 用与导出同一个 `renderAdjust` 渲染预览小图。 */
export function renderPreview(
  previewSource: PixelBuffer,
  params: AdjustParams,
): PixelBuffer {
  return renderAdjust(previewSource, params);
}
