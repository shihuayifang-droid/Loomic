import { describe, expect, it } from "vitest";

import type { ExecutorContext, JobExecutor } from "./job-executor.js";
import type { JobService } from "./job-service.js";
import { processJobMessage } from "./process-job-message.js";

type Scenario = {
  increment?: () => Promise<{ attempt_count: number; max_attempts: number } | null>;
  markRunning?: () => Promise<boolean>;
  markRetrying?: () => Promise<boolean>;
  markSucceeded?: () => Promise<boolean>;
  markFailed?: () => Promise<boolean>;
  executorThrows?: { code?: string; message: string };
  executorReturns?: Record<string, unknown>;
  hasExecutor?: boolean;
  refundThrows?: boolean;
};

function makeHarness(scenario: Scenario = {}) {
  const calls: string[] = [];
  const failures: Array<{ code: string; message: string }> = [];
  const retries: Array<{ code: string; message: string }> = [];
  let refunds = 0;

  const jobService = {
    async incrementAttempt() {
      calls.push("incrementAttempt");
      if (scenario.increment) return scenario.increment();
      return { attempt_count: 1, max_attempts: 3 };
    },
    async markRunning() {
      calls.push("markRunning");
      return scenario.markRunning ? scenario.markRunning() : true;
    },
    async markRetrying(_jobId: string, code: string, message: string) {
      calls.push("markRetrying");
      retries.push({ code, message });
      return scenario.markRetrying ? scenario.markRetrying() : true;
    },
    async markSucceeded() {
      calls.push("markSucceeded");
      return scenario.markSucceeded ? scenario.markSucceeded() : true;
    },
    async markFailed(_jobId: string, code: string, message: string) {
      calls.push("markFailed");
      failures.push({ code, message });
      return scenario.markFailed ? scenario.markFailed() : true;
    },
  } as unknown as JobService;

  const pgmq = {
    async archive() {
      calls.push("archive");
    },
    async deleteMsg() {
      calls.push("deleteMsg");
    },
  };

  const executor: JobExecutor = async () => {
    calls.push("executor");
    if (scenario.executorThrows) throw Object.assign(new Error(scenario.executorThrows.message), {
      ...(scenario.executorThrows.code ? { code: scenario.executorThrows.code } : {}),
    });
    return scenario.executorReturns ?? { ok: true };
  };

  const logs: string[] = [];

  const deps = {
    jobService,
    pgmq: pgmq as never,
    getExecutor: () =>
      scenario.hasExecutor === false ? undefined : executor,
    refundJob: async () => {
      calls.push("refundJob");
      refunds += 1;
      if (scenario.refundThrows) throw new Error("refund endpoint down");
    },
    log: (message: string) => {
      logs.push(message);
    },
  };

  const args = {
    queue: "image_generation",
    queueJobType: "image_generation" as const,
    msg: { msg_id: 7, message: { job_id: "job-1", job_type: "image_generation" } } as never,
    ctx: {} as ExecutorContext,
  };

  return {
    deps,
    args,
    calls,
    failures,
    retries,
    logs,
    refunds: () => refunds,
    run: () => processJobMessage(deps, args),
  };
}

describe("processJobMessage", () => {
  it("case 1: a success runs the executor and deletes the message", async () => {
    const h = makeHarness();

    await h.run();

    expect(h.calls).toEqual([
      "incrementAttempt",
      "markRunning",
      "executor",
      "markSucceeded",
      "deleteMsg",
    ]);
    expect(h.refunds()).toBe(0);
    expect(h.calls).not.toContain("archive");
  });

  it("case 2: a retryable failure on attempt 1 of 3 writes retrying, never failed", async () => {
    const h = makeHarness({
      increment: async () => ({ attempt_count: 1, max_attempts: 3 }),
      executorThrows: { message: "provider hiccup" },
    });

    await h.run();

    expect(h.calls).toContain("markRetrying");
    expect(h.calls).not.toContain("markFailed");
    expect(h.calls).not.toContain("archive");
    expect(h.refunds()).toBe(0);
  });

  it("case 3: exhausting the attempts fails terminally, refunds once and archives", async () => {
    const h = makeHarness({
      increment: async () => ({ attempt_count: 3, max_attempts: 3 }),
      executorThrows: { message: "still broken" },
    });

    await h.run();

    expect(h.calls).toContain("markFailed");
    expect(h.calls).not.toContain("markRetrying");
    expect(h.refunds()).toBe(1);
    expect(h.calls).toContain("archive");
  });

  it("case 4: a non-retryable code fails terminally on the first attempt", async () => {
    const h = makeHarness({
      increment: async () => ({ attempt_count: 1, max_attempts: 3 }),
      executorThrows: { code: "safety_filter", message: "blocked" },
    });

    await h.run();

    expect(h.calls).not.toContain("markRetrying");
    expect(h.failures).toEqual([{ code: "safety_filter", message: "blocked" }]);
    expect(h.refunds()).toBe(1);
    expect(h.calls).toContain("archive");
  });

  it("case 5: a failed attempt count leaves the message completely untouched", async () => {
    const h = makeHarness({
      increment: async () => {
        throw new Error("rpc down");
      },
    });

    await h.run();

    expect(h.calls).not.toContain("executor");
    expect(h.calls).not.toContain("markRunning");
    expect(h.calls).not.toContain("markFailed");
    expect(h.calls).not.toContain("markRetrying");
    expect(h.calls).not.toContain("archive");
    expect(h.calls).not.toContain("deleteMsg");
    expect(h.refunds()).toBe(0);
    expect(h.logs.join(" ")).toContain("incrementAttempt failed");
  });

  it("case 6: a missing job row archives the message", async () => {
    const h = makeHarness({ increment: async () => null });

    await h.run();

    expect(h.calls).toContain("archive");
    expect(h.calls).not.toContain("executor");
    expect(h.refunds()).toBe(0);
  });

  it("case 7: an already-spent budget fails without executing", async () => {
    const h = makeHarness({ increment: async () => ({ attempt_count: 4, max_attempts: 3 }) });

    await h.run();

    expect(h.calls).not.toContain("executor");
    expect(h.failures).toEqual([
      { code: "max_attempts_exceeded", message: expect.stringContaining("4/3") },
    ]);
    expect(h.refunds()).toBe(1);
    expect(h.calls).toContain("archive");
  });

  it("case 8: a job that can no longer start is archived without executing or refunding", async () => {
    const h = makeHarness({ markRunning: async () => false });

    await h.run();

    expect(h.calls).not.toContain("executor");
    expect(h.calls).toContain("archive");
    expect(h.refunds()).toBe(0);
    expect(h.calls).not.toContain("markFailed");
  });

  it("case 9: being cancelled while running only drops the message", async () => {
    const h = makeHarness({ markSucceeded: async () => false });

    await h.run();

    expect(h.calls).toContain("deleteMsg");
    expect(h.calls).not.toContain("markFailed");
    expect(h.refunds()).toBe(0);
  });

  it("case 10: a terminal failure that did not change a row does not refund", async () => {
    const h = makeHarness({
      increment: async () => ({ attempt_count: 3, max_attempts: 3 }),
      executorThrows: { message: "broken" },
      markFailed: async () => false,
    });

    await h.run();

    expect(h.calls).toContain("markFailed");
    expect(h.refunds()).toBe(0);
    expect(h.calls).toContain("archive");
  });

  it("case 11: no executor registered is a terminal failure", async () => {
    const h = makeHarness({ hasExecutor: false });

    await h.run();

    expect(h.failures).toEqual([
      { code: "no_executor", message: expect.stringContaining("image_generation") },
    ]);
    expect(h.refunds()).toBe(1);
    expect(h.calls).toContain("archive");
  });

  it("case 12: a throwing refund does not stop the archive", async () => {
    const h = makeHarness({
      increment: async () => ({ attempt_count: 3, max_attempts: 3 }),
      executorThrows: { message: "broken" },
      refundThrows: true,
    });

    await expect(h.run()).resolves.toBeUndefined();

    expect(h.calls).toContain("refundJob");
    expect(h.calls).toContain("archive");
    expect(h.logs.join(" ")).toContain("Refund failed");
  });
});
