"use client";

import type { ToolDefinition } from "@loomic/shared";

import {
  ADJUST_PARAM_IDS,
  ZERO_ADJUST,
  isZeroAdjust,
  type AdjustParamId,
  type AdjustParams,
} from "@/lib/adjust-render";
import { type ParamSliderConfig } from "@/lib/param-slider";
import { ParamSlider } from "@/components/ui/param-slider";

/**
 * ED-01 · 调整面板（工单 30K T3）
 *
 * ## 只做「面板」这件事
 *
 * 面板不持有图像、不渲染像素：`autoAdjust` 与 `renderAdjust` 都由调用方跑，
 * 面板只把用户动作翻译成回调（`onChange` / `onAuto` / `onCancel` / `onDone`）。
 *
 * ## 参数配置不写死（工单 §2 裁决 1，X-P11 / MD-03）
 *
 * 三组滑块与每个滑块的 `ParamSliderConfig` 都从 `groups` 进来（将来由服务端下发，登记在 T-66），
 * 本文件里**没有**任何一个参数的中文标签、也没有值域数字表。web 侧只保留渲染语义所需的
 * 17 个参数 id（`ADJUST_PARAM_IDS`）。
 *
 * ## 「完成」不可点的文案来自工具定义（工单 §2 裁决 2）
 *
 * 规则取自 `tool.disabled_rules` 里 `id === "no_adjustment"` 那条的 `message`，不在 web 里另写一份；
 * 这条规则缺失时「完成」依然 disabled，title 置空。
 *
 * ## testid
 *
 * 滑块由 `ParamSlider` 自己拼成 `adjust-slider-{id}`（`tool="adjust"`），本文件不另写；
 * 其余固定 testid：`adjust-panel` / `adjust-reset-button` / `adjust-close-button` /
 * `adjust-auto-button` / `adjust-cancel-button` / `adjust-done-button`。
 */

/** 「没有做任何调整」这条禁用规则的 id（文案在工具定义里，本组件只认 id）。 */
const NO_ADJUSTMENT_RULE_ID = "no_adjustment";

/** 一组滑块：标题 + 该组的滑块配置。顺序即渲染顺序。 */
export type AdjustParamGroup = {
  id: string;
  label: string;
  params: ParamSliderConfig[];
};

export type AdjustPanelProps = {
  /** 工具定义（只为取 `label` 与 `disabled_rules`）。 */
  tool: ToolDefinition;
  /** 分组与滑块配置。由调用方/服务端给，组件不写死。 */
  groups: AdjustParamGroup[];
  /** 17 个参数的当前值。 */
  values: AdjustParams;
  onChange: (next: AdjustParams) => void;
  /** 自动调整：调用方算完 `autoAdjust` 后自己 `onChange` 写回，面板不碰图像。 */
  onAuto: () => void;
  onCancel: () => void;
  onDone: (values: AdjustParams) => void;
};

const ICON_BUTTON_CLASS =
  "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

const BUTTON_CLASS =
  "rounded-md border border-border px-3 py-1 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

const PRIMARY_BUTTON_CLASS =
  "w-full rounded-md border border-border bg-muted/40 px-3 py-1 text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring";

/** 重置图标：一段回头的圆弧加箭头（纯装饰，语义在按钮的 aria-label 上）。 */
function ResetGlyph() {
  return (
    <span aria-hidden="true" className="pointer-events-none flex items-center justify-center">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="size-3.5">
        <path d="M3 8a5 5 0 1 0 1.6-3.7" />
        <path d="M3 2.5V5h2.5" />
      </svg>
    </span>
  );
}

/** 关闭图标：两条对角线。 */
function CloseGlyph() {
  return (
    <span aria-hidden="true" className="pointer-events-none flex items-center justify-center">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="size-3.5">
        <path d="M4 4l8 8" />
        <path d="M12 4l-8 8" />
      </svg>
    </span>
  );
}

/** `config.id` 是不是 17 个语义参数之一（不是就不写回，避免把外来键塞进 `AdjustParams`）。 */
function isAdjustParamId(id: string): id is AdjustParamId {
  return (ADJUST_PARAM_IDS as readonly string[]).includes(id);
}

/**
 * 滑块当前的内部值。
 *
 * 17 个语义参数直接读 `values`；配置里出现了名单外的 id 时按该配置的 `defaultValue` 显示 ——
 * 面板不会因为多出一个滑块就把 `values` 撑破成任意字符串键的表。
 */
function sliderValue(config: ParamSliderConfig, values: AdjustParams): number {
  return isAdjustParamId(config.id) ? values[config.id] : config.defaultValue;
}

export function AdjustPanel({
  tool,
  groups,
  values,
  onChange,
  onAuto,
  onCancel,
  onDone,
}: AdjustPanelProps) {
  const noAdjustmentMessage = tool.disabled_rules.find(
    (rule) => rule.id === NO_ADJUSTMENT_RULE_ID,
  )?.message;
  const doneDisabled = isZeroAdjust(values);
  // 规则缺失时 title 为空串（裁决 2），可点时不挂 title。
  const doneTitle = doneDisabled ? (noAdjustmentMessage ?? "") : undefined;

  /** 单个滑块写回：只改这一项，其余 16 项原样带上（面板不持有图像，也不持有草稿）。 */
  const writeParam = (id: string, next: number) => {
    if (!isAdjustParamId(id)) return;
    const patched: Record<AdjustParamId, number> = { ...values };
    patched[id] = next;
    onChange(patched);
  };

  /**
   * 重置（ED-00n）：17 项全部回到各自配置的 `defaultValue`。
   * 默认值也只在 `groups` 里，本文件不写第二份；配置里缺某一项时回落到 `ZERO_ADJUST`。
   */
  const reset = () => {
    const defaults = new Map<string, number>();
    for (const group of groups) {
      for (const config of group.params) defaults.set(config.id, config.defaultValue);
    }
    const restored: Record<AdjustParamId, number> = { ...values };
    for (const id of ADJUST_PARAM_IDS) {
      restored[id] = defaults.get(id) ?? ZERO_ADJUST[id];
    }
    onChange(restored);
  };

  return (
    <div
      data-testid="adjust-panel"
      className="flex w-64 flex-col gap-2 border border-border bg-popover p-2 text-foreground shadow-md"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{tool.label}</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            data-testid="adjust-reset-button"
            aria-label="重置"
            title="重置"
            onClick={reset}
            className={ICON_BUTTON_CLASS}
          >
            <ResetGlyph />
          </button>
          <button
            type="button"
            data-testid="adjust-close-button"
            aria-label="关闭"
            title="关闭"
            onClick={onCancel}
            className={ICON_BUTTON_CLASS}
          >
            <CloseGlyph />
          </button>
        </span>
      </div>

      <button
        type="button"
        data-testid="adjust-auto-button"
        onClick={onAuto}
        className={PRIMARY_BUTTON_CLASS}
      >
        自动调整
      </button>

      {groups.map((group) => (
        <div key={group.id} role="group" aria-label={group.label} className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{group.label}</span>
          {group.params.map((config) => (
            <ParamSlider
              key={config.id}
              tool="adjust"
              config={config}
              value={sliderValue(config, values)}
              onChange={(next) => writeParam(config.id, next)}
            />
          ))}
        </div>
      ))}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="adjust-cancel-button"
          onClick={onCancel}
          className={BUTTON_CLASS}
        >
          取消
        </button>
        <button
          type="button"
          data-testid="adjust-done-button"
          disabled={doneDisabled}
          // 置灰时把原因挂到 title（文案来自工具定义；规则缺失时为空串）。
          title={doneTitle}
          onClick={() => onDone(values)}
          className={BUTTON_CLASS}
        >
          完成
        </button>
      </div>
    </div>
  );
}
