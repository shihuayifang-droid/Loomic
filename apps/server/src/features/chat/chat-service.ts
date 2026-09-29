import type {
  ChatMessage,
  ChatMessageCreateRequest,
  ChatSessionSummary,
  ContentBlock,
  Json,
} from "@loomic/shared";

import { randomUUID } from "node:crypto";

import { isTransportFailure } from "../../supabase/transport-retry.js";
import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";
import type { ThreadService } from "./thread-service.js";

/**
 * Drop image blocks that carry their bytes inline as a `data:` URL.
 *
 * A chat message row is read back in full every time the conversation loads, so
 * embedding image bytes there scales the cost of *every* history fetch by the size
 * of the largest image ever attached. One 6.5MB base64 block was enough to make
 * listMessages exceed the statement timeout and return 504 for the whole session.
 *
 * Enforced server-side rather than only in the composer: this is the single write
 * path shared by the HTTP route and the WebSocket handler, so a guard here cannot
 * be bypassed by a client that forgets.
 */
function stripInlineImageBytes(
  blocks: ContentBlock[],
  context: { sessionId: string; role: string },
): ContentBlock[] {
  return blocks.filter((block) => {
    if ((block as { type?: string }).type !== "image") return true;
    const url = (block as { url?: string }).url ?? "";
    if (!url.startsWith("data:")) return true;
    console.log(
      "[chat.createMessage] refused to persist inline image bytes",
      JSON.stringify({
        sessionId: context.sessionId,
        role: context.role,
        assetId: (block as { assetId?: string }).assetId,
        bytes: url.length,
      }),
    );
    return false;
  });
}

export class ChatServiceError extends Error {
  readonly statusCode: number;
  readonly code: "chat_error" | "session_not_found";

  constructor(
    code: "chat_error" | "session_not_found",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type ChatService = {
  listSessions(
    user: AuthenticatedUser,
    canvasId: string,
  ): Promise<ChatSessionSummary[]>;
  createSession(
    user: AuthenticatedUser,
    canvasId: string,
    title?: string,
  ): Promise<ChatSessionSummary>;
  updateSessionTitle(
    user: AuthenticatedUser,
    sessionId: string,
    title: string,
  ): Promise<void>;
  deleteSession(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<void>;
  listMessages(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<ChatMessage[]>;
  createMessage(
    user: AuthenticatedUser,
    sessionId: string,
    input: ChatMessageCreateRequest,
  ): Promise<ChatMessage>;
};

/**
 * Synthesize content blocks from legacy `content` + `tool_activities` columns.
 * Produces the same ordering the old client saw: text first, then tool blocks.
 */
function synthesizeLegacyBlocks(
  content: string | null,
  toolActivities: unknown[] | null,
): ContentBlock[] | null {
  const blocks: ContentBlock[] = [];
  if (content) {
    blocks.push({ type: "text", text: content });
  }
  if (toolActivities && Array.isArray(toolActivities)) {
    for (const t of toolActivities) {
      blocks.push({ type: "tool", ...(t as Omit<ContentBlock & { type: "tool" }, "type">) });
    }
  }
  return blocks.length > 0 ? blocks : null;
}

export function createChatService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  threadService: Pick<ThreadService, "createThreadId">;
}): ChatService {
  return {
    async listSessions(user, canvasId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("chat_sessions")
        .select("id, title, updated_at")
        .eq("canvas_id", canvasId)
        .order("updated_at", { ascending: false });

      if (error) {
        throw new ChatServiceError("chat_error", "Failed to list sessions.", 500);
      }

      return (data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
      }));
    },

    async createSession(user, canvasId, title) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("chat_sessions")
        .insert({
          canvas_id: canvasId,
          created_by: user.id,
          thread_id: options.threadService.createThreadId(),
          ...(title ? { title } : {}),
        })
        .select("id, title, updated_at")
        .single();

      if (error || !data) {
        throw new ChatServiceError("chat_error", "Failed to create session.", 500);
      }

      return {
        id: data.id,
        title: data.title,
        updatedAt: data.updated_at,
      };
    },

    async updateSessionTitle(user, sessionId, title) {
      const client = options.createUserClient(user.accessToken);
      const { error } = await client
        .from("chat_sessions")
        .update({ title })
        .eq("id", sessionId);

      if (error) {
        throw new ChatServiceError("chat_error", "Failed to update session title.", 500);
      }
    },

    async deleteSession(user, sessionId) {
      const client = options.createUserClient(user.accessToken);
      const { error } = await client
        .from("chat_sessions")
        .delete()
        .eq("id", sessionId);

      if (error) {
        throw new ChatServiceError("session_not_found", "Session not found.", 404);
      }
    },

    async listMessages(user, sessionId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("chat_messages")
        .select("id, role, content, tool_activities, content_blocks, created_at")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });

      if (error) {
        // Log the driver's own error before wrapping it. ChatServiceError keeps
        // only a fixed sentence, so the postgres code/message that says WHY —
        // statement timeout, row too large, RLS refusal — was being thrown away,
        // leaving "Failed to list messages." as the only evidence anywhere.
        console.log(
          "[chat-service] listMessages failed",
          "sessionId=" + sessionId,
          "code=" + String((error as { code?: string }).code ?? ""),
          "message=" + String((error as { message?: string }).message ?? ""),
          "details=" + String((error as { details?: string }).details ?? ""),
          "hint=" + String((error as { hint?: string }).hint ?? ""),
        );
        throw new ChatServiceError("chat_error", "Failed to list messages.", 500);
      }

      const rows = (data ?? []).map((row) => {
        const contentBlocks =
          Array.isArray(row.content_blocks) && row.content_blocks.length > 0
            ? (row.content_blocks as ContentBlock[])
            : synthesizeLegacyBlocks(
                row.content,
                row.tool_activities as unknown[] | null,
              );

        return {
          id: row.id,
          role: row.role as "user" | "assistant",
          content: row.content,
          toolActivities: row.tool_activities as ChatMessage["toolActivities"],
          contentBlocks,
          createdAt: row.created_at,
        };
      });

      // Deduplicate consecutive messages with same role + content
      // (caused by dual client+server save in earlier versions)
      return rows.filter(
        (msg, i) =>
          i === 0 ||
          msg.role !== rows[i - 1]!.role ||
          msg.content !== rows[i - 1]!.content,
      );
    },

    async createMessage(user, sessionId, input) {
      const client = options.createUserClient(user.accessToken);
      const safeBlocks = input.contentBlocks
        ? stripInlineImageBytes(input.contentBlocks, {
            sessionId,
            role: input.role,
          })
        : null;

      const RETURNING =
        "id, role, content, tool_activities, content_blocks, created_at";

      // WHY THIS ONE DOES NOT USE withTransportRetry
      //
      // A proxy blip here cost a real assistant reply: the generated image was on
      // the canvas but the message row was never written, so after a reload the
      // conversation showed the picture with no text and no way to get it back
      // (observed 2026-09-15, `TypeError: fetch failed` / TLS ECONNRESET).
      //
      // But this is an INSERT, and `fetch failed` also covers a response lost on the
      // way BACK — in which case the row DID land. Blindly replaying would then post
      // the assistant's reply twice, which is a worse bug than the one being fixed.
      //
      // So the id is generated HERE instead of by the database. That turns "did it
      // land?" from unknowable into a lookup: before replaying, ask for that exact
      // id. The insert stays a plain insert, so no UPDATE policy is needed (an
      // upsert would have required one, and RLS on chat_messages grants insert).
      const messageId = randomUUID();

      const attemptInsert = async () =>
        await client
          .from("chat_messages")
          .insert({
            id: messageId,
            session_id: sessionId,
            role: input.role,
            content: input.content,
            ...(input.toolActivities
              ? { tool_activities: input.toolActivities as unknown as Json }
              : {}),
            ...(safeBlocks ? { content_blocks: safeBlocks as unknown as Json } : {}),
          })
          .select(RETURNING)
          .single();

      let { data, error } = await attemptInsert();

      if (error && isTransportFailure(error)) {
        console.log(
          "[chat.createMessage] transport failure, checking whether the row landed",
          JSON.stringify({ sessionId, messageId, message: error.message }),
        );
        await new Promise((r) => setTimeout(r, 400));

        const existing = await client
          .from("chat_messages")
          .select(RETURNING)
          .eq("id", messageId)
          .maybeSingle();

        if (existing.data) {
          // The first attempt did reach Postgres; only its answer was lost.
          console.log(
            "[chat.createMessage] row had landed, reusing it",
            JSON.stringify({ sessionId, messageId }),
          );
          data = existing.data;
          error = null;
        } else if (!existing.error) {
          // Confirmed absent, so the statement never executed — safe to replay.
          ({ data, error } = await attemptInsert());
        }
        // If the CHECK itself failed we cannot tell, and inserting again risks a
        // duplicate. Fall through to the error path: losing one message is
        // recoverable by the user re-asking; two identical assistant replies in the
        // transcript are not.
      }

      if (error || !data) {
        // Log the driver's own reason. Collapsing every failure into one generic
        // sentence is what turned a statement timeout into a multi-hour hunt.
        console.log(
          "[chat.createMessage] insert failed",
          JSON.stringify({
            sessionId,
            messageId,
            code: error?.code,
            message: error?.message,
            details: error?.details,
            hint: error?.hint,
          }),
        );
        throw new ChatServiceError("chat_error", "Failed to save message.", 500);
      }

      // Touch session updated_at
      await client
        .from("chat_sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", sessionId);

      const contentBlocks =
        Array.isArray(data.content_blocks) && data.content_blocks.length > 0
          ? (data.content_blocks as ContentBlock[])
          : synthesizeLegacyBlocks(
              data.content,
              data.tool_activities as unknown[] | null,
            );

      return {
        id: data.id,
        role: data.role as "user" | "assistant",
        content: data.content,
        toolActivities: data.tool_activities as ChatMessage["toolActivities"],
        contentBlocks,
        createdAt: data.created_at,
      };
    },
  };
}
