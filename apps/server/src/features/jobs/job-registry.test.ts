import { describe, expect, it } from "vitest";

import {
  JOB_QUEUES,
  JOB_TYPE_REGISTRY,
  jobTypeForQueue,
  queueForJobType,
} from "./job-registry.js";

/**
 * The queue topology of `tool_execution`, the one job type every server-side
 * tool runs as (the payload's `tool_id` says which tool).
 *
 * The registry is the only place a job type's queue, visibility timeout and
 * concurrency are declared; `satisfies Record<BackgroundJobType, JobTypeConfig>`
 * already turns a missing entry into a compile error, but nothing at run time
 * says the entry points at the RIGHT queue. A typo in `queue` would enqueue onto
 * a queue the worker never polls, so the queue name is pinned here as a literal
 * (E-018) rather than derived from the registry under test.
 */
describe("job registry: tool_execution", () => {
  it("queueForJobType maps tool_execution to its own queue", () => {
    expect(queueForJobType("tool_execution")).toBe("tool_execution_jobs");
  });

  it("jobTypeForQueue maps the queue back to tool_execution", () => {
    expect(jobTypeForQueue("tool_execution_jobs")).toBe("tool_execution");
  });

  it("JOB_QUEUES is the sorted set of all three queues", () => {
    // Sorted, so the assertion does not depend on object key order.
    expect([...JOB_QUEUES].sort()).toEqual([
      "image_generation_jobs",
      "tool_execution_jobs",
      "video_generation_jobs",
    ]);
  });

  it("tool_execution keeps a 180s visibility timeout", () => {
    // 10-120s image edits; executors renew VT while working, so a shorter
    // timeout would let the message reappear and the work run twice.
    expect(JOB_TYPE_REGISTRY.tool_execution.visibilityTimeoutSeconds).toBe(180);
  });

  it("tool_execution shares the image concurrency cap", () => {
    expect(JOB_TYPE_REGISTRY.tool_execution.concurrency({} as never)).toBe(3);
    expect(
      JOB_TYPE_REGISTRY.tool_execution.concurrency({
        workerImageConcurrency: 7,
      } as never),
    ).toBe(7);
  });
});
