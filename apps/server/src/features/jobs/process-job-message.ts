/**
 * Handling of ONE job message (GN-30 / GN-34, workorder 21H1).
 *
 * Lifted out of `worker.ts` so the branches below are testable without a worker,
 * a queue or a database. The worker keeps the polling loop, concurrency and
 * shutdown; everything about what a single message does lives here.
 *
 * The state machine it implements:
 *
 *   queued ──markRunning──▶ running ──markSucceeded──▶ succeeded
 *                              │
 *                              ├─markRetrying──▶ retrying ──markRunning──▶ running
 *                              │
 *                              └─markFailed──▶ failed  (terminal, refunds once)
 *
 * Before any of that, one gate stands in front of the attempt counter:
 *
 *   ┌ billing gate ────────────────────────────────────────────────────────────┐
 *   │ read the job's billing state (status, credits_cost, overdue)             │
 *   │                                                                          │
 *   │  read failed                       -> log, touch nothing (VT re-delivers)│
 *   │  no such row                       -> fall through (archived below)      │
 *   │  status not queued/retrying        -> fall through, untouched            │
 *   │  credits_cost not null (0 or more) -> fall through: it is paid for       │
 *   │  null, inside the window           -> renewVt(10s), touch nothing else   │
 *   │  null, past the window             -> claim it as a terminal billing     │
 *   │                                       failure (no refund), or defer if   │
 *   │                                       the claim lost a race              │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHY THE GATE EXISTS
 * `createJob` enqueues the message BEFORE `withBilling` charges the workspace, so
 * a worker can hold a message for a job that has not been paid for yet — and,
 * until workorder 21H1, `credits_cost` NULL was indistinguishable from "free
 * model". Without the gate the model is called and credits are spent on work
 * nobody paid for (risk T-39 ①).
 *
 * WHY DEFERRING DOES NOT CONSUME AN ATTEMPT
 * The gate sits BEFORE `incrementAttempt`, and the deferring arms touch nothing
 * at all: no increment, no status write, no archive, no delete, no execution.
 * Consuming an attempt for a job that is merely waiting for its charge would
 * spend the retry budget on the queue's timing rather than on the job — three
 * deferrals (30 seconds of visibility) would turn a healthy, paid job into
 * `max_attempts_exceeded`. Instead the message is renewed for
 * `BILLING_DEFER_VT_SECONDS` and comes back; when the charge lands, the next
 * delivery passes the gate and the job runs with its full budget intact.
 *
 * Two more rules matter as much as the shape:
 *   - A retryable failure writes `retrying`, never `failed`. Writing `failed`
 *     told the user the generation was over while the worker was still going to
 *     retry it — and a manual re-submit at that point charged twice.
 *   - Credits are refunded only when `markFailed` actually changed a row, so two
 *     workers judging the same job cannot both refund. The billing-gate failure
 *     is deliberately NOT routed through `markFailed`: a job that was never
 *     billed has nothing to refund, and its own statement carries the
 *     `credits_cost is null` predicate that stops it racing a charge.
 */
import type { BackgroundJobType } from "@loomic/shared";

import type {
  JobBillingGateRepository,
  JobBillingGateRow,
} from "../../db/job-billing-gate-repository.js";
import type { PgmqClient, PgmqMessage } from "../../queue/pgmq-client.js";
import type { ExecutorContext, JobExecutor } from "./job-executor.js";
import { JOB_TYPE_REGISTRY } from "./job-registry.js";
import type { JobService } from "./job-service.js";

/** Retrying these can only fail again the same way. */
const NON_RETRYABLE_CODES = new Set([
  "invalid_input",
  "model_not_found",
  "provider_not_found",
  "safety_filter",
  // GN-31. The whole execution budget for this job is already spent, so a retry
  // would spend another full budget on work that has just proved it cannot
  // finish in time. The job goes terminal (`failed` + `timeout`) and is
  // refunded exactly once, like every other non-retryable failure.
  "timeout",
]);

/**
 * How long a job may stay unbilled before the worker stops waiting for its
 * charge and fails it as `billing_not_confirmed`.
 *
 * Ten minutes is far longer than the window between `createJob`'s enqueue and
 * `withBilling`'s `setCreditsInfo` (one deduction round trip, normally well
 * under a second), so a healthy request never sees it. It is also short enough
 * that a job whose charge genuinely never happened is retired within the same
 * session instead of sitting queued forever.
 */
export const BILLING_CONFIRM_TIMEOUT_SECONDS = 600;

/**
 * How long a message is made invisible while the job waits for its charge.
 *
 * Short on purpose: the wait is bounded by a database round trip, so the message
 * only has to come back soon enough to be noticed — polling every ten seconds
 * costs nothing, while a long renew would delay a job whose charge landed a
 * moment after the read.
 */
export const BILLING_DEFER_VT_SECONDS = 10;

/**
 * GN-31: how long one attempt of a job may run before it is failed as `timeout`.
 *
 * The requirement's shape is "the model's estimated duration (MD-07) times 3".
 * MD-07 carries no per-model estimate yet, so the specified fallback is used
 * instead: the queue's visibility timeout times the attempt budget. That is
 * the right order of magnitude on purpose — an executor that is healthy renews
 * its visibility timeout while it works, so the VT is the only existing
 * statement of "how long this kind of job is expected to take".
 *
 * `maxAttempts` bounds the JOB, not one attempt: a job that still has attempts
 * left must not be killed by a budget it never got to use. `Math.max(1, ...)`
 * keeps a nonsensical budget (0, on a row that has not been counted) from
 * collapsing the limit to zero milliseconds.
 *
 * Once MD-07 has an estimate, the body becomes `estimateMs * 3` and this
 * registry lookup stays only as its fallback.
 */
export function executorTimeoutMs(jobType: BackgroundJobType, maxAttempts: number): number {
  return JOB_TYPE_REGISTRY[jobType].visibilityTimeoutSeconds * Math.max(1, maxAttempts) * 1000;
}

/**
 * Races one executor call against its execution budget (GN-31).
 *
 * The executor is started BEFORE the race and handed in as a promise, so the
 * timer measures the work rather than the scheduling. Three properties matter:
 *
 *   - the executor's OWN failure wins the race unchanged: only the timer builds
 *     the `timeout` error, so a provider error keeps its original code and the
 *     retry / non-retryable branches below still see what they always saw;
 *   - the timer is cleared on both settle paths, so a job that finishes in a
 *     millisecond does not leave a timer holding the worker (or the test
 *     process) open for the rest of its budget;
 *   - a work promise that settles AFTER the timer loses the race and its value
 *     is dropped: `resolve` on an already-rejected promise does nothing, so a
 *     late success never reaches the success branch from this delivery. Even if
 *     it could, the success branch only writes a row that is still `running`,
 *     and the terminal failure has already moved this one to `failed`.
 */
function withExecutionBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  budgetExceeded: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(budgetExceeded());
    }, budgetMs);

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type ProcessJobMessageDeps = {
  jobService: JobService;
  /**
   * The billing gate: the read and the timeout claim that decide whether this
   * job may consume an attempt. Required, not optional — a worker wired without
   * it cannot tell a paid job from an unbilled one, which is exactly the state
   * this gate exists to end.
   */
  billingGate: JobBillingGateRepository;
  /** Only the two message-lifecycle calls are needed here. */
  pgmq: Pick<PgmqClient, "archive" | "deleteMsg">;
  getExecutor: (jobType: BackgroundJobType) => JobExecutor | undefined;
  /**
   * GN-31: the execution budget for one attempt, in milliseconds. Optional so a
   * test can inject a very short budget; absent means `executorTimeoutMs` above,
   * the VT-based default. It is a function rather than a constant because the
   * budget depends on the job type and on the attempts this job was granted.
   */
  executorTimeoutMs?: (jobType: BackgroundJobType, maxAttempts: number) => number;
  /** Refund for a terminally failed job. The worker's implementation logs instead of throwing. */
  refundJob: (jobId: string) => Promise<void>;
  log: (message: string) => void;
};

export type ProcessJobMessageArgs = {
  queue: string;
  /** The type this queue serves, per JOB_TYPE_REGISTRY — used when the message
   * itself does not carry job_type. */
  queueJobType: BackgroundJobType;
  msg: PgmqMessage;
  ctx: ExecutorContext;
};

export async function processJobMessage(
  deps: ProcessJobMessageDeps,
  args: ProcessJobMessageArgs,
): Promise<void> {
  const { queue, queueJobType, msg, ctx } = args;
  const jobId = msg.message.job_id as string | undefined;
  const jobType = (msg.message.job_type as BackgroundJobType | undefined) ?? queueJobType;

  // 1. Message without a job id — nothing can be done with it.
  if (!jobId || !jobType) {
    deps.log(`Invalid message in ${queue}: ${JSON.stringify(msg.message)}`);
    await deps.pgmq.archive(queue, msg.msg_id);
    return;
  }

  const startedAt = Date.now();

  /**
   * Terminal failure: mark failed → refund (only if the row really changed) → archive.
   *
   * `markFailed === false` means someone else already moved this job out of a
   * markable state, so refunding here would pay it twice.
   */
  const terminalFail = async (errorCode: string, errorMessage: string) => {
    const marked = await deps.jobService.markFailed(jobId, errorCode, errorMessage);

    if (marked) {
      try {
        await deps.refundJob(jobId);
      } catch (refundError) {
        // A refund failure must not stop the message from being archived: the
        // job is already terminal, and re-delivering it would re-run the work.
        deps.log(
          `Refund failed for job ${jobId}: ${
            refundError instanceof Error ? refundError.message : String(refundError)
          }`,
        );
      }
    }

    await deps.pgmq.archive(queue, msg.msg_id);
  };

  // 2. No executor registered for this type.
  const executor = deps.getExecutor(jobType);

  if (!executor) {
    deps.log(`No executor for job type: ${jobType}`);
    await terminalFail("no_executor", `No executor registered for ${jobType}`);
    return;
  }

  // 3. Billing gate. Runs BEFORE the attempt counter, so waiting for a charge
  //    never costs an attempt (see the header). Four answers are legal:
  //      - `null` (no such row) and any status other than queued/retrying fall
  //        through to the original flow untouched;
  //      - a non-null `creditsCost` (0 included) is a confirmation and falls
  //        through too;
  //      - queued/retrying with a null cost is the state this gate exists for:
  //        defer while the window is open, claim the job once it is over.
  let gate: JobBillingGateRow | null;

  try {
    gate = await deps.billingGate.readBillingGate({
      jobId,
      timeoutSeconds: BILLING_CONFIRM_TIMEOUT_SECONDS,
    });
  } catch (gateError) {
    // G1. The answer is unknown, so nothing may be assumed from it. Touch
    // nothing: the message stays invisible until its visibility timeout expires
    // and is then delivered again. Archiving here would drop a job that may well
    // be paid for, and failing it would punish a database hiccup.
    deps.log(
      `Billing gate read failed for job ${jobId}, leaving the message for a later retry: ${
        gateError instanceof Error ? gateError.message : String(gateError)
      }`,
    );
    return;
  }

  if (
    gate !== null &&
    (gate.status === "queued" || gate.status === "retrying") &&
    gate.creditsCost === null
  ) {
    if (gate.overdue) {
      // G5. The job is not paid for and its window is over. The claim is one
      // atomic statement whose predicate re-checks all three conditions, so it
      // cannot overwrite a charge that landed while this worker was deciding.
      let claimed: boolean;

      try {
        claimed = await deps.billingGate.failUnbilledIfOverdue({
          jobId,
          timeoutSeconds: BILLING_CONFIRM_TIMEOUT_SECONDS,
        });
      } catch (claimError) {
        // A failed claim is the same unknown as G1 — it must not be mistaken for
        // a refusal, and it must not be retried from here.
        deps.log(
          `Billing gate claim failed for job ${jobId}, leaving the message for a later retry: ${
            claimError instanceof Error ? claimError.message : String(claimError)
          }`,
        );
        return;
      }

      if (claimed) {
        // This delivery owns the outcome: the row really moved to `failed` with
        // `billing_not_confirmed`, written by the claim's own statement.
        //
        // Deliberately NO `refundJob` and no `terminalFail`: a job that was never
        // billed has nothing to refund (`credits_cost is null` is part of the
        // claim's predicate), and `markFailed` would both race a charge landing
        // now and treat the changed row as "refund this job".
        await deps.pgmq.archive(queue, msg.msg_id);
        deps.log(
          `Job ${jobId} was not billed within ${BILLING_CONFIRM_TIMEOUT_SECONDS}s — failed as billing_not_confirmed, not refunded`,
        );
        return;
      }

      // The claim matched nothing: a charge landed, or the job was cancelled,
      // between the read and the write. Neither is this worker's to overrule, so
      // the message is deferred exactly as below and the next delivery re-reads
      // the truth.
    }

    // G4 (and the lost-race half of G5). Wait for the charge without spending
    // anything: no increment, no status write, no archive, no delete, no
    // execution. `renewVt`'s contract is that it never throws, so it is not
    // wrapped in a try. It is awaited so the deferral is written before this
    // delivery returns and releases its worker slot (T-43).
    await ctx.renewVt(BILLING_DEFER_VT_SECONDS);
    deps.log(
      `Job ${jobId} is not billed yet — deferred for ${BILLING_DEFER_VT_SECONDS}s without consuming an attempt`,
    );
    return;
  }

  // G2 (the row is gone: the counter below answers null and the message is
  // archived), G3 (paid for) and G6 (running/succeeded/failed/canceled and every
  // other status) all continue here, unchanged.

  // 4. Counting failed. Touch nothing: the message stays invisible until its
  //    visibility timeout expires and is then delivered again. Archiving here
  //    would silently drop a job that was already paid for.
  let counted: { attempt_count: number; max_attempts: number } | null;

  try {
    counted = await deps.jobService.incrementAttempt(jobId);
  } catch (countError) {
    deps.log(
      `incrementAttempt failed for job ${jobId}, leaving the message for a later retry: ${
        countError instanceof Error ? countError.message : String(countError)
      }`,
    );
    return;
  }

  // 5. The job row is gone.
  if (counted === null) {
    deps.log(`Job ${jobId} not found — archiving message`);
    await deps.pgmq.archive(queue, msg.msg_id);
    return;
  }

  const { attempt_count: attemptCount, max_attempts: maxAttempts } = counted;

  // 6. The attempts were already spent by an earlier worker that died before
  //    finishing. `>` (not `>=`): the count was just incremented, so on the
  //    third attempt the value is 3 and that attempt must still run.
  if (attemptCount > maxAttempts) {
    await terminalFail(
      "max_attempts_exceeded",
      `Job exceeded its attempt budget (${attemptCount}/${maxAttempts})`,
    );
    return;
  }

  // 7. Only queued/retrying jobs may start. `false` means cancelled or already
  //    terminal — do not execute and do not refund (cancel has its own rules).
  const running = await deps.jobService.markRunning(jobId);

  if (!running) {
    deps.log(`Job ${jobId} is no longer startable — archiving message`);
    await deps.pgmq.archive(queue, msg.msg_id);
    return;
  }

  try {
    const executorCtx: ExecutorContext =
      typeof gate?.creditsCost === "number" ? { ...ctx, creditsCharged: gate.creditsCost } : ctx;

    // GN-31. The executor renews the visibility timeout from the inside while it
    // works, so an upstream that hangs keeps its own message invisible forever
    // and the job stays `running` with no way out. The budget is that way out;
    // it is the only limit the executor cannot push back.
    const budgetMs = (deps.executorTimeoutMs ?? executorTimeoutMs)(jobType, maxAttempts);

    const result = await withExecutionBudget(
      executor(jobId, msg.message as Record<string, unknown>, executorCtx),
      budgetMs,
      () =>
        Object.assign(new Error(`Job ${jobId} exceeded its ${budgetMs}ms execution budget`), {
          code: "timeout",
        }),
    );

    // A job whose status is no longer `running` is not overwritten here — that
    // is what makes a late completion of a timed-out attempt harmless: the
    // timeout branch below has already written `failed`, and this guard refuses
    // to turn it back into `succeeded`.
    const marked = await deps.jobService.markSucceeded(jobId, result);

    if (!marked) {
      // Cancelled while it was running: keep that status, just drop the message.
      deps.log(`Job ${jobId} finished but is no longer running — status left as is`);
    }

    await deps.pgmq.deleteMsg(queue, msg.msg_id);
    deps.log(`Job ${jobId} succeeded +${Date.now() - startedAt}ms`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = (error as { code?: string })?.code ?? "executor_error";

    if (attemptCount >= maxAttempts || NON_RETRYABLE_CODES.has(errorCode)) {
      await terminalFail(errorCode, errorMessage);
      deps.log(
        `Job ${jobId} failed terminally after ${attemptCount} attempt(s) +${Date.now() - startedAt}ms: ${errorMessage}`,
      );
      return;
    }

    await deps.jobService.markRetrying(jobId, errorCode, errorMessage);
    // Deliberately NOT archived: the message comes back when the VT expires.
    deps.log(
      `Job ${jobId} will retry (attempt ${attemptCount}/${maxAttempts}) +${Date.now() - startedAt}ms: ${errorMessage}`,
    );
  }
}
