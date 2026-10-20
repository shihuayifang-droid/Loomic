// GN-19: the slot a video job leaves behind is decided by the same rules as the
// image one — failed / timed out keeps a failed slot, canceled / aborted drops
// it. Pinned here so the decision cannot drift from the writing code.
import { describe, expect, it } from "vitest";

import { slotOutcomeForStop } from "./generation-slot-outcome.js";

describe("GN-19 generation slot outcome", () => {
  it("GN-19: a failed job leaves a failed slot with a sanitized reason", () => {
    const outcome = slotOutcomeForStop({
      reason: "job_failed",
      jobId: "job-1",
      errorMessage: "replicate 500 internal",
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected a failed slot");
    expect(outcome.jobId).toBe("job-1");
    expect(outcome.message).not.toContain("replicate");
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  it("GN-19: a failed job without a message still gets a reason", () => {
    const outcome = slotOutcomeForStop({
      reason: "job_failed",
      jobId: "job-2",
      errorMessage: null,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected a failed slot");
    expect(outcome.jobId).toBe("job-2");
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  it("GN-19: a timeout leaves a failed slot saying 生成超时，请重试", () => {
    const outcome = slotOutcomeForStop({ reason: "timeout", jobId: "job-3" });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected a failed slot");
    expect(outcome.jobId).toBe("job-3");
    expect(outcome.message).toBe("生成超时，请重试");
  });

  it("GN-19: a canceled job drops the slot", () => {
    const outcome = slotOutcomeForStop({
      reason: "job_canceled",
      jobId: "job-4",
    });

    expect(outcome.kind).toBe("dropped");
  });

  it("GN-19: an aborted run drops the slot", () => {
    const outcome = slotOutcomeForStop({ reason: "aborted" });

    expect(outcome.kind).toBe("dropped");
  });
});
