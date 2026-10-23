"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { formatPrice } from "@/lib/price-display";
import type { PriceState } from "@/lib/price-display";

import { ChatComposer } from "@/components/chat-composer";
import type { ChatComposerHandle } from "@/components/chat-composer";

/**
 * ED-06 · 快捷编辑面板（工单 40U）
 *
 * ## 这个组件负责什么
 *
 * 只负责「面板长什么样、输入框里有什么、生成按钮能不能点」三件事：
 * 价格来自询价结果（本文件不算价，`formatPrice` 是唯一出口）、草稿与提交由
 * `image-toolbar-layer.tsx` 持有。面板自己不保存输入 —— 焦点在
 * `ChatComposer`（与 Agent 输入框**同一组件**，ED-06 原文）里，文本只能通过
 * handle 读写。
 *
 * ## 一期不做什么
 *
 * 框选区域按钮不渲染（ED-06：未解决前该按钮隐藏，一期只上整图编辑）。
 * 面板下方那行提示是常显的，不是只在某条路径出现：整图重生成一定会改动
 * 未描述的部分，用户要在点之前知道。
 *
 * ## Esc
 *
 * 在面板根节点上处理并 `stopPropagation()`：画布自己也听 Esc（取消选中），
 * 两条路径同时跑会让「关掉面板」顺带把选中也清掉，草稿就没了。
 */

/** ED-06 原文的占位符。 */
export const QUICK_EDIT_PLACEHOLDER = "描述你想要的编辑…";

/** ED-06 原文：输入框下方常显的一行小字。 */
export const QUICK_EDIT_HINT = "将按描述重新生成整张图，非编辑部分可能变化";

/** ED-06 原文：输入为空时「生成」按钮的 tooltip。 */
export const QUICK_EDIT_EMPTY_TITLE = "请先描述要怎么改";

/** ED-06 原文：面板宽 480px。 */
const PANEL_WIDTH = 480;

/** 询价还没回来时按钮上的文案走「估算中」（ED-00l：不能留空）。 */
const ESTIMATING: PriceState = { status: "estimating" };

export type QuickEditPanelProps = {
  /** 已经输入过的草稿（取消选中前一直保留）。 */
  initialText: string;
  /** `quick_edit` 的询价结果；`undefined` = 还没回来。 */
  price: PriceState | undefined;
  /** 已提交、正在等服务端。 */
  submitting: boolean;
  /** 上一次提交的错误文案；`null` = 没有。 */
  error: string | null;
  onTextChange: (text: string) => void;
  onSubmit: (prompt: string) => void;
  onClose: () => void;
};

/**
 * 按钮文案：`priced` 时是「生成 · N」（N 直接来自询价），其余四态复用
 * `formatPrice(…, "button")` 的现有文案，不在这里写第二份。
 */
function submitLabel(price: PriceState | undefined): string {
  if (price !== undefined && price.status === "priced") return `生成 · ${price.amount}`;
  return formatPrice(price ?? ESTIMATING, "button");
}

export function QuickEditPanel({
  initialText,
  price,
  submitting,
  error,
  onTextChange,
  onSubmit,
  onClose,
}: QuickEditPanelProps) {
  const composerRef = useRef<ChatComposerHandle | null>(null);
  /**
   * 面板自己留一份文本状态：按钮的 disabled 与 tooltip 要跟着它变，
   * 而 `ChatComposer` 的 DOM 由它自己管（React 不能 reconcile 里面的子节点）。
   * 初值走 handle 的 `setText`（与 40F 的填法一致）。
   */
  const [text, setText] = useState(initialText);

  useEffect(() => {
    composerRef.current?.setText(initialText);
    // 只在挂载时灌一次：`initialText` 之后的变化由用户输入决定，不该覆盖光标。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = useCallback(() => {
    const next = composerRef.current?.getText() ?? "";
    setText(next);
    onTextChange(next);
  }, [onTextChange]);

  const trimmed = text.trim();
  const empty = trimmed === "";
  const blocked = empty || submitting;

  const submit = () => {
    if (blocked) return;
    onSubmit(trimmed);
  };

  return (
    <div
      data-testid="quickedit-panel"
      className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 shadow-md"
      style={{ width: PANEL_WIDTH }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <ChatComposer
        ref={composerRef}
        placeholder={QUICK_EDIT_PLACEHOLDER}
        size="compact"
        testId="quickedit-input"
        onTextBeforeCaretChange={handleChange}
        onSubmit={submit}
      />
      <p data-testid="quickedit-hint" className="text-xs leading-[1.6] text-muted-foreground">
        {QUICK_EDIT_HINT}
      </p>
      {error !== null && error !== "" ? (
        <p data-testid="quickedit-error" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        data-testid="quickedit-submit"
        disabled={blocked}
        title={empty ? QUICK_EDIT_EMPTY_TITLE : undefined}
        onClick={submit}
        className="self-end rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
      >
        {submitLabel(price)}
      </button>
    </div>
  );
}
