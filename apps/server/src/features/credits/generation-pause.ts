/**
 * The generation-pause gate on the credit service (workorder 39P, AD-01 /
 * BL-21 step 3).
 *
 * `withBilling` asks the credit service ONE question before it quotes, creates
 * a job or charges anything:
 *
 *   is this member's generation paused?
 *
 * The answer lives in `member_generation_pauses` (39N) and is read by
 * `db/member-pause-read-repository.ts`; this wrapper is what puts that read on
 * the service object the six `withBilling` call sites already receive.
 *
 * Why a wrapper and not a field on `createCreditService`:
 *
 * - `CreditService` is built in `app.ts` from a PostgREST-backed factory, and
 *   the gate has to work whether or not `LOOMIC_CREDIT_POOLS` is on. Wrapping
 *   the FINAL service — after `withCreditPools` — is the only place that is
 *   true for both wirings, and it is one line there instead of a new
 *   constructor argument threaded through two branches.
 * - The method is optional on the type, so a test double or an older wiring
 *   without it keeps the pre-39P behaviour: `withBilling` skips the check
 *   entirely rather than failing (workorder 39P's E-020).
 *
 * `...base` is deliberate: every other method — including the optional
 * `availableFor` / `refusalFor` / `chargeTarget` that only the pools wrapper
 * has — is forwarded untouched. Rebuilding the object from a list of methods
 * would silently drop whichever optional one is added next, and dropping
 * `refusalFor` or `chargeTarget` would change what a member is charged.
 */

import type { CreditService } from "./credit-service.js";

export function withGenerationPause(
  base: CreditService,
  deps: {
    isGenerationPaused(input: { userId: string }): Promise<boolean>;
  },
): CreditService {
  return {
    ...base,
    isGenerationPaused: (userId: string) =>
      deps.isGenerationPaused({ userId }),
  };
}
