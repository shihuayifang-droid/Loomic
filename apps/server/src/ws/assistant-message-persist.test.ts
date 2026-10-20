// AG-35 §4: the server side of "a reply that could not be stored must not vanish
// silently". The success path returns true and pushes nothing; the failure path
// warns, pushes `message.persist_failed` so the client can keep the reply it
// rendered, and never throws to the caller.
import { streamEventSchema, type ContentBlock, type StreamEvent } from "@loomic/shared";
import { describe, expect, it, vi } from "vitest";

import type { ChatService } from "../features/chat/chat-service.js";
import type { AuthenticatedUser } from "../supabase/user.js";
import { persistAssistantMessage } from "./assistant-message-persist.js";

const USER = { id: "user-1" } as unknown as AuthenticatedUser;
const SESSION_ID = "s-1";
const RUN_ID = "run-1";

function harness(text = "hi", blocks: ContentBlock[] = []) {
  const createMessage = vi.fn();
  const push = vi.fn<(event: StreamEvent) => void>();
  const warn = vi.fn<(label: string, data: Record<string, unknown>) => void>();
  const args = {
    chatService: { createMessage } as unknown as Pick<ChatService, "createMessage">,
    user: USER,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    text,
    blocks,
    push,
    warn,
  };
  return { args, createMessage, push, warn };
}

describe("persistAssistantMessage", () => {
  it("AG-35: a stored reply returns true and pushes nothing", async () => {
    const { args, createMessage, push } = harness();
    createMessage.mockResolvedValue({ id: "message-1" });

    await expect(persistAssistantMessage(args)).resolves.toBe(true);

    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage.mock.calls[0]?.[0]).toBe(USER);
    expect(createMessage.mock.calls[0]?.[1]).toBe(SESSION_ID);
    expect(createMessage.mock.calls[0]?.[2]).toEqual({
      role: "assistant",
      content: "hi",
      contentBlocks: [],
    });
    expect(push).toHaveBeenCalledTimes(0);
  });

  it("AG-35: a reply that cannot be stored pushes message.persist_failed", async () => {
    const { args, createMessage, push, warn } = harness();
    createMessage.mockRejectedValue(new Error("fetch failed"));

    const result = await persistAssistantMessage({
      ...args,
      now: () => "2026-10-20T00:00:00.000Z",
    });

    expect(result).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toEqual({
      type: "message.persist_failed",
      runId: RUN_ID,
      sessionId: SESSION_ID,
      timestamp: "2026-10-20T00:00:00.000Z",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("assistant_message_persist_failed");
  });

  it("AG-35: the pushed event parses with the shared stream schema", async () => {
    const { args, createMessage, push } = harness();
    createMessage.mockRejectedValue(new Error("fetch failed"));

    await persistAssistantMessage({
      ...args,
      now: () => "2026-10-20T00:00:00.000Z",
    });

    const event = push.mock.calls[0]?.[0] as StreamEvent;
    const parsed = streamEventSchema.parse(event);
    expect(parsed.type).toBe("message.persist_failed");
  });

  it("AG-35: the failure never throws to the caller", async () => {
    const { args, createMessage } = harness();
    createMessage.mockRejectedValue(new Error("fetch failed"));

    await expect(persistAssistantMessage(args)).resolves.toBe(false);
  });
});
