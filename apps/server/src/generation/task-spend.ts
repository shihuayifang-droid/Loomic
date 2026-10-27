/**
 * The per-task spend guard applied to one billable upstream call (QA-15 / 45DX).
 *
 * `spend-guard.ts` (45DT) counts credits for a task but deliberately holds no
 * call site: it cannot know what "the next upstream call" is. This module is the
 * call-site half. One function, {@link runBillableStep}, wraps exactly one
 * billable step:
 *
 *   - BEFORE the step: `wouldExceed(cost)` — once the task cannot afford the
 *     step, the step is never started, so no upstream request is sent and no
 *     credits are burned on a task the user has been told stopped;
 *   - AFTER the step answered: `charge(cost)` — the amount is only accumulated
 *     once the work really happened, and a refusal here (the task hit its
 *     budget while the call was in flight) still aborts the task instead of
 *     pretending the step was free.
 *
 * Both refusals throw the SAME error, so a caller has one code to publish and
 * one thing to check: {@link TaskBudgetExceededError} carries
 * `code = "task_budget_exceeded"`, the stable machine-readable code the job
 * runner turns into a terminal `failed` row (see `process-job-message.ts`).
 *
 * A guard that is absent (a construction site that has not been wired, or a
 * unit test of an executor on its own) makes this a pass-through: the step runs
 * unchanged. That is deliberate — this module must not become a second place
 * where a missing dependency silently changes how much work a job does.
 *
 * The amount is NOT chosen here: the caller passes the cost it already has (for
 * the image executor, the credits this job was charged, read from the billing
 * gate). Inventing a price table in this module would create a second source of
 * truth for what a generation costs.
 */
import type { SpendGuard, SpendGuardRejectionCode } from "./spend-guard.js";

/** The one code a budget refusal publishes. Same string as the guard's. */
export const TASK_BUDGET_ERROR_CODE: SpendGuardRejectionCode = "task_budget_exceeded";

/** Everything a refusal needs to explain itself in a log or a job row. */
export type TaskBudgetExceededInfo = {
  /** What the step would have cost, in credits. */
  cost: number;
  /** Credits the task had already spent when the refusal happened. */
  spent: number;
  /** The task's budget, in credits. */
  limit: number;
  /** The task (job) id, when the caller knows it. */
  taskId?: string | undefined;
};

/**
 * Thrown when a task may not spend any more credits.
 *
 * `code` is a plain property rather than a subclass check because the job runner
 * reads `(error as { code?: string }).code` — the same shape the rest of this
 * server uses for `retryable` provider failures — so the refusal survives being
 * wrapped, logged and re-thrown.
 */
export class TaskBudgetExceededError extends Error {
  readonly code: SpendGuardRejectionCode = TASK_BUDGET_ERROR_CODE;
  readonly cost: number;
  readonly spent: number;
  readonly limit: number;
  readonly taskId: string | null;

  constructor(info: TaskBudgetExceededInfo) {
    super(
      `task-spend.runBillableStep: task ${info.taskId ?? "(unknown)"} has spent ` +
        `${info.spent} of ${info.limit} credits, so a ${info.cost}-credit upstream call ` +
        `is refused (${TASK_BUDGET_ERROR_CODE})`,
    );
    this.name = "TaskBudgetExceededError";
    this.cost = info.cost;
    this.spent = info.spent;
    this.limit = info.limit;
    this.taskId = info.taskId ?? null;
  }
}

/** True when `error` is (or carries) a budget refusal. */
export function isTaskBudgetExceededError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === TASK_BUDGET_ERROR_CODE;
}

/**
 * Run ONE billable step under the task's guard.
 *
 * `guard === undefined` (or `null`) runs the step without counting — the caller
 * has not been wired, which the executors treat as "no per-task budget here".
 */
export async function runBillableStep<T>(
  guard: SpendGuard | undefined,
  cost: number,
  step: () => Promise<T>,
  taskId?: string,
): Promise<T> {
  if (guard) {
    if (guard.wouldExceed(cost)) {
      throw new TaskBudgetExceededError({ cost, spent: guard.spent, limit: guard.limit, taskId });
    }
  }

  const value = await step();

  if (guard) {
    const outcome = guard.charge(cost);

    if (!outcome.allowed) {
      throw new TaskBudgetExceededError({ cost, spent: outcome.spent, limit: outcome.limit, taskId });
    }
  }

  return value;
}
