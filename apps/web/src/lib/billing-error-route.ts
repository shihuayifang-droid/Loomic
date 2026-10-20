/**
 * AG-10 / GN-07: where a billing refusal from an Agent run is shown.
 *
 * WHY A PURE FUNCTION
 * The server fails closed: when the price table has no row for the model it
 * pushes `billing.error { code: "model_not_available" }` and aborts the run —
 * nothing is created and nothing is charged (apps/server `runtime.ts`). The
 * sidebar used to send every code except `insufficient_credits` to
 * `showTierLimit`, and that provider only renders the three tier codes
 * (`VALID_CODES` in `components/credits/tier-limit-toast.tsx`), so
 * `model_not_available` fell on the floor: the run just stopped, with no
 * sentence telling the user why. This module is the single decision point for
 * "which surface does this refusal go to", so the answer is testable without a
 * DOM and nothing can be dropped silently again.
 *
 * The `message` branch borrows the copy from `lib/error-catalog.ts`
 * (`lookupError`), so a code without a row still lands on the catalogue's
 * generic fallback sentence instead of being swallowed.
 */
import { lookupError } from "./error-catalog";

export type BillingErrorRoute =
  | { kind: "credit_dialog" }
  | { kind: "tier_toast" }
  | { kind: "message"; text: string };

/**
 * The codes that `TierLimitToastProvider.showTierLimit` actually renders.
 *
 * KEEP IN SYNC with `TOAST_CONFIG` / `VALID_CODES` in
 * `src/components/credits/tier-limit-toast.tsx`: that file derives
 * `VALID_CODES` from the keys of `TOAST_CONFIG`, so adding a code there (or
 * here) without the other is a behaviour change — a toast that never appears,
 * or a route that stops reaching it. `test/billing-error-route.test.ts`
 * reads that component's source and compares the two sets, so the drift shows
 * up as a failing test rather than as a silent badge.
 */
export const TIER_TOAST_CODES = [
  "concurrency_limit",
  "model_not_accessible",
  "resolution_not_allowed",
] as const;

const TIER_TOAST_CODE_SET: ReadonlySet<string> = new Set(TIER_TOAST_CODES);

/**
 * Where a `billing.error` code goes. Nothing is ever dropped: an unrecognised
 * code (including `model_not_available`) becomes a `message` carrying the
 * catalogue's copy for it.
 */
export function billingErrorRoute(code: string): BillingErrorRoute {
  if (code === "insufficient_credits") return { kind: "credit_dialog" };
  if (TIER_TOAST_CODE_SET.has(code)) return { kind: "tier_toast" };
  return { kind: "message", text: lookupError(code).message };
}
