"use client";

import {
  TOOLBAR_HEIGHT,
  TOOLBAR_PADDING_X,
  TOOLBAR_RADIUS,
} from "./image-toolbar";

/**
 * ED-05 · 多选「下载全部」（工单 34W T2，**纯展示**）
 *
 * 多选（≥2，且不是「全是形状/文字」、也不是「图片 + 形状」）时，工具条位置上只有这一个
 * 按钮：它让服务端把选中原图打进一个 zip（ED-05 验收 3「选中 3 张图点『下载全部』，
 * 得到 zip，内含 3 个原图文件」）。
 *
 * ## 本组件不做什么
 *
 * 不取数、不打 zip、不管「已跳过 N 个未完成对象」的提示 —— 选中项怎么筛、请求怎么发、
 * 失败怎么提示，全在 `image-toolbar-layer.tsx` 里。本组件只决定「长什么样」和「忙时什么样」。
 *
 * ## 尺寸
 *
 * 高、左右内边距、圆角都从 `./image-toolbar` import（与 `flip-rotate-bar.tsx` 同一条口径），
 * 不另抄一份数值，否则以后改尺寸就会出现「单图工具条高 44、下载全部还是旧的」这种错位。
 */

export type DownloadAllBarProps = {
  onDownload: () => void;
  /** 请求进行中：按钮 disabled，文案换成「打包中…」（ED-05 的生成中占位）。 */
  busy: boolean;
};

export function DownloadAllBar({ onDownload, busy }: DownloadAllBarProps) {
  return (
    <div
      className="flex items-center border border-border bg-popover shadow-md"
      style={{
        height: TOOLBAR_HEIGHT,
        paddingLeft: TOOLBAR_PADDING_X,
        paddingRight: TOOLBAR_PADDING_X,
        borderRadius: TOOLBAR_RADIUS,
      }}
    >
      <button
        type="button"
        data-testid="image-toolbar-download-all"
        aria-busy={busy}
        disabled={busy}
        onClick={onDownload}
        className="inline-flex items-center justify-center rounded-md px-3 text-xs text-foreground outline-none transition-colors hover:bg-muted disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring"
        style={{ height: TOOLBAR_HEIGHT - 12 }}
      >
        {busy ? "打包中…" : "下载全部"}
      </button>
    </div>
  );
}
