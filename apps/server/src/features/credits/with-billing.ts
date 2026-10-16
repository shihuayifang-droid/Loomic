// @credits-system — Single implementation of "guard, charge, run, refund".
//
// WHY THIS EXISTS
// The sequence below was copy-pasted into six places (http/generate.ts x2,
// http/jobs.ts x2, agent/runtime.ts x2) and the copies had drifted apart:
//
//   - Only the two agent paths pre-checked the balance. The four HTTP paths let
//     deductCredits fail instead, which means they created a job first and then
//     cancelled it — leaving a cancelled job behind for every "out of credits".
//   - POST /api/jobs/video-generation passed `duration` but NOT `resolution`
//     into calculateCreditCost, while the other two video paths passed both. So
//     the same 1080p Veo request billed at the 720p rate through that route
//     (resolutionMultipliers 1080p: 2 was never applied) — we undercharged.
//   - Refund-on-failure existed in exactly one of the six.
//
// Every new generating operation (P1-e adds upscale, remove-bg, outpaint, ...)
// would otherwise be copy number seven.
//
// REFUND OWNERSHIP — the one real branch in here
// Whether this function refunds depends on whether a job was created, and that
// is not an accident of the old code:
//
//   job created  -> the job goes on a queue; worker.ts's dead-letter handler
//                   owns the refund. Refunding here too would double-refund.
//   no job       -> nobody else can see the charge, so this function must
//                   refund. That is the P0-2 fix, generalised.
//
// BILLING CONFIRMATION — the other obligation (workorder 21H1)
// The worker refuses to start a job whose `credits_cost` is still NULL, because
// that state cannot be told apart from "the charge has not happened yet". So
// every path that creates a job has to leave a recorded answer behind:
//
//   charged      -> `setCreditsInfo(job, creditsCost, txId)`,
//   charged 0    -> `setCreditsInfo(job, 0, null)` — the free model, and the
//                   deployment with the credit system switched off.
//
// `0` is a confirmation, not a placeholder: it is a non-null cost the gate reads
// as "billed". A job created and left with NULL would be deferred for ten
// minutes and then failed as `billing_not_confirmed` — a free generation lost to
// a bookkeeping gap.
//
// UNLINKED CHARGE — the third obligation (workorder 21H2)
// Recording the charge can fail ON ITS OWN, after the money has left the
// workspace. That is a different incident from a failed charge and it has a
// different answer:
//
//   charge failed -> cancel the job (it must not stay startable) and rethrow.
//   link failed   -> claim the job, refund the workspace exactly once, mark the
//                    job as refunded, then rethrow the link error. NO cancel:
//                    the claim already moved the job, and cancelling would only
//                    race it.
//
// The refund cannot be left to anyone else. The worker's `refundJob` refunds
// only a job whose `credits_cost` is set, and the whole point of this state is
// that it is not — so this function is the only owner, and the claim is what
// makes the refund one-shot (`refund_credits` does not de-duplicate by job id).
// A refund that cannot be completed leaves `credits_refund_pending` on the job,
// which is what the background compensator (T-40) reconciles.
import type {
  BackgroundJob,
  ImageQualityLevel,
  VideoResolution,
} from "@loomic/shared";
import { PLAN_CONFIGS } from "@loomic/shared";

import type { AuthenticatedUser } from "../../supabase/user.js";
import type { CreateJobInput, JobService } from "../jobs/job-service.js";
import { CreditServiceError, type CreditService } from "./credit-service.js";
import { TierGuardError, type TierGuard } from "./tier-guard.js";

/**
 * Pricing/guard inputs, discriminated by job type.
 *
 * `quality` is required for images so `checkResolution` can never be silently
 * skipped. Use `"plan_max"` when the request has no quality field at all (POST
 * /api/jobs/image-generation) — it resolves to the plan's own maximum, which is
 * what that route already did, and lets this function reuse the subscription it
 * has already fetched instead of the caller querying it a second time.
 */
export type BillingGuardSpec =
  | { jobType: "image_generation"; quality: ImageQualityLevel | "plan_max" }
  | {
      jobType: "video_generation";
      resolution?: VideoResolution;
      duration?: number;
    };

/** Why the request was rejected before any money moved. */
export type BillingRejection =
  | { kind: "tier"; error: TierGuardError }
  | {
      kind: "insufficient_credits";
      currentBalance: number;
      requiredAmount: number;
      plan: string;
      dailyClaimed: boolean;
    };

export interface BillingDeps {
  /** Absent = credit system not configured; guards and charging are skipped. */
  creditService?: CreditService;
  /** Absent = same as above. Both must be present for any billing to happen. */
  tierGuard?: TierGuard;
  /** Required whenever `request.job` is set. */
  jobService?: JobService;
}

export interface BillingRequest {
  user: AuthenticatedUser;
  workspaceId: string;
  modelId: string;
  guard: BillingGuardSpec;
  /** Goes on the credit transaction, e.g. "Image generation: <model>". */
  description: string;
  /**
   * Job to create before charging, so the transaction carries a job_id.
   *
   * Omit for synchronous routes that never create one — then this function owns
   * the refund on failure (see REFUND OWNERSHIP above). The only such route
   * today is POST /api/agent/generate-image; making it asynchronous is tracked
   * separately as B-3 and needs a frontend change.
   */
  job?: {
    payload: Record<string, unknown>;
    refs?: Pick<
      CreateJobInput,
      "projectId" | "canvasId" | "sessionId" | "threadId"
    >;
  };
  /**
   * Called before the rejection is thrown. The agent runtime uses it to push a
   * `billing.error` WS event and abort the run; HTTP routes leave it out and let
   * their error handler map the thrown error to a status code.
   */
  onRejected?: (rejection: BillingRejection) => void;
}

export interface BillingOutcome {
  /** Present only when `request.job` was supplied. */
  job?: BackgroundJob;
  /** 0 when the credit system is not configured or the model is free. */
  creditsCost: number;
}

/**
 * Runs the guard/charge/execute/refund sequence around `run`.
 *
 * Throws before calling `run` if a tier guard rejects or the balance is too
 * low — `onRejected` fires first so callers can notify the client.
 */
export async function withBilling<T>(
  deps: BillingDeps,
  request: BillingRequest,
  run: (outcome: BillingOutcome) => Promise<T>,
): Promise<T> {
  const { creditService, tierGuard, jobService } = deps;
  const { user, workspaceId, modelId, guard, description } = request;

  if (request.job && !jobService) {
    // A wiring mistake, not a runtime condition: the caller asked for a job and
    // there is nothing to create it with. Fail loudly at the point of the bug.
    throw new Error(
      "withBilling: request.job was provided but deps.jobService is missing. " +
        "Either pass a job service or omit request.job.",
    );
  }

  const billingEnabled = !!creditService && !!tierGuard;
  let creditsCost = 0;

  if (billingEnabled) {
    let effectiveQuality: ImageQualityLevel = "hd";
    try {
      const sub = await creditService.getSubscription(workspaceId);
      tierGuard.checkModelAccess(sub.plan, modelId);
      if (guard.jobType === "image_generation") {
        effectiveQuality =
          guard.quality === "plan_max"
            ? PLAN_CONFIGS[sub.plan].maxResolution
            : guard.quality;
        tierGuard.checkResolution(sub.plan, effectiveQuality);
      } else if (guard.resolution) {
        tierGuard.checkVideoResolution(sub.plan, guard.resolution);
      }
      await tierGuard.checkConcurrency(workspaceId, sub.plan);
    } catch (err) {
      if (err instanceof TierGuardError) {
        request.onRejected?.({ kind: "tier", error: err });
      }
      throw err;
    }

    creditsCost = tierGuard.calculateCreditCost(
      modelId,
      guard.jobType,
      guard.jobType === "image_generation"
        ? { quality: effectiveQuality }
        : {
            ...(guard.duration != null ? { duration: guard.duration } : {}),
            ...(guard.resolution ? { resolution: guard.resolution } : {}),
          },
    );
  }

  // Balance pre-check. Previously only the agent paths did this; without it the
  // HTTP paths created a job, failed the deduction, then cancelled the job.
  if (billingEnabled && creditsCost > 0) {
    const balanceInfo = await creditService.getBalance(workspaceId);
    if (balanceInfo.balance < creditsCost) {
      request.onRejected?.({
        kind: "insufficient_credits",
        currentBalance: balanceInfo.balance,
        requiredAmount: creditsCost,
        plan: balanceInfo.plan,
        dailyClaimed: balanceInfo.dailyClaimed,
      });
      throw new CreditServiceError(
        "insufficient_credits",
        `Insufficient credits: ${balanceInfo.balance} available, ${creditsCost} required.`,
        402,
      );
    }
  }

  let job: BackgroundJob | undefined;
  if (request.job) {
    job = await jobService!.createJob(user, {
      workspaceId,
      ...(request.job.refs ?? {}),
      jobType: guard.jobType,
      payload: request.job.payload,
    });
  }

  // Charge before running. Deliberately not moved after generation: the balance
  // check and the deduction have to happen up front or concurrent runs can both
  // pass the check and overdraw.
  let charged = false;
  if (billingEnabled && creditsCost > 0) {
    let chargeTxId: string;
    try {
      chargeTxId = await creditService.deductCredits(
        workspaceId,
        user.id,
        creditsCost,
        job?.id,
        description,
      );
      charged = true;
    } catch (deductError) {
      // THE CHARGE FAILED (workorder 21H0 H10/H11 — unchanged). The reaction is
      // the guarded cancel alone, and the cancel's own failure is swallowed so
      // the caller sees the charge error. No refund and no compensation: nothing
      // was taken, so there is nothing to give back and nothing to claim.
      if (job) await jobService!.cancelJob(user, job.id).catch(() => {});
      throw deductError;
    }

    // THE CHARGE SUCCEEDED — record WHICH transaction paid for the job.
    //
    // Workorder 21H2 owns this branch. A failure here is NOT a failed charge and
    // is NOT answered by cancelling:
    //
    //   - the money is already out of the workspace, and nobody else can return
    //     it — the worker's `refundJob` only refunds a job whose `credits_cost`
    //     is set, and this job's cost was never recorded, so this function is the
    //     only possible refund owner;
    //   - cancelling would only race the claim below (which moves a
    //     `queued`/`retrying` job to `failed`) and would leave the charge
    //     unattributed.
    //
    // So the compensation runs first, and then the ORIGINAL link error is
    // rethrown: the caller learns why the request failed, not how the money was
    // cleaned up. `run` is never called — this request did not happen.
    if (job) {
      try {
        await jobService!.setCreditsInfo(job.id, creditsCost, chargeTxId);
      } catch (linkError) {
        await compensateUnlinkedCharge({
          creditService,
          jobService: jobService!,
          workspaceId,
          userId: user.id,
          jobId: job.id,
          creditsCost,
          transactionId: chargeTxId,
          description,
        });
        throw linkError;
      }
    }
  } else if (job) {
    // Workorder 21H1: the two paths that charge nothing still have to RECORD
    // that they charged nothing. `createJob` enqueues the job before this
    // function runs, so the worker may already be holding the message; with
    // `credits_cost` left NULL (a free model, or a deployment with the credit
    // system switched off) that message is indistinguishable from a job whose
    // charge has not happened yet, and the worker's billing gate would defer it
    // for ten minutes and then fail it as `billing_not_confirmed`.
    //
    // Writing `0` is the confirmation: a terminal, non-null cost the gate reads
    // as "billed". `null` is the transaction id because no transaction exists —
    // and because the gate keys on `credits_cost`, not on the link.
    //
    // This is deliberately NOT merged into the charge block above: the two look
    // similar but they answer different questions, and the catch around this one
    // must not be widened into the paid path's (workorder 21H2 owns that one).
    try {
      await jobService!.setCreditsInfo(job.id, 0, null);
    } catch (confirmError) {
      // Same reaction as a failed deduction, and for the same reason: the job
      // must not be left startable when the record of what it costs could not be
      // written. The cancel's own failure is swallowed so the caller sees the
      // write error, exactly as the paid path does.
      await jobService!.cancelJob(user, job.id).catch(() => {});
      throw confirmError;
    }
  }

  try {
    return await run({ ...(job ? { job } : {}), creditsCost });
  } catch (error) {
    // Only refund what nobody else will. With a job, worker.ts's dead-letter
    // handler owns it and refunding here would double-refund.
    if (charged && !job) {
      await refundQuietly(creditService!, {
        workspaceId,
        userId: user.id,
        amount: creditsCost,
        description: `Refund: ${description} failed`,
      });
    }
    throw error;
  }
}

/**
 * Compensate a charge that was taken but never linked to its job (workorder 21H2
 * T3). **This function never throws.**
 *
 * The order is the whole point, and it is not an implementation detail:
 *
 *   1. CLAIM FIRST. `refund_credits` does not de-duplicate by job id (T-40), so
 *      the claim — one predicate-guarded statement that only matches a job whose
 *      charge is unlinked and unclaimed — is what makes the refund one-shot. A
 *      job that cannot be claimed is a job somebody else already owns: refunding
 *      it anyway would pay the same charge twice (e.g. the link actually
 *      committed and only its response was lost: the worker would refund it on
 *      failure).
 *   2. REFUND EXACTLY ONCE, and only then
 *   3. MARK, so a later compensation pass stops seeing the job as owing money.
 *
 * Every failure is a loud log line and a return, never a throw: the caller is
 * about to rethrow the link error, and a compensation problem must not replace
 * the reason the request failed. The one thing this must not do is fail
 * silently — at this point the workspace is short by `creditsCost` and a log
 * line is the only record anybody will have.
 */
async function compensateUnlinkedCharge(args: {
  creditService: CreditService;
  jobService: JobService;
  workspaceId: string;
  userId: string;
  jobId: string;
  creditsCost: number;
  transactionId: string;
  description: string;
}): Promise<void> {
  // STEP 1 — take ownership of the charge.
  let claimed: boolean;
  try {
    claimed = await args.jobService.claimUnlinkedCharge(args.jobId);
  } catch (claimError) {
    // The claim did not answer, so nobody knows who owns this charge. Refunding
    // without ownership is the one thing that can pay twice (see the header), so
    // this refuses and says exactly what is at stake.
    console.error(
      `[with-billing] could not claim job ${args.jobId} after the credits link ` +
        `failed: NOT refunding. Workspace ${args.workspaceId} was charged ` +
        `${args.creditsCost} credits (transaction ${args.transactionId}) that ` +
        `are still unattributed; the job keeps its current billing state and ` +
        `the compensation pass must reconcile it: ` +
        describeError(claimError),
    );
    return;
  }

  if (!claimed) {
    // The row is not this path's to compensate: it already has a billing record,
    // or it is in a state no compensation may touch. That is the worker's /
    // compensator's decision to make, not this request's.
    console.error(
      `[with-billing] job ${args.jobId} could not be claimed for compensation ` +
        `after the credits link failed: NOT refunding. Workspace ` +
        `${args.workspaceId} was charged ${args.creditsCost} credits ` +
        `(transaction ${args.transactionId}); the job already carries a billing ` +
        `record or is not compensatable here, so it is left to the worker's own ` +
        `refund path`,
    );
    return;
  }

  // STEP 2 — refund, exactly once. No retry: a second attempt inside this
  // request is not idempotent either, and it would hold the response open.
  try {
    await args.creditService.refundCredits(
      args.workspaceId,
      args.userId,
      args.creditsCost,
      args.jobId,
      `Refund: ${args.description} (credits link failed)`,
    );
  } catch (refundError) {
    console.error(
      `[with-billing] REFUND FAILED after claiming job ${args.jobId}: workspace ` +
        `${args.workspaceId} is owed ${args.creditsCost} credits (transaction ` +
        `${args.transactionId}). The job stays credits_refund_pending and the ` +
        `mark was NOT written, so the compensation pass can find it: ` +
        describeError(refundError),
    );
    return;
  }

  // STEP 3 — record that the money went back.
  let marked: boolean;
  try {
    marked = await args.jobService.markChargeRefunded(args.jobId);
  } catch (markError) {
    console.error(
      `[with-billing] refunded ${args.creditsCost} credits to workspace ` +
        `${args.workspaceId} for job ${args.jobId}, but the ` +
        `credits_link_refunded mark was NOT written: ` +
        describeError(markError),
    );
    return;
  }

  if (!marked) {
    console.error(
      `[with-billing] refunded ${args.creditsCost} credits to workspace ` +
        `${args.workspaceId} for job ${args.jobId}, but the ` +
        `credits_link_refunded mark was refused (the job is no longer ` +
        `credits_refund_pending): the refund stands and the job's marker does not`,
    );
    return;
  }

  console.log(
    `[with-billing] refunded ${args.creditsCost} credits to workspace ` +
      `${args.workspaceId} for job ${args.jobId} after the credits link failed`,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refunds and never throws — a failure here must not replace the original error
 * the caller is about to surface. But it must not be silent either: at this
 * point the user is short by `amount` and this log line is the only record.
 */
async function refundQuietly(
  creditService: CreditService,
  args: {
    workspaceId: string;
    userId: string;
    amount: number;
    description: string;
  },
): Promise<void> {
  try {
    await creditService.refundCredits(
      args.workspaceId,
      args.userId,
      args.amount,
      undefined,
      args.description,
    );
    console.log(
      `[with-billing] refunded ${args.amount} credits to workspace ` +
        `${args.workspaceId} after a failed operation`,
    );
  } catch (refundError) {
    console.error(
      `[with-billing] REFUND FAILED - workspace ${args.workspaceId} is owed ` +
        `${args.amount} credits: ` +
        (refundError instanceof Error
          ? refundError.message
          : String(refundError)),
    );
  }
}
