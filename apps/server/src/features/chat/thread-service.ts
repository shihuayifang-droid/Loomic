import { randomUUID } from "node:crypto";

import type { ChatReadRepository } from "../../db/chat-read-repository.js";
import type { AuthenticatedUser } from "../../supabase/user.js";

export class ThreadServiceError extends Error {
  readonly statusCode: number;
  /**
   * `session_not_found` for the two existing refusals (404 missing, 409 not
   * resumable). `application_error` is the infrastructure failure (workorder
   * 20D): a read that could not be answered must stop pretending the session is
   * absent, so `POST /api/agent/runs` answers 500 with a fixed, information-free
   * body instead of a 404 that would tell the caller nothing about the outage.
   */
  readonly code: "session_not_found" | "application_error";

  constructor(
    code: "session_not_found" | "application_error",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type SessionThreadBinding = {
  sessionId: string;
  threadId: string;
};

export type ThreadService = {
  createThreadId(): string;
  resolveOwnedSessionThread(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<SessionThreadBinding>;
};

export function createThreadService(options: {
  chatReadRepository: ChatReadRepository;
  threadIdFactory?: () => string;
}): ThreadService {
  const threadIdFactory =
    options.threadIdFactory ?? (() => `thread_${randomUUID()}`);

  return {
    createThreadId() {
      return threadIdFactory();
    },

    async resolveOwnedSessionThread(user, sessionId) {
      // ADR-0001 / workorder 20D: the binding is read through the pure `pg`
      // repository, which re-walks `session → canvas → project → members` inside
      // the statement. A session the caller may not read is indistinguishable
      // from one that does not exist — both are 404, on purpose.
      let row: { id: string; threadId: string | null } | null;
      try {
        row = await options.chatReadRepository.findReadableSessionThread({
          actorId: user.id,
          sessionId,
        });
      } catch {
        // Fixed text, no driver detail: the underlying failure is logged by the
        // repository's own error, and a response body must not carry SQL, a host
        // or a connection string.
        throw new ThreadServiceError(
          "application_error",
          "Unable to resolve the session thread.",
          500,
        );
      }

      if (row === null) {
        throw new ThreadServiceError("session_not_found", "Session not found.", 404);
      }

      if (!row.threadId) {
        throw new ThreadServiceError(
          "session_not_found",
          "Session is not resumable because no thread is bound yet.",
          409,
        );
      }

      return {
        sessionId: row.id,
        threadId: row.threadId,
      };
    },
  };
}
