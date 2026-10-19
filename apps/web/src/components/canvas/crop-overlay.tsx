"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

import {
  CROP_HANDLES,
  type CropHandle,
  type CropRect,
  type Size,
  moveRect,
  resizeByHandle,
} from "@/lib/crop-geometry";

/**
 * ED-02 · 裁剪框叠层（工单 30J T4）
 *
 * 三样东西：可整体拖动的裁剪框、8 个手柄、框外 50% 压暗遮罩。
 * **本文件里没有一行几何算法** —— 屏幕位移除以 `displayScale` 之后一律交给
 * `@/lib/crop-geometry` 的 `moveRect` / `resizeByHandle`，这样拖拽规则只有一处真源。
 *
 * ## 为什么用 mouse 事件而不是 pointer 事件
 *
 * 本仓 vitest 的环境是 jsdom 26.1.0，实测 `typeof window.PointerEvent === "undefined"`、
 * `Element.prototype.setPointerCapture` 也不存在。工单 §6 允许在这种情况下改用 mouse 事件，
 * 所以拖拽走 `mousedown` + window 的 `mousemove` / `mouseup`。
 *
 * ## 为什么位移是「相对拖动起点」算的
 *
 * `dragRef` 里存的是**按下那一刻**的 rect 与坐标，每次 `mousemove` 都用
 * 「当前坐标 − 起点坐标」重新算一次，而不是在上一帧的结果上累加：
 * 累加会让取整误差在几百次 mousemove 里越滚越大，且夹边之后无法回拖（位置已经被夹死了）。
 */

export type CropOverlayProps = {
  /** 原图尺寸。 */
  source: Size;
  /** 显示缩放比：屏幕上 1px 对应原图的 `1 / displayScale` px。 */
  displayScale: number;
  /** 当前裁剪框（原图像素）。 */
  rect: CropRect;
  /** 当前比例；`null` = 自由裁剪。 */
  ratio: [number, number] | null;
  onRectChange: (rect: CropRect) => void;
};

/** 手柄的可访问名称（方向按界面上看到的位置说，不用 n/s/e 这类缩写）。 */
const HANDLE_LABELS: Readonly<Record<CropHandle, string>> = {
  n: "上边手柄",
  s: "下边手柄",
  e: "右边手柄",
  w: "左边手柄",
  ne: "右上角手柄",
  nw: "左上角手柄",
  se: "右下角手柄",
  sw: "左下角手柄",
};

/** 手柄的鼠标指针样式：角手柄用对角双箭头，边手柄用单轴双箭头。 */
const HANDLE_CURSORS: Readonly<Record<CropHandle, string>> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

/** 拖动状态：按下那一刻的坐标与裁剪框，后续位移全部相对它计算。 */
type DragState =
  | { mode: "move"; startX: number; startY: number; rect: CropRect }
  | { mode: "resize"; handle: CropHandle; startX: number; startY: number; rect: CropRect };

/** 手柄相对裁剪框边缘的定位：w/e 决定 left，n/s 决定 top，另一轴取中点。 */
function handlePosition(handle: CropHandle, rect: CropRect, scale: number): CSSProperties {
  const left = rect.x * scale;
  const top = rect.y * scale;
  const right = (rect.x + rect.width) * scale;
  const bottom = (rect.y + rect.height) * scale;

  const x = handle.includes("w") ? left : handle.includes("e") ? right : (left + right) / 2;
  const y = handle.includes("n") ? top : handle.includes("s") ? bottom : (top + bottom) / 2;
  return { left: x, top: y };
}

const MASK_COLOR = "rgba(0, 0, 0, 0.5)";

export function CropOverlay({ source, displayScale, rect, ratio, onRectChange }: CropOverlayProps) {
  // 缩放比为 0（或负数）时除法会得到 Infinity，这里退化成 1:1，宁可坐标不准也不要 NaN 传进几何函数。
  const scale = displayScale > 0 ? displayScale : 1;

  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (drag === null) return;
      // 屏幕位移 → 原图像素（工单 §3-T4 明写：除以 displayScale 再交给几何函数）。
      const dx = (event.clientX - drag.startX) / scale;
      const dy = (event.clientY - drag.startY) / scale;
      const next =
        drag.mode === "move"
          ? moveRect(drag.rect, dx, dy, source)
          : resizeByHandle(drag.rect, drag.handle, dx, dy, source, ratio);
      onRectChange(next);
    };
    const handleMouseUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [onRectChange, ratio, scale, source]);

  const beginMove = (event: ReactMouseEvent<HTMLElement>) => {
    // 不 preventDefault 的话，拖动会把页面文字一起选中（原生拖拽行为）。
    event.preventDefault();
    dragRef.current = { mode: "move", startX: event.clientX, startY: event.clientY, rect };
  };

  const beginResize = (event: ReactMouseEvent<HTMLElement>, handle: CropHandle) => {
    event.preventDefault();
    dragRef.current = { mode: "resize", handle, startX: event.clientX, startY: event.clientY, rect };
  };

  const boxLeft = rect.x * scale;
  const boxTop = rect.y * scale;
  const boxWidth = rect.width * scale;
  const boxHeight = rect.height * scale;
  const fullWidth = source.width * scale;
  const fullHeight = source.height * scale;

  /** 四条压暗遮罩（上 / 下 / 左 / 右）：拼出中间那块亮着的裁剪区，尺寸都是显示像素。 */
  const masks = [
    { key: "top", left: 0, top: 0, width: fullWidth, height: boxTop },
    {
      key: "bottom",
      left: 0,
      top: boxTop + boxHeight,
      width: fullWidth,
      height: fullHeight - boxTop - boxHeight,
    },
    { key: "left", left: 0, top: boxTop, width: boxLeft, height: boxHeight },
    {
      key: "right",
      left: boxLeft + boxWidth,
      top: boxTop,
      width: fullWidth - boxLeft - boxWidth,
      height: boxHeight,
    },
  ];

  return (
    <div
      data-testid="crop-overlay"
      className="select-none"
      // 定位由调用方给：这个盒子自己只负责「和显示的图片一样大」。
      style={{ position: "relative", width: fullWidth, height: fullHeight }}
    >
      {/* 框外 50% 压暗：四条遮罩拼出中间那个洞，比 box-shadow 稳（不会被 overflow 裁掉，也不依赖合成层）。 */}
      {masks.map((mask) => (
        <div
          // 四条遮罩是同一种元素，整列共用一个不带值的 testid（CONVENTIONS §1.3 的取法）。
          key={mask.key}
          data-testid="crop-mask"
          aria-hidden="true"
          className="absolute"
          style={{
            left: mask.left,
            top: mask.top,
            width: mask.width,
            height: mask.height,
            background: MASK_COLOR,
          }}
        />
      ))}

      <div
        data-testid="crop-box"
        onMouseDown={beginMove}
        className="absolute border border-primary"
        style={{ left: boxLeft, top: boxTop, width: boxWidth, height: boxHeight, cursor: "move" }}
      />

      {CROP_HANDLES.map((handle) => (
        <button
          key={handle}
          type="button"
          data-testid={`crop-handle-${handle}`}
          aria-label={HANDLE_LABELS[handle]}
          onMouseDown={(event) => beginResize(event, handle)}
          className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-primary bg-popover"
          style={{ ...handlePosition(handle, rect, scale), cursor: HANDLE_CURSORS[handle] }}
        />
      ))}
    </div>
  );
}
