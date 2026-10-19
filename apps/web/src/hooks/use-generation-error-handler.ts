"use client";

import { useCallback } from "react";

import { useTierLimitToast } from "@/components/credits/tier-limit-toast";
import { JobFailed } from "@/lib/await-job";
import { lookupError } from "@/lib/error-catalog";
import { ApiApplicationError } from "@/lib/server-api";
import { useToast } from "@/components/toast";

const TIER_LIMIT_CODES = new Set([
  "concurrency_limit",
  "model_not_accessible",
  "resolution_not_allowed",
]);

/**
 * Returns a handler function that inspects generation errors and routes them
 * to the appropriate UI:
 * - `insufficient_credits` -> returns true so caller can open CreditInsufficientDialog
 * - tier limit codes -> shows tier-limit toast (handled internally)
 * - other errors -> shows the catalogue's copy for that code (X-40 一期)
 *
 * X-40 一期 NOTE ON THE ACTION BUTTONS: the spec wants a 「修改参数」/「稍后重试」
 * entry driven by the category. `components/toast.tsx` renders a message only —
 * no action slot — and this ticket forbids changing that component, so the
 * entries here carry the category/action metadata for the next ticket to wire up
 * but the handler can only swap the text today. X-40 stays 「执行中」 on that half.
 *
 * @returns handleGenerationError(error) => boolean — true if the error was a
 *          known tier/credit limit (i.e. caller should NOT show its own error UI)
 */
export function useGenerationErrorHandler() {
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
        showErrorToast(lookupError(error.code).message);
        return false;
      }

      if (error instanceof JobFailed) {
        // X-40 一期: a failed job used to arrive here without its `error_code`
        // ever being read, so `timeout` and `upstream_busy` both showed the
        // generic line. The code is the whole point of the catalogue.
        console.error("[generation-error] Job failed:", error.code, error.message);
        showErrorToast(lookupError(error.code).message);
        return false;
      }

      // Not an application error — log for debugging, show the service copy
      console.error("[generation-error] Unexpected error:", error);
      showErrorToast(lookupError(undefined).message);
      return false;
    },
    [showTierLimit, showErrorToast],
  );

  return { handleGenerationError };
}
