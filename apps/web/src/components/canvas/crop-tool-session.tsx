"use client";

import { useState } from "react";

import { CROP_PRESETS } from "@/lib/crop-commit";
import type { CropRect, Size } from "@/lib/crop-geometry";

import { CropOverlay } from "./crop-overlay";
import { CropPanel } from "./crop-panel";

/**
 * ED-02 · crop session（工单 35S / 35W）
 *
 * Owns the crop rect state (initially the whole image) and renders two things:
 *
 * - 叠层：有原图 dataURL 时，在上面渲染 `crop-stage`（图片缩略图 + `CropOverlay`），
 *   拖手柄 / 整体平移都直接改同一个 `rect`；
 * - 面板：`CropPanel` 的 W/H 由它自己的 `useEffect([rect.width])` 跟随 `rect`，
 *   所以拖动之后输入框里的数字会同步（工单 30J 已实现）。
 *
 * 比例同样放在这里：`CropPanel` 只是把用户选的预设比例**报上来**
 * （`onRatioChange`），再交回给 `CropOverlay` 用来约束拖拽 —— 两者必须用同一个值。
 */

/** 预览盒子的长边上限（显示像素）：原图大于它就等比缩小，小于它则按原尺寸显示。 */
export const CROP_STAGE_BOX = 280;

export function CropToolSession(props: {
  source: Size;
  /** 原图 dataURL（ED-00j 的原始图）。只有它存在时才显示上面的预览与叠层。 */
  sourceDataUrl?: string;
  onCancel: () => void;
  onDone: (rect: CropRect) => void;
}) {
  const { source, sourceDataUrl, onCancel, onDone } = props;

  const [rect, setRect] = useState<CropRect>({
    x: 0,
    y: 0,
    width: source.width,
    height: source.height,
  });
  /** 当前比例预设（初值取第一个预设，与 `CropPanel` 的默认选中一致）。 */
  const [ratio, setRatio] = useState<[number, number] | null>(() => CROP_PRESETS[0]?.ratio ?? null);

  // 屏幕像素 = 原图像素 × scale。小图不放大（`Math.min(1, ...)`），大图缩到预览盒里。
  const scale = Math.min(1, CROP_STAGE_BOX / Math.max(source.width, source.height));

  return (
    <div className="flex flex-col gap-2">
      {sourceDataUrl === undefined ? null : (
        <div
          data-testid="crop-stage"
          style={{
            position: "relative",
            width: source.width * scale,
            height: source.height * scale,
          }}
        >
          <img
            src={sourceDataUrl}
            alt=""
            draggable={false}
            style={{ width: "100%", height: "100%" }}
          />
          {/* 叠层压在图上面：`CropOverlay` 自己的盒子就是「和显示的图片一样大」。 */}
          <div style={{ position: "absolute", left: 0, top: 0 }}>
            <CropOverlay
              source={source}
              displayScale={scale}
              rect={rect}
              ratio={ratio}
              onRectChange={setRect}
            />
          </div>
        </div>
      )}
      <CropPanel
        source={source}
        presets={[...CROP_PRESETS]}
        rect={rect}
        onRectChange={setRect}
        onCancel={onCancel}
        onDone={onDone}
        onRatioChange={setRatio}
      />
    </div>
  );
}
