/**
 * Handling of ONE job message (GN-30 / GN-34).
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
 * Two rules matter more than the shape:
 *   - A retryable failure writes `retrying`, never `failed`. Writing `failed`
 *     told the user the generation was over while the worker was still going to
 *     retry it — and a manual re-submit at that point charged twice.
 *   - Credits are refunded only when `markFailed` actually changed a row, so two
 *     workers judging the same job cannot both refund.
 */
import type { BackgroundJobType } from "@loomic/shared";

import type { PgmqClient, PgmqMessage } from "../../queue/pgmq-client.js";
import type { ExecutorContext, JobExecutor } from "./job-executor.js";
import type { JobService } from "./job-service.js";

/** Retrying these can only fail again the same way. */
const NON_RETRYABLE_CODES = new Set([
  "invalid_input",
  "model_not_found",
  "provider_not_found",
  "safety_filter",
]);

export type ProcessJobMessageDeps = {
  jobService: JobService;
  /** Only the two message-lifecycle calls are needed here. */
  pgmq: Pick<PgmqClient, "archive" | "deleteMsg">;
  getExecutor: (jobType: BackgroundJobType) => JobExecutor | undefined;
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

  // 3. Counting failed. Touch nothing: the message stays invisible until its
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

  // 4. The job row is gone.
  if (counted === null) {
    deps.log(`Job ${jobId} not found — archiving message`);
    await deps.pgmq.archive(queue, msg.msg_id);
    return;
  }

  const { attempt_count: attemptCount, max_attempts: maxAttempts } = counted;

  // 5. The attempts were already spent by an earlier worker that died before
  //    finishing. `>` (not `>=`): the count was just incremented, so on the
  //    third attempt the value is 3 and that attempt must still run.
  if (attemptCount > maxAttempts) {
    await terminalFail(
      "max_attempts_exceeded",
      `Job exceeded its attempt budget (${attemptCount}/${maxAttempts})`,
    );
    return;
  }

  // 6. Only queued/retrying jobs may start. `false` means cancelled or already
  //    terminal — do not execute and do not refund (cancel has its own rules).
  const running = await deps.jobService.markRunning(jobId);

  if (!running) {
    deps.log(`Job ${jobId} is no longer startable — archiving message`);
    await deps.pgmq.archive(queue, msg.msg_id);
    return;
  }

  try {
    const result = await executor(jobId, msg.message as Record<string, unknown>, ctx);
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
