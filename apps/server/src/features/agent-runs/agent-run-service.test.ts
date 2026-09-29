// Proves the transport retry is actually WIRED INTO this service, not merely
// available to it.
//
// `transport-retry.test.ts` proves the helper retries. That says nothing about
// whether these two methods call through it — a forgotten `await`, or wrapping only
// one of the two writes, would leave the original bug in place while every other
// test stayed green.
//
// The bug being defended against (observed 2026-09-15): a proxy blip on `updateRun`
// marked the run failed and the UI told the user "请求处理失败，请重试" — while the
// image that run produced was already on the canvas.
import { describe, expect, it, vi } from "vitest";

import {
  AgentRunPersistenceError,
  createAgentRunMetadataService,
} from "./agent-run-service.js";

const TRANSPORT = { code: "", message: "TypeError: fetch failed" };
const PG_DENIED = {
  code: "42501",
  message: "new row violates row-level security policy",
};

/**
 * Fake admin client whose `agent_runs` writes return each queued result in turn.
 * `calls` counts real attempts, which is how a missing retry shows up.
 */
function fakeAdmin(results: Array<{ error: unknown }>) {
  let calls = 0;
  const next = () => {
    const r = results[Math.min(calls, results.length - 1)];
    calls++;
    return { error: r?.error ?? null };
  };
  const client = {
    from: () => ({
      insert: async () => next(),
      update: () => ({ eq: async () => next() }),
    }),
  };
  return {
    service: createAgentRunMetadataService({
      getAdminClient: () => client as never,
    }),
    calls: () => calls,
  };
}

const RUN = {
  runId: "r1",
  model: "deepseek:deepseek-chat",
  sessionId: "s1",
  threadId: "th1",
} as never;
const UPDATE = { runId: "r1", status: "succeeded" } as never;

describe("updateRun", () => {
  it("★ survives a transport blip — this is the bug that marked good runs failed", async () => {
    vi.useFakeTimers();
    const f = fakeAdmin([{ error: TRANSPORT }, { error: null }]);
    const promise = f.service.updateRun(UPDATE);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(f.calls()).toBe(2);
    vi.useRealTimers();
  });

  it("still fails, as AgentRunPersistenceError, once retries are exhausted", async () => {
    vi.useFakeTimers();
    const f = fakeAdmin([{ error: TRANSPORT }]);
    const promise = f.service.updateRun(UPDATE);
    const settled = expect(promise).rejects.toBeInstanceOf(AgentRunPersistenceError);
    await vi.runAllTimersAsync();
    await settled;
    expect(f.calls()).toBe(3);
    vi.useRealTimers();
  });

  it("does NOT retry a real database answer", async () => {
    const f = fakeAdmin([{ error: PG_DENIED }]);
    await expect(f.service.updateRun(UPDATE)).rejects.toBeInstanceOf(
      AgentRunPersistenceError,
    );
    expect(f.calls()).toBe(1);
  });
});

describe("createAcceptedRun", () => {
  // Safe to replay for a stronger reason than the predicate: the id is supplied by
  // the caller, so a replay after a lost response hits the primary key rather than
  // creating a second run.
  it("survives a transport blip", async () => {
    vi.useFakeTimers();
    const f = fakeAdmin([{ error: TRANSPORT }, { error: null }]);
    const promise = f.service.createAcceptedRun(RUN);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(f.calls()).toBe(2);
    vi.useRealTimers();
  });

  it("does NOT retry a real database answer", async () => {
    const f = fakeAdmin([{ error: PG_DENIED }]);
    await expect(f.service.createAcceptedRun(RUN)).rejects.toBeInstanceOf(
      AgentRunPersistenceError,
    );
    expect(f.calls()).toBe(1);
  });
});
