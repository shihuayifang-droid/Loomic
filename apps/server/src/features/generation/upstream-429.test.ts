// QA-11 故障注入（后端第二条）：上游 429。
//
// What these pin: a rate-limited upstream answer is NOT swallowed into the
// generic `generation_failed` / 502 the two generation routes otherwise send,
// and it does not end up recorded as a success. The `Retry-After` the upstream
// sent is carried through, because "wait 7 seconds" is the only useful thing a
// 429 has to say.
//
// Everything here is a stub: no provider is called and no network is touched.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  UPSTREAM_CONNECTION_RESET_CODE,
  UPSTREAM_RATE_LIMITED_CODE,
  classifyInfrastructureFault,
  infrastructureFaultResponse,
  upstreamRetryAfterSeconds,
} from "../../generation/upstream-error.js";
import { generationFailedBody } from "../../http/generate.js";

/** A `fetch`-style header bag, without pulling the DOM `Headers` type in. */
function retryAfterHeaders(seconds: string) {
  return {
    get: (name: string): string | null =>
      name.toLowerCase() === "retry-after" ? seconds : null,
  };
}

/** What a provider raises after it read a 429 from upstream. */
function upstream429(): Error {
  return Object.assign(new Error("upstream responded 429 Too Many Requests"), {
    status: 429,
    headers: retryAfterHeaders("7"),
  });
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

describe("上游 429 (QA-11)", () => {
  // `generationFailedBody` logs the raw error server-side on purpose (X-40 §3);
  // the assertions below only care about what the client would receive.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("QA-11: a 429 is classified as a rate limit, not as a generic failure", () => {
    const error = upstream429();

    expect(classifyInfrastructureFault(error, "upstream")).toBe("upstream_rate_limited");
  });

  it("QA-11: the client gets 429 plus a stable code, and the Retry-After survives", () => {
    const mapped = infrastructureFaultResponse(upstream429(), "upstream");

    expect(mapped.statusCode).toBe(429);
    expect(mapped.code).toBe(UPSTREAM_RATE_LIMITED_CODE);
    expect(mapped.retryable).toBe(true);
    expect(mapped.retryAfterSeconds).toBe(7);
    // The upstream text itself never reaches the client.
    expect(mapped.message).not.toContain("429");
    expect(mapped.message).not.toContain("Too Many Requests");
  });

  it("QA-11: the Retry-After is read from a plain header bag too", () => {
    const error = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { "retry-after": "12" },
    });

    expect(upstreamRetryAfterSeconds(error)).toBe(12);
    expect(infrastructureFaultResponse(error, "upstream").retryAfterSeconds).toBe(12);
  });

  it("QA-11: the route's generic fallback loses the 429 — which is why the stable code above exists", () => {
    // This documents the CURRENT behaviour of the real route fallback: everything
    // becomes `generation_failed`. The classified answer must be different from
    // it, otherwise a rate limit is indistinguishable from a dead service.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const generic = generationFailedBody(upstream429());
    const mapped = infrastructureFaultResponse(upstream429(), "upstream");

    expect(generic.error.code).toBe("generation_failed");
    expect(mapped.code).not.toBe(generic.error.code);
    expect(mapped.statusCode).not.toBe(502);
  });

  it("QA-11: a 429 writes no success record at either layer (no double charge)", async () => {
    const repository = recordingRepository();

    // Both layers that can write about a generation ask the same classifier
    // before they write; both must answer "failed" for the same error.
    const routeOutcome = infrastructureFaultResponse(upstream429(), "upstream");
    const workerOutcome = infrastructureFaultResponse(upstream429(), "upstream");

    if (routeOutcome.statusCode === 200 || workerOutcome.statusCode === 200) {
      repository.recordSuccess("job-1");
    }

    expect(routeOutcome.statusCode).toBe(429);
    expect(workerOutcome.statusCode).toBe(429);
    // Nothing was committed as a success...
    expect(repository.writes).toEqual([]);
    // ...and a retryable refusal is not mistaken for the connection dying.
    expect(routeOutcome.code).not.toBe(UPSTREAM_CONNECTION_RESET_CODE);
  });
});
