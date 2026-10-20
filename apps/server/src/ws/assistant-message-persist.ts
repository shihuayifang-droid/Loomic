import type { ContentBlock, StreamEvent } from "@loomic/shared";

import type { ChatService } from "../features/chat/chat-service.js";
import type { AuthenticatedUser } from "../supabase/user.js";

/**
 * AG-35 §4: store the assistant reply of a finished run, and tell the client when
 * that final write does not land.
 *
 * WHY THIS IS A SEPARATE FUNCTION
 * The persistence used to sit inline in the WS handler and logged the failure and
 * nothing else, so the browser kept a reply it would lose on the next reload with
 * no way to know. The handler has no tests; this has no dependency on a socket, a
 * connection manager or the event loop, so the failure path can be pinned.
 *
 * The write is not retried here: `chatService.createMessage` already retries
 * transport failures itself, so reaching the catch means the server really could
 * not store the run's reply.
 */
export async function persistAssistantMessage(args: {
  chatService: Pick<ChatService, "createMessage">;
  user: AuthenticatedUser;
  sessionId: string;
  runId: string;
  text: string;
  blocks: ContentBlock[];
  push: (event: StreamEvent) => void;
  warn: (label: string, data: Record<string, unknown>) => void;
  now?: () => string;
}): Promise<boolean> {
  const { chatService, user, sessionId, runId, text, blocks, push, warn, now } = args;

  try {
    await chatService.createMessage(user, sessionId, {
      role: "assistant",
      content: text,
      contentBlocks: blocks,
    });
    return true;
  } catch (err) {
    warn("assistant_message_persist_failed", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    push({
      type: "message.persist_failed",
      runId,
      sessionId,
      timestamp: (now ?? (() => new Date().toISOString()))(),
    });
    return false;
  }
}
