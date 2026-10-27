import { describe, expect, it } from "vitest";

import type { JobBillingGateRepository } from "../db/job-billing-gate-repository.js";
import type { ExecutorContext, JobExecutor } from "../features/jobs/job-executor.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { ProcessJobMessageDeps } from "../features/jobs/process-job-message.js";
import { processJobMessage } from "../features/jobs/process-job-message.js";
import { createSpendGuard, TASK_CREDIT_LIMIT, type SpendGuard } from "./spend-guard.js";
import {
  isTaskBudgetExceededError,
  runBillableStep,
  TaskBudgetExceededError,
  TASK_BUDGET_ERROR_CODE,
} from "./task-spend.js";

/**
 * QA-15 / workorder 45DX: the 200-credit per-task guard, driven through the REAL
 * job runner (`processJobMessage`) with a mock executor, mock repositories and
 * no network at all.
 *
 * The mock executor has the shape of the image executor: it makes a list of
 * billable upstream calls, each through the guard the runner handed it in
 * `ctx.spendGuard`. That is the wiring under test — the runner creates one guard
 * per task, the executor asks before spending and reports after, and a refusal
 * ends the task as `task_budget_exceeded`.
 */

type Row = { code: string; message: string };

function makeTask(jobId: string, costs: readonly number[]) {
  const calls: string[] = [];
  const failures: Row[] = [];
  const retries: Row[] = [];
  /** The upstream (provider) calls that were actually made. */
  const upstream: string[] = [];
  const succeeded: Array<Record<string, unknown>> = [];
  const archived: number[] = [];
  const deleted: number[] = [];
  let refunds = 0;
  let handedGuard: SpendGuard | undefined;

  const jobService = {
    async incrementAttempt() {
      calls.push("incrementAttempt");
      return { attempt_count: 1, max_attempts: 3 };
    },
    async markRunning() {
      calls.push("markRunning");
      return true;
    },
    async markRetrying(_jobId: string, code: string, message: string) {
      calls.push("markRetrying");
      retries.push({ code, message });
      return true;
    },
    async markSucceeded(_jobId: string, result: Record<string, unknown>) {
      calls.push("markSucceeded");
      succeeded.push(result);
      return true;
    },
    async markFailed(_jobId: string, code: string, message: string) {
      calls.push("markFailed");
      failures.push({ code, message });
      return true;
    },
  } as unknown as JobService;

  const executor: JobExecutor = async (_jobId, _payload, ctx) => {
    calls.push("executor");
    handedGuard = ctx.spendGuard;

    for (const cost of costs) {
      // The provider call is INSIDE the step: a refused step never reaches this
      // closure, which is exactly what "no upstream call after the refusal"
      // means.
      await runBillableStep(
        ctx.spendGuard,
        cost,
        async () => {
          upstream.push(`call-${cost}`);
          return { ok: true };
        },
        jobId,
      );
    }

    return { ok: true };
  };

  const billingGate = {
    async readBillingGate() {
      calls.push("readBillingGate");
      // A paid job (cost 0 at the gate), so the billing gate is a pass-through
      // and nothing below can be explained by it.
      return { status: "queued", creditsCost: 0, overdue: false };
    },
    async failUnbilledIfOverdue() {
      calls.push("failUnbilledIfOverdue");
      return true;
    },
  } as unknown as JobBillingGateRepository;

  const pgmq = {
    async archive(_queue: string, msgId: number) {
      calls.push("archive");
      archived.push(msgId);
    },
    async deleteMsg(_queue: string, msgId: number) {
      calls.push("deleteMsg");
      deleted.push(msgId);
    },
  };

  const deps: ProcessJobMessageDeps = {
    jobService,
    billingGate,
    pgmq: pgmq as never,
    getExecutor: () => executor,
    refundJob: async () => {
      calls.push("refundJob");
      refunds += 1;
    },
    log: () => {},
  };

  const args = {
    queue: "image_generation",
    queueJobType: "image_generation" as const,
    msg: {
      msg_id: 7,
      message: { job_id: jobId, job_type: "image_generation" },
    } as never,
    ctx: { renewVt: async () => {} } as unknown as ExecutorContext,
  };

  return {
    upstream,
    failures,
    retries,
    succeeded,
    archived,
    deleted,
    calls,
    refunds: () => refunds,
    handedGuard: () => handedGuard,
    run: () => processJobMessage(deps, args),
  };
}

describe("QA-15 / 45DX: the task credit budget wired into the generation chain", () => {
  it("① a task that stays under 200 credits runs every call and succeeds", async () => {
    const task = makeTask("job-under", [60, 50]);

    await task.run();

    expect(task.upstream).toEqual(["call-60", "call-50"]);
    expect(task.failures).toEqual([]);
    expect(task.retries).toEqual([]);
    expect(task.succeeded).toHaveLength(1);
    expect(task.deleted).toEqual([7]);

    // The runner really handed a guard to the executor, and it really counted.
    const guard = task.handedGuard();
    expect(guard).toBeDefined();
    expect(guard?.limit).toBe(TASK_CREDIT_LIMIT);
    expect(guard?.spent).toBe(110);
  });

  it("② 150 + 60: the second call is refused before it is made, the task fails as task_budget_exceeded, no success row", async () => {
    const task = makeTask("job-over", [150, 60]);

    await task.run();

    expect(task.upstream).toEqual(["call-150"]);
    expect(task.succeeded).toHaveLength(0);
    expect(task.deleted).toEqual([]);
    expect(task.failures).toHaveLength(1);
    const failure = task.failures[0];
    expect(failure?.code).toBe("task_budget_exceeded");
    expect(failure?.code).toBe(TASK_BUDGET_ERROR_CODE);
    expect(failure?.message).toContain(String(TASK_CREDIT_LIMIT));
    // A budget refusal is terminal, not a retry: a retry would hand the same
    // task a fresh budget. And it is not refunded: the 150 credits it spent
    // bought a real upstream call.
    expect(task.retries).toEqual([]);
    expect(task.refunds()).toBe(0);
    // The message is retired rather than re-delivered.
    expect(task.archived).toEqual([7]);
  });

  it("③ once refused, no further upstream call is made", async () => {
    const task = makeTask("job-stops", [150, 60, 60]);

    await task.run();

    expect(task.upstream).toHaveLength(1);
    expect(task.upstream).toEqual(["call-150"]);
    expect(task.succeeded).toHaveLength(0);
    expect(task.failures).toHaveLength(1);
  });

  it("④ two tasks do not share one budget (each gets its own 200)", async () => {
    // Task A spends 150, is refused at 60 and stops there.
    const first = makeTask("job-a", [150, 60]);
    await first.run();
    expect(first.upstream).toEqual(["call-150"]);
    expect(first.failures).toHaveLength(1);

    // Task B spends exactly 200. Had the guard been shared with A, its first
    // 150 would already have been refused (150 from A + 150 > 200).
    const second = makeTask("job-b", [150, 50]);
    await second.run();
    expect(second.upstream).toEqual(["call-150", "call-50"]);
    expect(second.failures).toEqual([]);
    expect(second.succeeded).toHaveLength(1);
    expect(second.handedGuard()?.spent).toBe(200);
  });

  it("runBillableStep refuses without running the step once the budget is gone", async () => {
    const guard = createSpendGuard({ limit: TASK_CREDIT_LIMIT });
    await runBillableStep(guard, 150, async () => "first");

    let ran = false;
    const error: unknown = await runBillableStep(guard, 60, async () => {
      ran = true;
      return "second";
    }).catch((thrown: unknown) => thrown);

    expect(ran).toBe(false);
    expect(error).toBeInstanceOf(TaskBudgetExceededError);
    expect(isTaskBudgetExceededError(error)).toBe(true);
    expect((error as TaskBudgetExceededError).code).toBe(TASK_BUDGET_ERROR_CODE);
    expect(guard.spent).toBe(150);
    expect(guard.blocked).toBe(false);
  });
});
