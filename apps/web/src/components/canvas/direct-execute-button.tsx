"use client";

/**
 * ED-00m 前端 · 直接执行按钮（工单 30M T3）
 *
 * 只管把 `useDirectExecute` 的四样东西接到 DOM 上：`disabled` / `title` / `aria-busy` / 点击。
 * **不写任何 testid 字面量** —— testid 是透传 prop，testid-lint 的规则 (a) 会按
 * 「透传标识符」放行，前缀由调用方定（`image-<tool>`，见 CONVENTIONS §6）。
 *
 * 这里也不接画布：本单只交付能力层，放置占位由调用方的 `onStart` 决定（验收 3）。
 */

import { PriceTag } from "@/components/ui/price-tag";
import { useDirectExecute } from "@/hooks/use-direct-execute";
import type { DirectExecuteOnStart, DirectExecuteSubmit } from "@/hooks/use-direct-execute";
import type { PriceState } from "@/lib/price-display";
import { cn } from "@/lib/utils";

export type DirectExecuteButtonProps = {
  /** 透传，本文件里不出现在任何字面量中 */
  testid: string;
  label: string;
  price: PriceState;
  toolId: string;
  sourceId: string;
  available: number | null;
  etaSeconds: number | null;
  submit: DirectExecuteSubmit;
  /** 显式 `| undefined`：本仓开着 `exactOptionalPropertyTypes`，方便调用方原样转传 */
  onStart?: DirectExecuteOnStart | undefined;
};

const BUTTON_CLASS = cn(
  "inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1",
  "text-sm font-medium text-neutral-900 transition-colors",
  "hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60",
);

/**
 * 直接执行按钮。
 *
 * - `disabled`：`reason !== null || loading`（T2 算好，这里直接用），同时写 `disabled` 属性，
 *   让键盘与读屏也拿不到它 —— 只在 `onClick` 里拦是不够的，回车一样能触发。
 * - `title`：不可点时是**原因**（ED-00m「余额不足时禁用，并写明原因」），
 *   可点时是**价格提示**（规格第 3 条）。没有原因但仍在提交中时退回价格提示：
 *   那一档价格本来就可点，说「点击即扣 N 分」不算错。
 * - `aria-busy`：提交中标记，配「提交中」三个字；读屏据此知道按钮是忙着，不是坏了。
 * - 内容恒为 `label` + `PriceTag`，提交中再追加「提交中」—— 结构不随状态变形，
 *   价格也不会在点击的一瞬间从按钮上消失（ED-00c：价格必须一直可见）。
 */
export function DirectExecuteButton({
  testid,
  label,
  price,
  toolId,
  sourceId,
  available,
  etaSeconds,
  submit,
  onStart,
}: DirectExecuteButtonProps) {
  const { disabled, reason, tooltip, loading, execute } = useDirectExecute({
    toolId,
    sourceId,
    price,
    available,
    etaSeconds,
    submit,
    onStart,
  });

  const title = reason ?? tooltip ?? undefined;

  return (
    <button
      type="button"
      data-testid={testid}
      disabled={disabled}
      title={title}
      aria-busy={loading ? "true" : undefined}
      onClick={() => {
        // 结果由调用方按需处理；这里只保证「点一下 = 触发一次 execute」。
        void execute();
      }}
      className={BUTTON_CLASS}
    >
      <span>{label}</span>
      <PriceTag state={price} variant="button" />
      {loading ? <span>提交中</span> : null}
    </button>
  );
}
