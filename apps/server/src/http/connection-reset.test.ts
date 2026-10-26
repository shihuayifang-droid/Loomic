// QA-11 故障注入（后端第三条）：连接被重置。
//
// What these pin: an `ECONNRESET` (or an `AbortError`, or a socket torn down
// mid-flight) is a RETRYABLE failure with its own status — 502 — so the client
// can tell it apart from a 429 "slow down". It must never be recorded as a
// success, and it must not be confused with our own database being refused
// (that one is 503 `database_unavailable`).
import { describe, expect, it } from "vitest";

import {
  DATABASE_UNAVAILABLE_CODE,
  UPSTREAM_CONNECTION_RESET_CODE,
  UPSTREAM_RATE_LIMITED_CODE,
  classifyInfrastructureFault,
  infrastructureFaultResponse,
} from "../generation/upstream-error.js";

/** The way `undici` / `pg` report a connection torn down under us. */
function connectionReset(): Error {
  return Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
}

/** A repository double at the boundary that would record a success. */
function recordingRepository() {
  const writes: string[] = [];

  return {
    writes,
    recordSuccess(jobId: string): void {
      writes.push(`success:${jobId}`);
    },
  };
}

describe("连接被重置 (QA-11)", () => {
  it("QA-11: ECONNRESET is classified as a retryable connection reset", () => {
    const error = connectionReset();

    expect(classifyInfrastructureFault(error, "upstream")).toBe("upstream_connection_reset");

    const mapped = infrastructureFaultResponse(error, "upstream");
    expect(mapped.statusCode).toBe(502);
    expect(mapped.code).toBe(UPSTREAM_CONNECTION_RESET_CODE);
    expect(mapped.retryable).toBe(true);
  });

  it("QA-11: the reset status is distinguishable from 429", () => {
    const reset = infrastructureFaultResponse(connectionReset(), "upstream");
    const rateLimited = infrastructureFaultResponse(
      Object.assign(new Error("upstream responded 429"), { status: 429 }),
      "upstream",
    );

    expect(reset.statusCode).toBe(502);
    expect(rateLimited.statusCode).toBe(429);
    expect(reset.statusCode).not.toBe(rateLimited.statusCode);
    expect(reset.code).not.toBe(rateLimited.code);
    expect(reset.code).not.toBe(UPSTREAM_RATE_LIMITED_CODE);
  });

  it("QA-11: a message-only reset and an AbortError are both retryable resets", () => {
    const messageOnly = new Error("socket hang up");
    const aborted = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });

    expect(classifyInfrastructureFault(messageOnly, "upstream")).toBe(
      "upstream_connection_reset",
    );
    expect(classifyInfrastructureFault(aborted, "upstream")).toBe(
      "upstream_connection_reset",
    );
    expect(infrastructureFaultResponse(messageOnly, "upstream").statusCode).toBe(502);
    expect(infrastructureFaultResponse(aborted, "upstream").statusCode).toBe(502);
  });

  it("QA-11: a reset is NOT our database being unreachable (different context, different code)", () => {
    const error = connectionReset();

    expect(classifyInfrastructureFault(error, "database")).toBe("unknown");
    expect(infrastructureFaultResponse(error, "database").code).not.toBe(
      UPSTREAM_CONNECTION_RESET_CODE,
    );
    expect(UPSTREAM_CONNECTION_RESET_CODE).not.toBe(DATABASE_UNAVAILABLE_CODE);
  });

  it("QA-11: a reset writes no success record", () => {
    const repository = recordingRepository();
    const mapped = infrastructureFaultResponse(connectionReset(), "upstream");

    if (mapped.statusCode === 200) {
      repository.recordSuccess("job-1");
    }

    expect(mapped.retryable).toBe(true);
    expect(repository.writes).toEqual([]);
  });
});
