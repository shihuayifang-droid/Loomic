"use client";

import { cn } from "@/lib/utils";
import {
  type PriceState,
  type PriceVariant,
  formatPrice,
  isPriceClickable,
} from "@/lib/price-display";

export type PriceTagProps = {
  state: PriceState;
  variant: PriceVariant;
  /** ED-00c：获取失败时点重试。不传就只显示文案，不渲染按钮。 */
  onRetry?: () => void;
};

const BASE_CLASS = "inline-flex items-center whitespace-nowrap";

/** 三种 variant 只差排版，文案由 `formatPrice` 决定（价格数字一律来自询价）。 */
const VARIANT_CLASS: Record<PriceVariant, string> = {
  button: "font-medium text-sm",
  badge: "text-xs text-muted-foreground",
  plain: "tabular-nums text-sm",
};

const RETRY_CLASS = "text-sm text-destructive hover:underline";

/**
 * BL-14 前端 · 价格展示五态组件（ED-00l / ED-00c / ED-00f 共用）
 *
 * - 纯展示：本组件不发请求、不算价、不写死任何价格；数字由 `state.amount` 传进来。
 * - `data-status` 写状态（状态不进 testid），方便按状态定位。
 * - `aria-live="polite"`：价格从「估算中」变成数字时能被读屏播报。
 * - 获取失败且给了 `onRetry` 时渲染成按钮（testid `price-tag-retry`），其余状态都是 `span`。
 */
export function PriceTag({ state, variant, onRetry }: PriceTagProps) {
  const text = formatPrice(state, variant);

  if (state.status === "error" && typeof onRetry === "function") {
    return (
      <button
        type="button"
        data-testid="price-tag-retry"
        data-status={state.status}
        aria-live="polite"
        onClick={onRetry}
        className={cn(BASE_CLASS, VARIANT_CLASS[variant], RETRY_CLASS)}
      >
        {text}
      </button>
    );
  }

  return (
    <span
      data-testid="price-tag"
      data-status={state.status}
      data-clickable={isPriceClickable(state) ? "true" : "false"}
      aria-live="polite"
      className={cn(BASE_CLASS, VARIANT_CLASS[variant])}
    >
      {text}
    </span>
  );
}
