import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { executorTimeoutMs } from "../features/jobs/process-job-message.js";
import { AGENT_WAIT_MARGIN_MS, agentWaitBudgetMs } from "./job-wait-budget.js";

/**
 * GN-31: the agent must never stop waiting for a job before the worker's own
 * execution budget has run out, or it shows a failure for work the worker is
 * still going to finish and charge for.
 */
const RUNTIME_SOURCE = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");

describe("agentWaitBudgetMs", () => {
  it("GN-31: the agent waits at least as long as an image job may run", () => {
    expect(agentWaitBudgetMs("image_generation", 3)).toBeGreaterThanOrEqual(
      executorTimeoutMs("image_generation", 3),
    );
    expect(agentWaitBudgetMs("image_generation", 3)).toBe(
      executorTimeoutMs("image_generation", 3) + AGENT_WAIT_MARGIN_MS,
    );
    expect(agentWaitBudgetMs("image_generation", 3)).toBe(420_000);
  });

  it("GN-31: same for video", () => {
    expect(agentWaitBudgetMs("video_generation", 3)).toBe(960_000);
  });

  it("GN-31: a single attempt still gets the margin", () => {
    expect(agentWaitBudgetMs("image_generation", 1)).toBe(180_000);
  });

  it("GN-39: the agent no longer keeps its own poll interval or wait", () => {
    expect(RUNTIME_SOURCE).not.toContain("240_000");
    expect(RUNTIME_SOURCE).not.toContain("600_000");
    expect(RUNTIME_SOURCE).not.toContain("const POLL_INTERVAL = 2000");
    expect(RUNTIME_SOURCE).not.toContain("const POLL_INTERVAL = 3000");
  });
});
