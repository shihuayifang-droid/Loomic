"use client";

import { useCallback } from "react";

import { useTierLimitToast } from "@/components/credits/tier-limit-toast";
import { JobFailed } from "@/lib/await-job";
import { PERSONAL_CAP_MESSAGE_PREFIX } from "@/lib/billing-error-route";
import { actionLabelOf, lookupError } from "@/lib/error-catalog";
import type { ErrorEntry } from "@/lib/error-catalog";
import { ApiApplicationError } from "@/lib/server-api";
import { useToast } from "@/components/toast";
import type { ToastActionOptions } from "@/components/toast";

const TIER_LIMIT_CODES = new Set([
  "concurrency_limit",
  "model_not_accessible",
  "resolution_not_allowed",
]);

/**
 * 面板能提供的入口回调。两个都是可选的：没有回调就只显示文案，不显示按钮。
 */
export type GenerationErrorActions = {
  /** `user_fixable` 类的入口：把用户送到能改参数的地方（本单：prompt 输入框）。 */
  editParams?: () => void;
  /** `service` 类的入口：按现有提交路径再跑一次。 */
  retry?: () => void;
};

/**
 * 默认值放在模块级而不是参数默认值里：`= {}` 每次渲染都会新建对象，
 * 会把 `handleGenerationError` 的 useCallback 依赖打穿，导致每帧都换身份。
 */
const NO_ACTIONS: GenerationErrorActions = {};

type ShowErrorToast = (message: string, opts?: ToastActionOptions) => void;

/**
 * X-40 二期：按目录条目的 `action` 决定这条 toast 有没有入口按钮。
 *
 * 三条规则（工单 30C T2）：
 * - `edit_params` 且有 `editParams` → 按钮写「修改参数」；
 * - `retry_later` 且有 `retry` → 按钮写「稍后重试」；
 * - 没有对应回调（含 `quota` / `policy`）→ 只显示文案。
 *
 * 没有按钮时必须仍然**只用文案调用一次**（不带第二个参数）：旧签名
 * `error(message)` 的调用形态要保持原样。
 */
function showCatalogueToast(
  showErrorToast: ShowErrorToast,
  entry: ErrorEntry,
  actions: GenerationErrorActions,
): void {
  const actionLabel = actionLabelOf(entry);
  const onAction =
    entry.action === "edit_params" ? actions.editParams : actions.retry;

  if (actionLabel !== null && onAction !== undefined) {
    showErrorToast(entry.message, { actionLabel, onAction });
    return;
  }

  showErrorToast(entry.message);
}

/**
 * Returns a handler function that inspects generation errors and routes them
 * to the appropriate UI:
 * - `insufficient_credits` -> returns true so caller can open CreditInsufficientDialog
 * - tier limit codes -> shows tier-limit toast (handled internally)
 * - other errors -> shows the catalogue's copy for that code (X-40 一期), plus
 *   the 「修改参数」/「稍后重试」entry button when this panel passed the callback
 *   for that category and the toast can render one (X-40 二期)
 *
 * @param actions 面板能提供的入口回调；面板不给，就退化成只有文案的 toast。
 * @returns handleGenerationError(error) => boolean — true if the error was a
 *          known tier/credit limit (i.e. caller should NOT show its own error UI)
 */
export function useGenerationErrorHandler(
  actions: GenerationErrorActions = NO_ACTIONS,
) {
  const { showTierLimit } = useTierLimitToast();
  const { error: showErrorToast } = useToast();

  const handleGenerationError = useCallback(
    (error: unknown): boolean => {
      if (error instanceof ApiApplicationError) {
        // Credit-insufficient: caller should open CreditInsufficientDialog
        if (error.code === "insufficient_credits") {
          return true;
        }

        // Tier limit errors: show toast notification
        if (TIER_LIMIT_CODES.has(error.code)) {
          showTierLimit({ code: error.code, message: error.message });
          return true;
        }

        // Other application errors: log raw message, show catalogue copy
        console.error("[generation-error] Application error:", error.code, error.message);

        // BL-45: 个人上限的拒绝带着服务端算出来的上限 N（「本月额度已用完（上限
        // 20000），可联系管理员调整」），目录文案不知道这个数。只在原文确实是那句
        // 上限句时替换文案，`category` / `action` 仍取目录，入口按钮规则不变。
        if (
          error.code === "personal_cap_reached" &&
          error.message.startsWith(PERSONAL_CAP_MESSAGE_PREFIX)
        ) {
          showCatalogueToast(
            showErrorToast,
            { ...lookupError(error.code), message: error.message },
            actions,
          );
          return false;
        }

        showCatalogueToast(showErrorToast, lookupError(error.code), actions);
        return false;
      }

      if (error instanceof JobFailed) {
        // X-40 一期: a failed job used to arrive here without its `error_code`
        // ever being read, so `timeout` and `upstream_busy` both showed the
        // generic line. The code is the whole point of the catalogue.
        console.error("[generation-error] Job failed:", error.code, error.message);
        showCatalogueToast(showErrorToast, lookupError(error.code), actions);
        return false;
      }

      // Not an application error — log for debugging, show the service copy
      console.error("[generation-error] Unexpected error:", error);
      showCatalogueToast(showErrorToast, lookupError(undefined), actions);
      return false;
    },
    [showTierLimit, showErrorToast, actions],
  );

  return { handleGenerationError };
}
