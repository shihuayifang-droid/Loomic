import { describe, expect, it } from "vitest";

import type { ChatReadRepository } from "../../db/chat-read-repository.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
import { createThreadService, ThreadServiceError } from "./thread-service.js";

/**
 * ADR-0001 / 工单20D: `resolveOwnedSessionThread` no longer reads
 * `chat_sessions` through PostgREST. The binding comes from the chat read
 * repository, whose SQL re-walks `session → canvas → project → members`, so the
 * caller has to pass the REAL actor and session ids and classify three
 * different answers apart:
 *
 *   * no readable session      → 404 (indistinguishable from "does not exist");
 *   * readable, no thread_id   → 409 (legacy session, not resumable);
 *   * the repository failed    → 500 `application_error`, fixed text, never a
 *     404 that would hide an outage behind "not found".
 */

const USER = { accessToken: "token", id: "user-1" } as AuthenticatedUser;
const SESSION_ID = "session-1";

type Call = { actorId: string; sessionId: string };

function serviceWith(script: {
  row?: { id: string; threadId: string | null } | null;
  error?: unknown;
}): { service: ReturnType<typeof createThreadService>; calls: Call[] } {
  const calls: Call[] = [];

  const repository: ChatReadRepository = {
    async listReadableSessions() {
      throw new Error("not used");
    },
    async listReadableMessages() {
      throw new Error("not used");
    },
    async listReadableSessionAssets() {
      throw new Error("not used");
    },
    async findReadableSessionThread(input) {
      calls.push({ ...input });
      if (script.error) throw script.error;
      return script.row ?? null;
    },
  };

  return {
    service: createThreadService({ chatReadRepository: repository }),
    calls,
  };
}

describe("thread-service: createThreadId", () => {
  it("case 1: mints a distinct server-owned id through the factory, unchanged", () => {
    const withFactory = createThreadService({
      chatReadRepository: {} as ChatReadRepository,
      threadIdFactory: () => "thread_fixed",
    });
    expect(withFactory.createThreadId()).toBe("thread_fixed");

    const withDefault = createThreadService({
      chatReadRepository: {} as ChatReadRepository,
    });
    const first = withDefault.createThreadId();
    const second = withDefault.createThreadId();

    expect(first).toMatch(/^thread_/);
    expect(first).not.toBe(second);
  });
});

describe("thread-service: resolveOwnedSessionThread through the repository", () => {
  it("case 2: passes the REAL actor and session ids and returns the binding", async () => {
    const { service, calls } = serviceWith({
      row: { id: SESSION_ID, threadId: "thread_active" },
    });

    await expect(service.resolveOwnedSessionThread(USER, SESSION_ID)).resolves.toEqual({
      sessionId: SESSION_ID,
      threadId: "thread_active",
    });
    expect(calls).toEqual([{ actorId: "user-1", sessionId: SESSION_ID }]);
  });

  it("case 3: an unreadable or missing session is the existing 404", async () => {
    const { service } = serviceWith({ row: null });

    const error = await service
      .resolveOwnedSessionThread(USER, SESSION_ID)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ThreadServiceError);
    expect((error as ThreadServiceError).code).toBe("session_not_found");
    expect((error as ThreadServiceError).statusCode).toBe(404);
    expect((error as ThreadServiceError).message).toBe("Session not found.");
  });

  it("case 4: a readable session with no thread binding is the existing 409", async () => {
    const { service } = serviceWith({ row: { id: SESSION_ID, threadId: null } });

    const error = await service
      .resolveOwnedSessionThread(USER, SESSION_ID)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ThreadServiceError);
    expect((error as ThreadServiceError).code).toBe("session_not_found");
    expect((error as ThreadServiceError).statusCode).toBe(409);
    expect((error as ThreadServiceError).message).toBe(
      "Session is not resumable because no thread is bound yet.",
    );
  });

  it("case 5: a repository failure is a 500 application_error, never a fake 404", async () => {
    const { service } = serviceWith({
      error: new Error("connect ECONNREFUSED postgres://user:secret@10.210.134.37:5432/db"),
    });

    const error = await service
      .resolveOwnedSessionThread(USER, SESSION_ID)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ThreadServiceError);
    expect((error as ThreadServiceError).code).toBe("application_error");
    expect((error as ThreadServiceError).statusCode).toBe(500);
    // Fixed text: no SQL, no host, no connection string, no credential.
    expect((error as ThreadServiceError).message).toBe(
      "Unable to resolve the session thread.",
    );
    expect((error as ThreadServiceError).message).not.toMatch(
      /ECONNREFUSED|postgres:\/\/|10\.210\.134\.37|secret|select/i,
    );
  });

  it("case 6: every call carries the caller's own id, never a shared or empty one", async () => {
    const { service, calls } = serviceWith({
      row: { id: SESSION_ID, threadId: "thread_active" },
    });

    await service.resolveOwnedSessionThread(USER, SESSION_ID);
    await service.resolveOwnedSessionThread(
      { accessToken: "other", id: "user-2" } as AuthenticatedUser,
      "session-2",
    );

    expect(calls).toEqual([
      { actorId: "user-1", sessionId: SESSION_ID },
      { actorId: "user-2", sessionId: "session-2" },
    ]);
  });
});
