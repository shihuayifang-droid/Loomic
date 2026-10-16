/**
 * Refunding the credits of a terminally failed job (workorder 21O).
 *
 * Lifted out of `worker.ts` so the money branches below are testable without a
 * worker, a queue or a database. The worker keeps the polling loop, concurrency
 * and shutdown; it now builds this module and passes it to `processJobMessage`
 * exactly as it passed the local function before.
 *
 * WHAT MOVED AND WHAT DID NOT
 * The READ moved to `JobRefundBasisRepository` (pure `pg`): the admin single-row
 * lookup of `credits_cost, workspace_id, created_by` is gone from the worker.
 * Everything about the DECISION stayed here, verbatim: the `?? 0`, the
 * `creditsCost <= 0 || !workspaceId || !createdBy` guard, the argument list of
 * `refundCredits`, the description string, the success log line and the
 * never-throwing contract.
 *
 * THE ONE ALLOWED DIFFERENCE
 * The displaced read discarded its error field, so a failed read and a missing
 * row were indistinguishable and BOTH were silent. Here the read can throw, and
 * a throw is reported through `logError` (`Failed to refund credits ...`) —
 * which is the same line a failed refund already produced. The money result does
 * not change: a read that fails refunds nothing, exactly as before.
 *
 * WHY `!createdBy` IS NOT A BUG
 * Historic rows carry a NULL `created_by`, and the credits RULE needs a user to
 * credit. The displaced code refunded nothing for those rows and this module
 * keeps that: `refundCredits` is never called without a person, and the case is
 * pinned by its own test rather than left to a reader's judgement.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * No retry: one attempt per call, whether the read failed or the refund did. No
 * de-duplication by job id: refunding at most once per job is owned by
 * `processJobMessage` (`markFailed` must have moved the row) and the durable
 * version of that rule belongs to T-40. Adding either here would silently change
 * who owns the money.
 *
 * `refundJob` NEVER rejects. `processJobMessage` wraps the call in its own
 * `try`/`catch` today, but the old contract was "never throws" and a caller that
 * relies on it (archiving the message afterwards) must keep working.
 */

import type { JobRefundBasisRow } from "../../db/job-refund-basis-repository.js";
import type { CreditService } from "../credits/credit-service.js";

/**
 * The description every auto-refund carries. Verbatim the string the worker sent
 * before this module existed: it is what a user reads on their credit ledger, so
 * it is not free to change.
 */
export const REFUND_DESCRIPTION = "Auto-refund: job failed";

/**
 * The read this module needs, narrowed to the one call it makes. Declared
 * structurally rather than as `JobRefundBasisRepository` so a test can hand it a
 * plain function: what matters here is the row, not who produced it.
 */
export type RefundBasisReader = (
  input: { jobId: string },
) => Promise<JobRefundBasisRow | null>;

export type RefundJobDeps = {
  /** Reads how much to refund, to which workspace and to whom. */
  readRefundBasis: RefundBasisReader;
  /**
   * Only `refundCredits` is needed here. The credits rule itself (the
   * `refund_credits` RPC) is untouched by this workorder.
   */
  creditService: Pick<CreditService, "refundCredits">;
  /** Defaults to `console.log`; injected by tests. */
  log?: (message: string) => void;
  /** Defaults to `console.error`; injected by tests. */
  logError?: (message: string, error: unknown) => void;
};

/**
 * The refund entry point, bound to its collaborators. The worker holds one
 * instance and calls it once per terminally failed job.
 */
export type RefundJob = (jobId: string, tag: string) => Promise<void>;

/**
 * Build the refund function.
 *
 * `tag` is the worker's own log prefix (the displaced function received it as an
 * argument for the same reason): both log lines keep it, so a log line from one
 * worker stays attributable after this extraction.
 */
export function createRefundJob(deps: RefundJobDeps): RefundJob {
  const log = deps.log ?? ((message: string) => console.log(message));
  const logError =
    deps.logError ??
    ((message: string, error: unknown) => console.error(message, error));

  return async (jobId, tag) => {
    try {
      const basis = await deps.readRefundBasis({ jobId });

      // No such job (or, before this workorder, a read that failed): nothing is
      // known about the money, so nothing is moved and nothing is logged.
      if (!basis) return;

      const creditsCost = basis.creditsCost ?? 0;
      const workspaceId = basis.workspaceId;
      const createdBy = basis.createdBy;

      // The refund condition, character for character what it was: a job that
      // cost nothing, a job whose workspace is unusable, or a historic row with
      // no creator is not refunded. NULL cost deliberately falls through `?? 0`
      // into this same `<= 0` refusal rather than being special-cased.
      if (creditsCost <= 0 || !workspaceId || !createdBy) return;

      const txId = await deps.creditService.refundCredits(
        workspaceId,
        createdBy,
        creditsCost,
        jobId,
        REFUND_DESCRIPTION,
      );
      log(`${tag} Refunded ${creditsCost} credits for job ${jobId} (tx: ${txId})`);
    } catch (refundErr) {
      // Log but don't crash the worker — the job is already dead-lettered. A
      // read failure lands here too (see the header) and refunds nothing.
      logError(`${tag} Failed to refund credits for job ${jobId}:`, refundErr);
    }
  };
}
