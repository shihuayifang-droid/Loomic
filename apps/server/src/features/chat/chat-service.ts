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
import { signProjectAssetUrls } from "../storage/project-asset-urls.js";
import type { ThreadService } from "./thread-service.js";

/**
 * X-52: which fields identify media, and which are just this read's projection.
 * A persisted message keeps the first group and never the second.
 */
const STABLE_ASSET_FIELDS = ["assetId", "objectPath", "mimeType", "source"] as const;
const PROJECTED_URL_FIELDS = ["url", "thumbnailUrl"] as const;

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

/**
 * X-52: strip the read-time URL projection out of everything that is about to be
 * written to JSONB, keeping only the stable identity.
 *
 * A signed URL lives about an hour. A chat row lives as long as the
 * conversation. Persisting the first inside the second is how history ends up
 * full of dead image links the server can no longer repair, because a URL is not
 * something ownership can be re-derived from. So the write keeps
 * `assetId/objectPath/mimeType/source` and `listMessages` re-signs on every read.
 *
 * Applies to both shapes that carry media:
 *   * `image` blocks (the user's own attachments),
 *   * `tool` blocks' `artifacts` (images and videos the Agent produced).
 *
 * A `data:` block is left for `stripInlineImageBytes` to reject outright — this
 * function must not launder one into a block that merely looks tidy.
 */
function stripProjectedUrls(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    const type = (block as { type?: string }).type;

    if (type === "image") {
      const image = block as unknown as Record<string, unknown>;
      const url = typeof image.url === "string" ? image.url : "";
      if (url.startsWith("data:")) return block;

      const stable: Record<string, unknown> = { type: "image" };
      for (const field of STABLE_ASSET_FIELDS) {
        if (image[field] !== undefined) stable[field] = image[field];
      }
      // `name` is display metadata, not identity, and is safe to keep.
      if (image.name !== undefined) stable.name = image.name;
      return stable as unknown as ContentBlock;
    }

    if (type === "tool") {
      const tool = block as unknown as Record<string, unknown>;
      const artifacts = tool.artifacts;
      if (!Array.isArray(artifacts) || artifacts.length === 0) return block;

      return {
        ...tool,
        artifacts: artifacts.map((artifact) => {
          if (!artifact || typeof artifact !== "object") return artifact;
          const entry = artifact as Record<string, unknown>;
          const cleaned: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(entry)) {
            if ((PROJECTED_URL_FIELDS as readonly string[]).includes(key)) continue;
            cleaned[key] = value;
          }
          return cleaned;
        }),
      } as unknown as ContentBlock;
    }

    return block;
  });
}

/** Every asset id referenced by a set of blocks, in first-seen order. */
function collectBlockAssetIds(blocks: ContentBlock[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const add = (value: unknown) => {
    if (typeof value !== "string" || value.length === 0) return;
    if (seen.has(value)) return;
    seen.add(value);
    ids.push(value);
  };

  for (const block of blocks) {
    const entry = block as unknown as Record<string, unknown>;
    if (entry.type === "image") add(entry.assetId);

    const artifacts = entry.artifacts;
    if (Array.isArray(artifacts)) {
      for (const artifact of artifacts) {
        if (artifact && typeof artifact === "object") {
          add((artifact as Record<string, unknown>).assetId);
        }
      }
    }
  }

  return ids;
}

/**
 * X-52: re-project a `url` onto every block that names an asset.
 *
 * The row is read through the CALLER's client, so RLS is what decides whether
 * the asset may be seen at all — the same authorisation that governs the canvas.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *   * an asset that resolves is signed fresh for this caller;
 *   * an asset that does NOT resolve — invisible under RLS, gone, or refused by
 *     the signer — leaves its block with NO url. The url already sitting in the
 *     row is not a fallback: it is a token that used to work, and serving it
 *     again is exactly the "回退旧URL" the ticket forbids. So it is removed
 *     before the projection runs.
 *
 * A url-less block is the honest outcome. Showing no image is recoverable;
 * showing one whose signature no longer stands is not.
 */
async function projectBlockUrls(
  client: UserSupabaseClient,
  blocks: ContentBlock[],
  context: { sessionId: string },
): Promise<ContentBlock[]> {
  const assetIds = collectBlockAssetIds(blocks);

  const dropUrl = (record: Record<string, unknown>): Record<string, unknown> => {
    const { url: _url, thumbnailUrl: _thumbnailUrl, ...rest } = record;
    return rest;
  };

  /** Blocks with identity but no signed url yet: the old url is cleared. */
  const withoutProjection: ContentBlock[] = blocks.map((block) => {
    const entry = block as unknown as Record<string, unknown>;

    if (entry.type === "image" && entry.assetId) {
      return dropUrl(entry) as unknown as ContentBlock;
    }

    const artifacts = entry.artifacts;
    if (Array.isArray(artifacts)) {
      return {
        ...entry,
        artifacts: artifacts.map((artifact) =>
          artifact && typeof artifact === "object" && (artifact as Record<string, unknown>).assetId
            ? dropUrl(artifact as Record<string, unknown>)
            : artifact,
        ),
      } as unknown as ContentBlock;
    }

    return block;
  });

  if (assetIds.length === 0) return withoutProjection;

  const { data, error } = await client
    .from("asset_objects")
    .select("id, object_path, bucket")
    .in("id", assetIds);

  if (error) {
    // Safe log: the reason, never a URL — a signed URL is a bearer token.
    console.log(
      "[chat-service] asset lookup failed, returning blocks without urls",
      JSON.stringify({ sessionId: context.sessionId, code: error.code }),
    );
    return withoutProjection;
  }

  const rows = (data ?? []) as Array<{
    id: string;
    object_path: string;
    bucket: string;
  }>;

  // Sign each row with its own bucket; `signProjectAssetUrls` omits whatever it
  // cannot sign and never falls back to a public URL.
  const signedByAssetId = new Map<string, string>();
  await Promise.all(
    rows.map(async (row) => {
      const signed = await signProjectAssetUrls(client, [row.object_path], {
        bucket: row.bucket,
      });
      const url = signed.get(row.object_path);
      if (url) signedByAssetId.set(row.id, url);
    }),
  );

  return withoutProjection.map((block) => {
    const entry = block as unknown as Record<string, unknown>;
    const withUrl = (record: Record<string, unknown>): Record<string, unknown> => {
      const url = signedByAssetId.get(String(record.assetId ?? ""));
      return url ? { ...record, url } : record;
    };

    if (entry.type === "image" && entry.assetId) {
      return withUrl(entry) as unknown as ContentBlock;
    }

    const artifacts = entry.artifacts;
    if (Array.isArray(artifacts)) {
      return {
        ...entry,
        artifacts: artifacts.map((artifact) =>
          artifact && typeof artifact === "object"
            ? withUrl(artifact as Record<string, unknown>)
            : artifact,
        ),
      } as unknown as ContentBlock;
    }

    return block;
  });
}

/**
 * Legacy blocks: media whose only handle is a URL, written before X-52.
 *
 * They are READ as they always were — dropping the url would turn every old
 * image in every old conversation into a blank — but they are never rewritten
 * and the URL is never reverse-engineered into an object path or an owner.
 * Guessing ownership from a URL string is how an object ends up authorised
 * against the wrong project, which the ticket ranks as worse than a display
 * failure. The real inventory and disposition of these rows is registered as
 * T-23.
 */
function isLegacyUrlOnlyBlock(block: ContentBlock): boolean {
  const entry = block as unknown as Record<string, unknown>;
  if (entry.type === "image") {
    return typeof entry.url === "string" && entry.url.length > 0 && !entry.assetId;
  }
  return false;
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

      // X-52: re-sign every block that names an asset, for THIS caller. The
      // stored rows carry no url at all for post-X-52 messages; the url below is
      // a projection minted now, through the reader's own client, so RLS decides
      // what they may see. Legacy url-only rows are counted, not repaired.
      const projected = await Promise.all(
        rows.map(async (message) => {
          if (!message.contentBlocks) return message;
          const legacyCount = message.contentBlocks.filter(isLegacyUrlOnlyBlock).length;
          if (legacyCount > 0) {
            console.log(
              "[chat-service] legacy url-only blocks returned as stored (T-23)",
              JSON.stringify({ sessionId, messageId: message.id, blocks: legacyCount }),
            );
          }
          return {
            ...message,
            contentBlocks: await projectBlockUrls(
              client,
              message.contentBlocks,
              { sessionId },
            ),
          };
        }),
      );

      // Deduplicate consecutive messages with same role + content
      // (caused by dual client+server save in earlier versions)
      return projected.filter(
        (msg, i) =>
          i === 0 ||
          msg.role !== projected[i - 1]!.role ||
          msg.content !== projected[i - 1]!.content,
      );
    },

    async createMessage(user, sessionId, input) {
      const client = options.createUserClient(user.accessToken);
      const safeBlocks = input.contentBlocks
        ? stripProjectedUrls(
            stripInlineImageBytes(input.contentBlocks, {
              sessionId,
              role: input.role,
            }),
          )
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
