// Proves the transport retry is actually WIRED INTO this service, not merely
// available to it — and that it now retries the RIGHT error after workorder 21G
// moved both writes onto the pure `pg` repository.
//
// `transport-retry.test.ts` proves the helper retries. That says nothing about
// whether these two methods call through it — a forgotten `await`, or wrapping only
// one of the two writes, would leave the original bug in place while every other
// test stayed green.
//
// The bug being defended against (observed 2026-09-15): a proxy blip on `updateRun`
// marked the run failed and the UI told the user "请求处理失败，请重试" — while the
// image that run produced was already on the canvas.
//
// 21G adds a second way to lose that protection silently: the repository reports
// every failure as `AgentRunWriteError`, whose own message carries no transport
// wording and no `code`. A service that handed THAT error to the retry predicate
// would stop retrying real transport failures while still passing every
// "it retries" test written against a bare driver error. The cases below therefore
// drive the repository-shaped error, cause included, and pin both edges: the two
// transport shapes that must be replayed, and the real database answers that must
// not be.
import { describe, expect, it, vi } from "vitest";

import {
  CREATE_ACCEPTED_RUN,
  AgentRunWriteError,
  UPDATE_RUN,
  type AgentRunWriteOperation,
  type AgentRunWriteRepository,
} from "../../db/agent-run-write-repository.js";
import {
  AgentRunPersistenceError,
  createAgentRunMetadataService,
} from "./agent-run-service.js";

/**
 * Two transport shapes, because the `pg` driver produces both and only one of
 * them carries a code:
 *
 * - a socket error underneath the pool, which has a Node network code;
 * - node-postgres' own disconnect, whose message is `Connection terminated
 *   unexpectedly` and which carries NO code at all.
 *
 * A predicate that consulted only `code` would replay the first and drop the
 * second, which is the regression workorder 20E already fixed once for the read
 * repositories.
 */
const SOCKET_TRANSPORT = Object.assign(new Error("read ECONNRESET"), {
  code: "ECONNRESET",
});
const DRIVER_TRANSPORT = new Error("Connection terminated unexpectedly");

/** Real answers from PostgreSQL: a decision, not a lost request. */
const PG_DENIED = Object.assign(
  new Error("new row violates row-level security policy"),
  { code: "42501" },
);
const DUPLICATE_KEY = Object.assign(
  new Error('duplicate key value violates unique constraint "agent_runs_pkey"'),
  { code: "23505" },
);

type FakeRepository = {
  repository: AgentRunWriteRepository;
  calls: Array<{ operation: AgentRunWriteOperation; input: unknown }>;
  count: () => number;
};

/**
 * One queued outcome: a `cause` the call fails with (wrapped the way the real
 * repository wraps it), or nothing at all for a call that succeeds. The LAST
 * outcome repeats, so a one-entry list of failures models a database that keeps
 * refusing.
 */
type Outcome = { cause?: unknown };

/**
 * A repository double that answers each queued outcome in turn. `count()` is the
 * number of real attempts, which is how a missing retry shows up.
 */
function fakeRepository(outcomes: readonly Outcome[] = []): FakeRepository {
  const calls: Array<{ operation: AgentRunWriteOperation; input: unknown }> = [];

  const settle = (operation: AgentRunWriteOperation) => {
    if (outcomes.length === 0) return;

    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (outcome?.cause !== undefined) {
      throw new AgentRunWriteError(operation, outcome.cause);
    }
  };

  const repository: AgentRunWriteRepository = {
    async createAcceptedRun(input) {
      calls.push({ operation: CREATE_ACCEPTED_RUN, input });
      settle(CREATE_ACCEPTED_RUN);
    },
    async updateRun(input) {
      calls.push({ operation: UPDATE_RUN, input });
      settle(UPDATE_RUN);
    },
  };

  return { repository, calls, count: () => calls.length };
}

function serviceFor(fake: FakeRepository) {
  return createAgentRunMetadataService({
    agentRunWriteRepository: fake.repository,
  });
}

const RUN = {
  runId: "r1",
  model: "deepseek:deepseek-chat",
  sessionId: "s1",
  threadId: "th1",
};
const UPDATE = { runId: "r1", status: "failed" } as const;

describe("updateRun", () => {
  it("★ survives a transport blip — this is the bug that marked good runs failed", async () => {
    vi.useFakeTimers();
    const f = fakeRepository([{ cause: SOCKET_TRANSPORT }, {}]);
    const promise = serviceFor(f).updateRun(UPDATE);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(f.count()).toBe(2);
    vi.useRealTimers();
  });

  it("★ survives the driver's own disconnect, which carries no code at all", async () => {
    vi.useFakeTimers();
    const f = fakeRepository([{ cause: DRIVER_TRANSPORT }, {}]);
    const promise = serviceFor(f).updateRun(UPDATE);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    // The cause has to be unwrapped out of `AgentRunWriteError` for this to be
    // recognised: the wrapper's own message says nothing about a transport.
    expect(f.count()).toBe(2);
    vi.useRealTimers();
  });

  it("still fails, as AgentRunPersistenceError, once retries are exhausted", async () => {
    vi.useFakeTimers();
    const f = fakeRepository([{ cause: SOCKET_TRANSPORT }]);
    const promise = serviceFor(f).updateRun(UPDATE);
    const settled = expect(promise).rejects.toBeInstanceOf(AgentRunPersistenceError);
    await vi.runAllTimersAsync();
    await settled;
    expect(f.count()).toBe(3);
    vi.useRealTimers();
  });

  it("does NOT retry a real database answer", async () => {
    const f = fakeRepository([{ cause: PG_DENIED }]);
    await expect(serviceFor(f).updateRun(UPDATE)).rejects.toBeInstanceOf(
      AgentRunPersistenceError,
    );
    expect(f.count()).toBe(1);
  });

  it("passes the caller's input straight through, so the patch is built in one place", async () => {
    const f = fakeRepository();

    await serviceFor(f).updateRun({
      runId: "r9",
      status: "completed",
      completedAt: "2026-10-14T00:00:00.000Z",
      errorCode: "run_failed",
      errorMessage: "boom",
    });

    expect(f.calls).toEqual([
      {
        operation: UPDATE_RUN,
        input: {
          runId: "r9",
          status: "completed",
          completedAt: "2026-10-14T00:00:00.000Z",
          errorCode: "run_failed",
          errorMessage: "boom",
        },
      },
    ]);
  });

  it("keeps the driver's reason in the log and the fixed message on the error", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const f = fakeRepository([{ cause: PG_DENIED }]);

    const error = await serviceFor(f).updateRun(UPDATE).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentRunPersistenceError);
    const persistenceError = error as AgentRunPersistenceError;
    // The thrown text is fixed and reaches the client, so it must carry neither
    // the driver's message nor the row it was talking about.
    expect(persistenceError.message).toBe("Failed to update run metadata.");
    expect(persistenceError.statusCode).toBe(500);

    const line = logged.mock.calls.map((call) => String(call[0])).join("\n");
    expect(line).toContain("[agent-run-service] updateRun failed runId=r1");
    expect(line).toContain("status=failed");
    // The reason the old log line printed: the driver's own code and message, now
    // read from `cause`.
    expect(line).toContain("code=42501");
    expect(line).toContain("message=new row violates row-level security policy");

    logged.mockRestore();
  });
});

describe("createAcceptedRun", () => {
  // Safe to replay for a stronger reason than the predicate: the id is supplied by
  // the caller, so a replay after a lost response hits the primary key rather than
  // creating a second run. The repository keeps that true — its insert has no
  // conflict clause — which is why a duplicate key is a REAL error here and not
  // something to retry.
  it("survives a transport blip", async () => {
    vi.useFakeTimers();
    const f = fakeRepository([{ cause: SOCKET_TRANSPORT }, {}]);
    const promise = serviceFor(f).createAcceptedRun(RUN);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(f.count()).toBe(2);
    vi.useRealTimers();
  });

  it("does NOT retry a real database answer", async () => {
    const f = fakeRepository([{ cause: PG_DENIED }]);
    await expect(serviceFor(f).createAcceptedRun(RUN)).rejects.toBeInstanceOf(
      AgentRunPersistenceError,
    );
    expect(f.count()).toBe(1);
  });

  it("does NOT retry a duplicate key — the primary key is the replay guard", async () => {
    const f = fakeRepository([{ cause: DUPLICATE_KEY }]);

    const error = await serviceFor(f).createAcceptedRun(RUN).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(AgentRunPersistenceError);
    expect((error as AgentRunPersistenceError).message).toBe(
      "Failed to persist accepted run.",
    );
    // One attempt: a duplicate is an answer, and a replayed answer would be the
    // same one.
    expect(f.count()).toBe(1);
    expect(f.calls[0]?.operation).toBe(CREATE_ACCEPTED_RUN);
  });

  it("hands the repository the run the caller described, unchanged", async () => {
    const f = fakeRepository();

    await serviceFor(f).createAcceptedRun(RUN);

    expect(f.calls).toEqual([{ operation: CREATE_ACCEPTED_RUN, input: RUN }]);
  });
});

describe("wiring", () => {
  it("fails closed with no repository, and never falls back to PostgREST", async () => {
    // There is no admin client in this service any more — not an unused one, not
    // an optional one. The only way either write is issued is the repository, so a
    // missing repository is a persistence failure on the call rather than a
    // second, older path that quietly still works.
    const service = createAgentRunMetadataService({});

    vi.useFakeTimers();
    const accepted = service.createAcceptedRun(RUN);
    const acceptedSettled = expect(accepted).rejects.toBeInstanceOf(
      AgentRunPersistenceError,
    );
    await vi.runAllTimersAsync();
    await acceptedSettled;

    const updated = service.updateRun(UPDATE);
    const updatedSettled = expect(updated).rejects.toBeInstanceOf(
      AgentRunPersistenceError,
    );
    await vi.runAllTimersAsync();
    await updatedSettled;
    vi.useRealTimers();

    expect(Object.keys(service).sort()).toEqual([
      "createAcceptedRun",
      "updateRun",
    ]);
  });
});
