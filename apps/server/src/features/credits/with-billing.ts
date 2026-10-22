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
//     into the cost calculation, while the other two video paths passed both. So
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
//
// THE PRICE COMES FROM THE TABLE — the fourth obligation (workorder 31B)
// Until 31B this function asked the tier guard for a cost, and that function
// answered from constants compiled into `@loomic/shared` — with a `DEFAULT_*_COST`
// fallback, so an unregistered model id was charged the fallback price instead of
// being refused. BL-14 puts every price in `pricing_rules` and GN-07 makes "no
// row" a refusal, so the price is now a QUOTE:
//
//   not registered / no rule matched -> refused before any job or balance read:
//       `onRejected({ kind: "model_not_available" })` then a 400
//       `model_not_available` error. Nothing is created, charged or written.
//   price_status "pending"           -> run for 0 AND leave a ledger row
//       (`recordPendingConsume`, amount 0, `metadata.price_pending = true`) so
//       "used but not priced yet" survives in the books.
//   price_status "active"            -> charge `total_price` exactly as before.
//
// "Pending" and "free" are NOT the same thing: an active price of 0 is a decision
// (no ledger row, unchanged behaviour), while pending is the absence of one.
import type {
  BackgroundJob,
  EntryPoint,
  ImageQualityLevel,
  PriceDetail,
  VideoResolution,
} from "@loomic/shared";

import type { CreditLedgerWriteRepository } from "../../db/credit-ledger-write-repository.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
import type { CreateJobInput, JobService } from "../jobs/job-service.js";
import type { PriceQuoter } from "../pricing/price-quoter.js";
import { billingSearchKey } from "../pricing/search-key.js";
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
    }
  // Workorder 31B / GN-07: the price table has no usable row for this model, so
  // the request never became a job. This is not a tier limit — upgrading the plan
  // does not make the model sellable, and nothing was charged.
  | { kind: "model_not_available"; modelId: string }
  // Workorder 39H (T-107 / BL-45): one of the three pools refused before any
  // money moved. A separate shape rather than `insufficient_credits`, because the
  // precise code and sentence are the whole point: "your own monthly cap ran out"
  // and "the team pool is empty" are not fixed by buying credits, and the old
  // shape's `plan` / `dailyClaimed` made the client offer a paying member the
  // free-tier "claim today's gift" button instead.
  | {
      kind: "pool_refusal";
      code: "personal_cap_reached" | "team_pool_exhausted" | "insufficient_credits";
      message: string;
      currentBalance: number;
      requiredAmount: number;
    }
  // Workorder 39P (AD-01 / BL-21 step 3): an administrator paused this member's
  // generation. Its own shape rather than `pool_refusal` or `tier`: nothing was
  // charged and no plan change or top-up fixes it, and the client has to say
  // exactly that, so there is no balance or price to report.
  | { kind: "account_suspended" };

export interface BillingDeps {
  /** Absent = credit system not configured; guards and charging are skipped. */
  creditService?: CreditService;
  /** Absent = same as above. Both must be present for any billing to happen. */
  tierGuard?: TierGuard;
  /**
   * The price of this request (workorder 31B). REQUIRED whenever billing is on:
   * the two dependencies above say "billing is enabled", and this one says "and
   * we know what it costs". Missing it with billing on is a wiring mistake and
   * throws below — falling back to 0 here would make one forgotten line free for
   * every workspace.
   */
  priceQuoter?: PriceQuoter;
  /**
   * The ledger row a PENDING price leaves behind (workorder 31B). Only reached
   * when the quote answers `pending`; absent then, the request fails loudly
   * rather than running for 0 with no record of why.
   */
  creditLedgerWriteRepository?: CreditLedgerWriteRepository;
  /** Required whenever `request.job` is set. */
  jobService?: JobService;
  /**
   * Workorder 39K (BL-41): where a refund that FAILED is registered for the
   * compensation queue. Optional on purpose — absent, a failed refund keeps the
   * pre-39K behaviour (one loud log line) so no existing wiring changes meaning.
   *
   * Same shape as `refund-job.ts`'s `recordCompensation`, plus the flag that says
   * this job must also be marked `credits_link_refunded` once the money is back.
   */
  recordRefundCompensation?: (input: {
    jobId: string;
    workspaceId: string;
    userId: string;
    amount: number;
    description: string;
    markLinkRefunded: boolean;
    error: string;
  }) => Promise<void>;
}

export interface BillingRequest {
  user: AuthenticatedUser;
  workspaceId: string;
  modelId: string;
  /**
   * Which entry point asked (GN-09: `agent` / `canvas_generator` / …).
   *
   * REQUIRED on purpose (workorder 31B ruling 3): the price table matches on it,
   * so a call site that forgets it must fail the build rather than quietly quote
   * the wildcard row for every entry point.
   */
  entryPoint: EntryPoint;
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
    /**
     * ED-00m: the browser-chosen submission id, when the caller sent one.
     *
     * With it set, this function first asks whether the SAME user already has a
     * job under it within 24 hours, and if so it reuses that job, charges
     * nothing and creates nothing — the double-click of a submit button is one
     * submission. Without it, nothing is looked up and the request is exactly
     * what it was before this ticket.
     */
    clientRequestId?: string;
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
  /** 0 when the credit system is not configured, the model is free, or it is pending. */
  creditsCost: number;
  /**
   * What the quote said (workorder 31B, ruling in T3): `"pending"` = the price is
   * not set yet and this run leaves a 0-amount ledger row; `"active"` = the table
   * priced it. `null` when billing is switched off, because then nobody quoted
   * anything.
   *
   * Nothing reads it yet — BL-22 (next ticket) is where it becomes visible.
   */
  priceStatus: "pending" | "active" | null;
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
  const { creditService, tierGuard, priceQuoter, creditLedgerWriteRepository, jobService } = deps;
  const { user, workspaceId, modelId, entryPoint, guard, description } = request;

  if (request.job && !jobService) {
    // A wiring mistake, not a runtime condition: the caller asked for a job and
    // there is nothing to create it with. Fail loudly at the point of the bug.
    throw new Error(
      "withBilling: request.job was provided but deps.jobService is missing. " +
        "Either pass a job service or omit request.job.",
    );
  }

  const billingEnabled = !!creditService && !!tierGuard;

  if (billingEnabled && !priceQuoter) {
    // Workorder 31B ruling 7, written the same way as the jobService check above:
    // with billing on, "we do not know the price" must never degrade into "so it
    // is free". One forgotten wiring line would otherwise make every generation
    // on the deployment cost 0 and produce no complaint.
    throw new Error(
      "withBilling: deps.creditService and deps.tierGuard are set but " +
        "deps.priceQuoter is missing. Wire a price quoter (or turn billing off).",
    );
  }

  // ED-00m — "the same submission id is the same job", before ANY money or job:
  //
  //   submitted again with `clientRequestId` -> look it up -> found -> hand the
  //   EXISTING job to `run` and return.
  //
  // This sits after the two wiring checks above (a request that cannot be served
  // must fail for that reason, not because a lookup found nothing) and BEFORE
  // the quote, the balance read, the job insert, the pending ledger row, the
  // deduction and `setCreditsInfo`. A hit therefore performs none of them: no
  // price is quoted, no credit moves, no second job is created and no
  // confirmation is written — the original call already did all of that.
  //
  // `creditsCost: 0` in the outcome means "THIS call charged nothing". It is not
  // a discount and not a free generation: the charge for this job happened in the
  // call that created it, and `priceStatus: null` says so — no quote was made
  // here, so there is no price status to report.
  //
  // A lookup that FAILS propagates (the job service answers `job_query_failed`):
  // "we could not tell whether this is a duplicate" must not be answered with a
  // second job and a second charge. Nothing has been charged at this point, so
  // there is nothing to refund either.
  if (request.job?.clientRequestId) {
    const lookup = jobService?.findRecentJobByClientRequestId;
    // A job service from before this method existed (or a test double without
    // it) means deduplication is off; the request then runs exactly as it did
    // before this ticket rather than failing.
    if (typeof lookup === "function") {
      const existing = await lookup.call(
        jobService,
        user,
        request.job.clientRequestId,
      );
      if (existing) {
        return await run({ job: existing, creditsCost: 0, priceStatus: null });
      }
    }
  }

  // Workorder 39P (AD-01 / BL-21 step 3) — the administrator's pause, AFTER the
  // duplicate lookup and BEFORE the tier guard, the quote, the balance read, the
  // job, the charge and `run`:
  //
  //   paused -> `onRejected({ kind: "account_suspended" })` then a 403
  //   `account_suspended`. Nothing is quoted, created, charged or generated.
  //
  // After the duplicate lookup on purpose: a re-submission of a job that was
  // created BEFORE the pause still returns that job (it already exists and was
  // already paid for), instead of turning a double-click into an error the
  // member cannot act on. The pause governs new generation, not the answer to
  // "what happened to the one I already submitted".
  //
  // Before the tier guard on purpose: a suspended member must be told the one
  // true reason. Reaching the guard first would answer "your plan does not allow
  // this model" and reaching the quote first would answer "no price" — both are
  // wrong and both leave the member trying to fix the wrong thing.
  //
  // The method is OPTIONAL on `CreditService` (workorder 39P, E-020): a wiring
  // or a test double without it keeps the pre-39P flow exactly, so no existing
  // call site or pinned case changes meaning. A THROW from it is NOT swallowed:
  // "we could not tell whether the member is suspended" must never be answered
  // with a generation, which is the same rule the duplicate lookup above
  // follows.
  if (creditService?.isGenerationPaused) {
    const paused = await creditService.isGenerationPaused(user.id);
    if (paused) {
      request.onRejected?.({ kind: "account_suspended" });
      throw new CreditServiceError(
        "account_suspended",
        "账户已被管理员暂停生成，请联系管理员",
        403,
      );
    }
  }

  let creditsCost = 0;
  // The quote, once it answered. Kept as ONE value so "billing is off" (null) and
  // "the price is pending" (status "pending") can never be confused, and so the
  // pending branch below reads a value that is guaranteed complete instead of
  // three loose variables that could drift apart.
  let quoted: {
    status: "pending" | "active";
    detail: PriceDetail;
    ruleId: string;
  } | null = null;

  if (billingEnabled) {
    let searchKey: string;
    try {
      const sub = await creditService.getSubscription(workspaceId);
      tierGuard.checkModelAccess(sub.plan, modelId);
      // Workorder 31D ruling 3: the tier a request is guarded and priced on is
      // derived by ONE pure function (`features/pricing/search-key.ts`), shared
      // with `POST /api/pricing/quote`. Two copies of this derivation would let a
      // quote and the charge that follows it ask the price table about different
      // tiers of the same request — a difference the ledger cannot show.
      //
      // The image branch calls it with the narrowed guard so the resolved tier is
      // non-nullable: image guards always resolve a concrete level (`plan_max`
      // included), and `checkResolution` must never be skipped.
      if (guard.jobType === "image_generation") {
        const billing = billingSearchKey(guard, sub.plan);
        searchKey = billing.searchKey;
        tierGuard.checkResolution(sub.plan, billing.effectiveQuality);
      } else {
        searchKey = billingSearchKey(guard, sub.plan).searchKey;
        if (guard.resolution) {
          tierGuard.checkVideoResolution(sub.plan, guard.resolution);
        }
      }
      await tierGuard.checkConcurrency(workspaceId, sub.plan, user.id);
    } catch (err) {
      if (err instanceof TierGuardError) {
        request.onRejected?.({ kind: "tier", error: err });
      }
      throw err;
    }

    // Workorder 31B ruling 4 — what to ask the price table for.
    //
    // Images: the QUALITY AFTER `plan_max` is resolved, so the plan's own maximum
    // is the tier that gets priced (asking for `plan_max` would match the wildcard
    // row and quietly price a hd request off the model default).
    // Video: the requested resolution, or `"unspecified"`. Video only has a
    // default row today, so that answer is the default row — expected, not a bug.
    //
    // Both of those sentences are now implemented by `billingSearchKey` above
    // (workorder 31D); this comment records the ruling, not a second copy of it.

    // One clock reading per request (ruling 5): `at` decides which rules are in
    // force, and quoting twice with two different "now"s could straddle an
    // activation time inside a single charge.
    const outcome = await priceQuoter!.quote({
      modelId,
      entryPoint,
      searchKey,
      at: new Date(),
    });

    if (!outcome.ok) {
      // Ruling 6: refuse BEFORE the job exists and before the balance read. A
      // model the table does not know is not sellable at any price, so there is
      // nothing to create, nothing to check and nothing to charge.
      request.onRejected?.({ kind: "model_not_available", modelId });
      throw new CreditServiceError(
        "model_not_available",
        `Model "${modelId}" is not available for generation.`,
        400,
      );
    }

    quoted = {
      status: outcome.detail.price_status,
      detail: outcome.detail,
      ruleId: outcome.ruleId,
    };
    creditsCost = outcome.detail.total_price;
  }

  // Balance pre-check. Previously only the agent paths did this; without it the
  // HTTP paths created a job, failed the deduction, then cancelled the job.
  // A pending price is 0, so it never reaches here — exactly like a free one.
  if (billingEnabled && creditsCost > 0) {
    // Workorder 38E (T-107 / BL-45): with the three pools on, ask the pools for
    // the precise refusal FIRST. Without it the pre-check always said
    // `insufficient_credits` and the member never learned that their own cap or
    // the team pool is what ran out. `undefined` (switch off, or no team
    // workspace) means the old comparison below is the answer, unchanged.
    const refusal = creditService.refusalFor
      ? await creditService.refusalFor({
          workspaceId,
          userId: user.id,
          amount: creditsCost,
        })
      : undefined;

    if (refusal !== null && refusal !== undefined) {
      // Same refusal event shape as 37T; only the thrown code and the message
      // are more precise.
      const refusalAvailable =
        (await creditService.availableFor?.({
          workspaceId,
          userId: user.id,
        })) ?? 0;
      const personalCap = refusal.personalCap;
      const refusalMessage =
        refusal.code === "personal_cap_reached"
          ? Number.isFinite(personalCap) && personalCap > 0
            ? `本月额度已用完（上限 ${personalCap}），可联系管理员调整`
            : "本月额度已用完，可联系管理员调整"
          : refusal.code === "team_pool_exhausted"
            ? "团队本月额度已用完"
            : "积分不足";
      // Workorder 39H (T-107 / BL-45): the EVENT now carries exactly the code and
      // the sentence of the error thrown right below it, in its own
      // `pool_refusal` shape, and without `plan` / `dailyClaimed`. Reported as
      // `insufficient_credits` with `plan: "free"` / `dailyClaimed: false`, a
      // personal cap or an empty team pool reached the user as "buy credits" plus
      // a daily-claim button that could not help — the pools were what ran out.
      request.onRejected?.({
        kind: "pool_refusal",
        code: refusal.code,
        message: refusalMessage,
        currentBalance: refusalAvailable,
        requiredAmount: creditsCost,
      });
      throw new CreditServiceError(refusal.code, refusalMessage, 402);
    }

    if (refusal === undefined) {
      // Workorder 37T: with the three pools on, the figure to compare is the
      // pooled available credit, not the old single balance. Absent (switch off)
      // or null (no team workspace) = the old comparison below, unchanged.
      const pooledAvailable =
        (await creditService.availableFor?.({ workspaceId, userId: user.id })) ??
        null;
      if (pooledAvailable !== null && pooledAvailable < creditsCost) {
        const pooledMessage = `Insufficient credits: ${pooledAvailable} available, ${creditsCost} required.`;
        // Workorder 39H (T-107 / BL-45): no pool cap was hit here — the pooled
        // figure is simply short of the price — so the code stays
        // `insufficient_credits`. It still travels in the same `pool_refusal`
        // shape as the two pool refusals above, with the thrown error's message,
        // because the old `plan` / `dailyClaimed` pair only describes the legacy
        // single balance and the client read it as "this is a free-tier user".
        request.onRejected?.({
          kind: "pool_refusal",
          code: "insufficient_credits",
          message: pooledMessage,
          currentBalance: pooledAvailable,
          requiredAmount: creditsCost,
        });
        throw new CreditServiceError(
          "insufficient_credits",
          pooledMessage,
          402,
        );
      }
      const balanceInfo =
        pooledAvailable !== null
          ? null
          : await creditService.getBalance(workspaceId);
      if (balanceInfo !== null && balanceInfo.balance < creditsCost) {
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
  }

  // Workorder 39G (GN-33): a paid job that is also being created goes through ONE
  // atomic entry when the job service has it. The job row, the charge and the
  // queue message are written by a single database transaction, so a refused
  // charge leaves no queued job behind and a failed enqueue leaves the balance
  // untouched. The 21H0 H10 (cancel after a failed charge) and 21H2 (compensate
  // an unlinked charge) compensations below only apply when `createChargedJob`
  // does not exist, i.e. the charged-job repository is not wired.
  let charged = false;
  const atomic =
    billingEnabled &&
    creditsCost > 0 &&
    request.job !== undefined &&
    typeof jobService?.createChargedJob === "function";

  let job: BackgroundJob | undefined;
  if (request.job) {
    const createInput = {
      workspaceId,
      ...(request.job.refs ?? {}),
      jobType: guard.jobType,
      payload: request.job.payload,
      // ED-00m: a lookup that found nothing (or was never wired) still records
      // the submission id on the row it creates, so the NEXT submission of the
      // same id is answered with this job.
      ...(request.job.clientRequestId
        ? { clientRequestId: request.job.clientRequestId }
        : {}),
    };
    if (atomic) {
      const target = creditService.chargeTarget
        ? await creditService.chargeTarget(workspaceId)
        : { workspaceId, usePools: false };
      // Errors (`CreditServiceError` / `JobServiceError`) propagate unchanged:
      // the transaction rolled back, so there is nothing to cancel or refund.
      const created = await jobService!.createChargedJob!(user, createInput, {
        amount: creditsCost,
        description,
        usePools: target.usePools,
        chargeWorkspaceId: target.workspaceId,
      });
      job = created.job;
      // Already charged inside the same transaction, `credits_cost` included.
      charged = true;
    } else {
      job = await jobService!.createJob(user, createInput);
    }
  }

  // Workorder 31B ruling 8 — the pending ledger row, and it comes BEFORE the
  // billing confirmation below:
  //
  //   job -> pending ledger row -> setCreditsInfo(job, 0, null) -> run
  //
  // The row is written whether or not there is a job: the synchronous image route
  // creates none, and "this model was used while unpriced" is exactly the fact
  // that must survive from that route too (`jobId` is then null).
  if (billingEnabled && quoted?.status === "pending") {
    if (!creditLedgerWriteRepository) {
      // Not silently skipped: a pending run that leaves no ledger row is
      // indistinguishable from one that never happened, which is the whole point
      // of this branch. Same reaction as a failed write (ruling 8, below).
      const missingLedger = new Error(
        "withBilling: the quoted price is pending but " +
          "deps.creditLedgerWriteRepository is missing. Wire the credit ledger " +
          "writer (or price the model) so the 0-amount consume row has an owner.",
      );
      if (job) await jobService!.cancelJob(user, job.id).catch(() => {});
      throw missingLedger;
    }

    try {
      await creditLedgerWriteRepository.recordPendingConsume({
        workspaceId,
        userId: user.id,
        jobId: job?.id ?? null,
        description,
        ruleId: quoted.ruleId,
        priceDetail: quoted.detail,
      });
    } catch (ledgerError) {
      // Ruling 8: the same reaction as a failed `setCreditsInfo` — the job must
      // not stay startable when the record of what it costs could not be written.
      // The cancel's own failure is swallowed so the caller sees the write error.
      if (job) await jobService!.cancelJob(user, job.id).catch(() => {});
      throw ledgerError;
    }
  }

  // Charge before running. Deliberately not moved after generation: the balance
  // check and the deduction have to happen up front or concurrent runs can both
  // pass the check and overdraw.
  if (billingEnabled && creditsCost > 0 && !atomic) {
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
          ...(deps.recordRefundCompensation
            ? { recordRefundCompensation: deps.recordRefundCompensation }
            : {}),
        });
        throw linkError;
      }
    }
  } else if (job && !atomic) {
    // Workorder 21H1: the paths that charge nothing still have to RECORD that
    // they charged nothing. `createJob` enqueues the job before this function
    // runs, so the worker may already be holding the message; with `credits_cost`
    // left NULL that message is indistinguishable from a job whose charge has not
    // happened yet, and the worker's billing gate would defer it for ten minutes
    // and then fail it as `billing_not_confirmed`.
    //
    // Three paths reach this branch: a deployment with the credit system switched
    // off, an ACTIVE price of 0 (a decision), and a PENDING price (no decision
    // yet, workorder 31B). The last one has already left its 0-amount ledger row
    // above — that row records *why* the cost was 0, this confirmation only
    // records *that* it is.
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
    return await run({ ...(job ? { job } : {}), creditsCost, priceStatus: quoted?.status ?? null });
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
  /**
   * Workorder 39K (BL-41): the recorder for a refund that failed HERE. This is the
   * one place that can lose money without a job ever being failed, so the debt is
   * registered with `markLinkRefunded: true` — whoever retries it must also write
   * the `credits_link_refunded` mark that the failed branch below never reached.
   */
  recordRefundCompensation?: (input: {
    jobId: string;
    workspaceId: string;
    userId: string;
    amount: number;
    description: string;
    markLinkRefunded: boolean;
    error: string;
  }) => Promise<void>;
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
    // Workorder 39K (BL-41): the log line above used to be the whole record of
    // this debt. Register it instead, with the mark the retry still owes. The
    // recording is best-effort: it must neither throw (the caller is about to
    // rethrow the link error) nor be silent when it fails.
    if (args.recordRefundCompensation) {
      try {
        await args.recordRefundCompensation({
          jobId: args.jobId,
          workspaceId: args.workspaceId,
          userId: args.userId,
          amount: args.creditsCost,
          description: args.description,
          markLinkRefunded: true,
          error: describeError(refundError),
        });
      } catch (recordError) {
        console.error(
          `[with-billing] failed to record the refund compensation for job ` +
            `${args.jobId}: workspace ${args.workspaceId} is still owed ` +
            `${args.creditsCost} credits and no queue row was written: ` +
            describeError(recordError),
        );
      }
    }
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
