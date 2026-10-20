"use client";

import { useEffect, useRef, useState } from "react";

import {
  type CropRect,
  type Size,
  type SizePreset,
  applyDimensions,
  doneDisabledReason,
  fitRatioRect,
  linkedHeight,
  linkedWidth,
  validateDimension,
} from "@/lib/crop-geometry";

/**
 * ED-02 · 裁剪面板（工单 30J T4）
 *
 * 只做「面板」这件事：比例预设、W/H 两个输入、取消/完成。
 * **几何全部在 `@/lib/crop-geometry` 里**，本组件只负责把用户输入翻译成函数调用。
 *
 * ## 预设由调用方传入（工单 §2 裁决 4）
 *
 * 规格正文里那些社媒预设名**不许写进 web 代码**（X-P11：由服务端下发；X-10 的预设接口属于后端）。
 * 所以 `presets` 是 props，测试用自己的 fixture；本文件里没有任何具体预设名。
 *
 * ## 联动与非法态
 *
 * - 选了有比例的预设后改 W，H 按裁决 5 自动联动；改 H 同理。选「通用」（`ratio: null`）不联动。
 * - 输入非法时**不改裁剪框**、只把 `aria-invalid` 与原因显示出来；「完成」同时置灰，
 *   并把原因挂到 `title` 上（鼠标悬停能看到为什么点不了）。
 * - 原因文案全部来自 `@/lib/crop-geometry`，本组件不自己拼中文。
 */

export type CropPanelProps = {
  /** 原图尺寸。 */
  source: Size;
  /** 比例预设。来自服务端，组件不写死。 */
  presets: SizePreset[];
  /** 当前裁剪框（原图像素）。 */
  rect: CropRect;
  onRectChange: (rect: CropRect) => void;
  onCancel: () => void;
  onDone: (rect: CropRect) => void;
  /**
   * ED-02（工单 35W）：选预设时把该预设的比例报给调用方（叠层拖手柄要按同一个比例约束）。
   * 可选：不传时面板行为与之前完全一致。
   */
  onRatioChange?: (ratio: [number, number] | null) => void;
};

const PRESET_CLASS =
  "rounded-md px-2 py-1 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring";
const FIELD_CLASS =
  "h-8 w-20 rounded-md border bg-transparent px-2 text-right text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
const BUTTON_CLASS =
  "rounded-md border border-border px-3 py-1 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

export function CropPanel({
  source,
  presets,
  rect,
  onRectChange,
  onCancel,
  onDone,
  onRatioChange,
}: CropPanelProps) {
  /** 默认选中第一个预设（调用方把「通用 / 不裁剪」排在第一，与整图的初始框一致）。 */
  const [selectedId, setSelectedId] = useState<string | null>(() => presets[0]?.id ?? null);

  /**
   * 两个输入框是**草稿**，不直接读 `rect`：用户敲 `"2000"` 的过程中 `"2"`、`"20"` 都合法，
   * 每敲一个键就写回裁剪框会让框在拖动之外乱跳。`rect` 被外部改（叠层拖动）时再由 effect 同步回来。
   */
  const [widthDraft, setWidthDraft] = useState(() => String(rect.width));
  const [heightDraft, setHeightDraft] = useState(() => String(rect.height));

  useEffect(() => {
    setWidthDraft(String(rect.width));
  }, [rect.width]);

  useEffect(() => {
    setHeightDraft(String(rect.height));
  }, [rect.height]);

  const selectedRatio = presets.find((preset) => preset.id === selectedId)?.ratio ?? null;

  /** 裁决 6：选预设 → 取原图内能放下的最大同比例矩形并居中。 */
  const selectPreset = (preset: SizePreset) => {
    setSelectedId(preset.id);
    onRatioChange?.(preset.ratio);
    const next = fitRatioRect(source, preset.ratio);
    setWidthDraft(String(next.width));
    setHeightDraft(String(next.height));
    onRectChange(next);
  };

  /** 改宽：合法才动裁剪框；有比例时高度按裁决 5 联动，并把联动值显示到 H 输入框。 */
  const changeWidth = (raw: string) => {
    setWidthDraft(raw);
    const width = validateDimension(raw, "width", source.width);
    if (!width.ok) return;
    if (selectedRatio === null) {
      onRectChange(applyDimensions(rect, width.value, rect.height, source));
      return;
    }
    const height = linkedHeight(width.value, selectedRatio);
    setHeightDraft(String(height));
    onRectChange(applyDimensions(rect, width.value, height, source));
  };

  /** 改高：对称于 {@link changeWidth}。 */
  const changeHeight = (raw: string) => {
    setHeightDraft(raw);
    const height = validateDimension(raw, "height", source.height);
    if (!height.ok) return;
    if (selectedRatio === null) {
      onRectChange(applyDimensions(rect, rect.width, height.value, source));
      return;
    }
    const width = linkedWidth(height.value, selectedRatio);
    setWidthDraft(String(width));
    onRectChange(applyDimensions(rect, width, height.value, source));
  };

  /** 裁决 8：不可点的原因（先宽、再高、最后「未做裁剪」）；`null` 表示可以点。 */
  const reason = doneDisabledReason(widthDraft, heightDraft, rect, source);
  const widthInvalid = !validateDimension(widthDraft, "width", source.width).ok;
  const heightInvalid = !validateDimension(heightDraft, "height", source.height).ok;
  const describedBy = reason === null ? undefined : "crop-reason";

  return (
    <div data-testid="crop-panel" className="flex flex-col gap-2 border border-border bg-popover p-2">
      <div role="tablist" aria-label="裁剪比例" className="flex items-center gap-1">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="tab"
            // 选中态写在 aria-selected 上，不改 testid（CONVENTIONS §1.2）。
            aria-selected={preset.id === selectedId}
            data-testid={`crop-preset-${preset.id}`}
            onClick={() => selectPreset(preset)}
            className={PRESET_CLASS}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-xs text-muted-foreground">
          宽
        </span>
        <input
          data-testid="crop-width-input"
          aria-label="裁剪宽度"
          aria-invalid={widthInvalid}
          aria-describedby={describedBy}
          type="text"
          inputMode="numeric"
          value={widthDraft}
          onChange={(event) => changeWidth(event.currentTarget.value)}
          className={`${FIELD_CLASS} ${widthInvalid ? "border-destructive" : "border-border"}`}
        />
        <span aria-hidden="true" className="text-xs text-muted-foreground">
          高
        </span>
        <input
          data-testid="crop-height-input"
          aria-label="裁剪高度"
          aria-invalid={heightInvalid}
          aria-describedby={describedBy}
          type="text"
          inputMode="numeric"
          value={heightDraft}
          onChange={(event) => changeHeight(event.currentTarget.value)}
          className={`${FIELD_CLASS} ${heightInvalid ? "border-destructive" : "border-border"}`}
        />
      </div>

      {reason === null ? null : (
        <div id="crop-reason" data-testid="crop-reason" className="text-xs text-destructive">
          {reason}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="crop-cancel-button"
          onClick={onCancel}
          className={BUTTON_CLASS}
        >
          取消
        </button>
        <button
          type="button"
          data-testid="crop-done-button"
          disabled={reason !== null}
          // 置灰时把原因挂到 title：鼠标能看出为什么点不了。
          title={reason ?? undefined}
          onClick={() => onDone(rect)}
          className={BUTTON_CLASS}
        >
          完成
        </button>
      </div>
    </div>
  );
}
