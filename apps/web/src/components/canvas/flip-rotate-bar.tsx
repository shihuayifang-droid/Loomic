"use client";

import { useEffect, useState } from "react";

import type { FlipRotateState } from "@/lib/flip-rotate";
import { parseAngleInput, rotateStep, toggleFlip } from "@/lib/flip-rotate";

import {
  TOOLBAR_BUTTON,
  TOOLBAR_GAP,
  TOOLBAR_HEIGHT,
  TOOLBAR_PADDING_X,
  TOOLBAR_RADIUS,
} from "./image-toolbar";

/**
 * ED-03 · 翻转与旋转的二级工具条（工单 30J T2，**纯展示**）
 *
 * 五项：角度输入 ｜ 旋转 90° ｜ 水平翻转 ｜ 垂直翻转 ｜ 下载。
 * 本组件不持有状态、不导出文件、不接入画布 —— `onChange` / `onDownload` / `onExit` 都由调用方决定。
 *
 * ## 尺寸必须和主工具条一致
 *
 * ED-03 要求二级条**替换**主工具条，所以高度、按钮尺寸、间距、内边距、圆角**全部从
 * `./image-toolbar` import**，本文件不另抄一份数值。规格以后改一处，两条一起变。
 *
 * ## 角度输入的口径（工单 §2 裁决 1）
 *
 * 输入框里允许敲任意整数（含负数、大于 360 的），按回车或失焦时用 `parseAngleInput` 解析：
 * 合法 → `onChange`（值已归一到 `[0, 360)`）；非法 → 把输入框**恢复成 `state.angle`**，且不调 `onChange`。
 *
 * ## 键盘
 *
 * 只要组件挂着，window 级的 Esc 就调 `onExit` —— 焦点在角度输入框里时同样生效，
 * 所以监听挂在 window 上而不是容器上（输入框会吞掉冒泡到容器的按键之前，window 更稳）。
 * 卸载时移除监听。
 */

export type FlipRotateBarProps = {
  state: FlipRotateState;
  onChange: (next: FlipRotateState) => void;
  onDownload: (state: FlipRotateState) => void;
  onExit: () => void;
};

/** 图标按钮与输入框共用的外壳样式（与主工具条按钮同款的 hover / focus 环）。 */
const ITEM_CLASS =
  "inline-flex items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** 旋转图标：一个带缺口的圆加箭头，纯装饰（`aria-hidden`，语义在按钮的 aria-label 上）。 */
function RotateGlyph() {
  return (
    <span aria-hidden="true" className="pointer-events-none flex items-center justify-center">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="size-4">
        <path d="M13 8a5 5 0 1 1-1.6-3.7" />
        <path d="M13 2.5V5h-2.5" />
      </svg>
    </span>
  );
}

/** 翻转图标：一条竖线加两块方向相反的三角，`axis` 决定镜像轴的方向。 */
function FlipGlyph({ axis }: { axis: "h" | "v" }) {
  return (
    <span aria-hidden="true" className="pointer-events-none flex items-center justify-center">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="size-4">
        {axis === "h" ? (
          <>
            <path d="M8 2v12" />
            <path d="M6 4.5 2.5 8 6 11.5z" />
            <path d="M10 4.5 13.5 8 10 11.5z" />
          </>
        ) : (
          <>
            <path d="M2 8h12" />
            <path d="M4.5 6 8 2.5 11.5 6z" />
            <path d="M4.5 10 8 13.5 11.5 10z" />
          </>
        )}
      </svg>
    </span>
  );
}

/** 下载图标：托盘加向下的箭头。 */
function DownloadGlyph() {
  return (
    <span aria-hidden="true" className="pointer-events-none flex items-center justify-center">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="size-4">
        <path d="M8 2.5v7" />
        <path d="M5 7l3 3 3-3" />
        <path d="M2.5 12.5h11" />
      </svg>
    </span>
  );
}

export function FlipRotateBar({ state, onChange, onDownload, onExit }: FlipRotateBarProps) {
  /**
   * 输入框的**草稿**。它不直接等于 `state.angle`：用户敲到一半（`"45"` 想改成 `"450"`）时
   * 中间态也是合法的，若每敲一个键就 onChange，父组件会把 `"4"` 当成 4° 立刻应用。
   * 所以只有回车/失焦才提交，`state.angle` 被外部改（点旋转、Esc 撤销）时再由 effect 同步回来。
   */
  const [draft, setDraft] = useState(() => String(state.angle));

  useEffect(() => {
    setDraft(String(state.angle));
  }, [state.angle]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onExit]);

  /** 回车 / 失焦共用：合法就提交，非法就把草稿恢复成当前角度（不调 onChange）。 */
  const commitAngle = () => {
    const parsed = parseAngleInput(draft);
    if (parsed === null) {
      setDraft(String(state.angle));
      return;
    }
    setDraft(String(parsed));
    onChange({ ...state, angle: parsed });
  };

  return (
    <div
      data-testid="image-toolbar-flip-rotate"
      className="flex items-center border border-border bg-popover shadow-md"
      style={{
        height: TOOLBAR_HEIGHT,
        paddingLeft: TOOLBAR_PADDING_X,
        paddingRight: TOOLBAR_PADDING_X,
        borderRadius: TOOLBAR_RADIUS,
        gap: TOOLBAR_GAP,
      }}
    >
      <span className="flex items-center" style={{ gap: TOOLBAR_GAP }}>
        <input
          data-testid="image-toolbar-flip-rotate-angle"
          aria-label="旋转角度"
          // 输入的是原始文本（`450`、`-90`、`90°` 都允许），归一交给 parseAngleInput。
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitAngle();
          }}
          onBlur={commitAngle}
          className="rounded-md border border-border bg-transparent px-1 text-center text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ width: TOOLBAR_BUTTON + TOOLBAR_GAP * 2, height: TOOLBAR_BUTTON }}
        />
        {/* 单位标记：读屏器由 aria-label 拿到「旋转角度」，这个 `°` 只是视觉提示。 */}
        <span aria-hidden="true" className="text-xs text-muted-foreground">
          °
        </span>
      </span>

      <button
        type="button"
        data-testid="image-toolbar-flip-rotate-rotate"
        aria-label="旋转 90°"
        title="旋转 90°"
        onClick={() => onChange(rotateStep(state))}
        className={ITEM_CLASS}
        style={{ width: TOOLBAR_BUTTON, height: TOOLBAR_BUTTON }}
      >
        <RotateGlyph />
      </button>

      <button
        type="button"
        data-testid="image-toolbar-flip-rotate-flip-h"
        aria-label="水平翻转"
        title="水平翻转"
        aria-pressed={state.flipH}
        onClick={() => onChange(toggleFlip(state, "h"))}
        className={ITEM_CLASS}
        style={{ width: TOOLBAR_BUTTON, height: TOOLBAR_BUTTON }}
      >
        <FlipGlyph axis="h" />
      </button>

      <button
        type="button"
        data-testid="image-toolbar-flip-rotate-flip-v"
        aria-label="垂直翻转"
        title="垂直翻转"
        aria-pressed={state.flipV}
        onClick={() => onChange(toggleFlip(state, "v"))}
        className={ITEM_CLASS}
        style={{ width: TOOLBAR_BUTTON, height: TOOLBAR_BUTTON }}
      >
        <FlipGlyph axis="v" />
      </button>

      <button
        type="button"
        data-testid="image-toolbar-flip-rotate-download"
        aria-label="下载"
        title="下载"
        onClick={() => onDownload(state)}
        className={ITEM_CLASS}
        style={{ width: TOOLBAR_BUTTON, height: TOOLBAR_BUTTON }}
      >
        <DownloadGlyph />
      </button>
    </div>
  );
}
