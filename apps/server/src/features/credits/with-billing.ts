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
//   charged      -> `setCreditsInfo(job, creditsCost, txId)` (unchanged),
//   charged 0    -> `setCreditsInfo(job, 0, null)` — the free model, and the
//                   deployment with the credit system switched off.
//
// `0` is a confirmation, not a placeholder: it is a non-null cost the gate reads
// as "billed". A job created and left with NULL would be deferred for ten
// minutes and then failed as `billing_not_confirmed` — a free generation lost to
// a bookkeeping gap.
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
    try {
      const txId = await creditService.deductCredits(
        workspaceId,
        user.id,
        creditsCost,
        job?.id,
        description,
      );
      charged = true;
      if (job) await jobService!.setCreditsInfo(job.id, creditsCost, txId);
    } catch (deductError) {
      if (job) await jobService!.cancelJob(user, job.id).catch(() => {});
      throw deductError;
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
