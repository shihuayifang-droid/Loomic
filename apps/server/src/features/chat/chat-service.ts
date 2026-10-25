import type {
  ChatMessage,
  ChatMessageCreateRequest,
  ChatSessionSummary,
  ContentBlock,
  Json,
} from "@loomic/shared";

import { randomUUID } from "node:crypto";

import {
  ChatReadError,
  type ChatAssetReadRow,
  type ChatReadRepository,
  type ChatMessageReadRow,
  type ChatSessionReadRow,
} from "../../db/chat-read-repository.js";
import {
  ChatSessionWriteError,
  type ChatSessionWriteRepository,
  type ChatSessionWriteRow,
} from "../../db/chat-session-write-repository.js";
import {
  ChatWriteError,
  chatWriteCause,
  chatWriteFailureCode,
  type ChatMessageWriteRow,
  type ChatWriteRepository,
} from "../../db/chat-write-repository.js";
import { isTransportFailure } from "../../supabase/transport-retry.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
// T-133 (9th slice): the signature is minted through the injected `ObjectStore`
// seam — the same factory form uploads (45AI), canvas (45AJ), brand-kit (45AH)
// and projects (45AS) take — instead of the service wrapping the user client.
import type { ObjectStore } from "../storage/object-store.js";
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
 * The ASSET IDENTITIES are read through the chat read repository (workorder
 * 20D), so the authorization is the SQL's own project ACL — the reader must be a
 * member of the session's project and either its author or an admin/owner. The
 * SIGNATURE is minted through the CALLER's storage client, reached through the
 * injected `ObjectStore` factory (T-133 9th slice), so the storage layer keeps
 * deciding what it will sign.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *   * an asset that resolves is signed fresh for this caller;
 *   * an asset that does NOT resolve — not in this project, gone, or refused by
 *     the signer — leaves its block with NO url. The url already sitting in the
 *     row is not a fallback: it is a token that used to work, and serving it
 *     again is exactly the "回退旧URL" the ticket forbids. So it is removed
 *     before the projection runs.
 *
 * A url-less block is the honest outcome. Showing no image is recoverable;
 * showing one whose signature no longer stands is not.
 */
async function projectBlockUrls(
  repository: ChatReadRepository,
  store: ObjectStore,
  blocks: ContentBlock[],
  context: { sessionId: string; actorId: string },
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

  let rows: ChatAssetReadRow[];
  try {
    rows = await repository.listReadableSessionAssets({
      actorId: context.actorId,
      sessionId: context.sessionId,
      assetIds,
    });
  } catch (error) {
    // Safe log: the fixed operation name, never a URL — a signed URL is a bearer
    // token. A read that fails is a display limitation, not a failed request:
    // the blocks simply keep their identity and lose the projection.
    console.log(
      "[chat-service] asset lookup failed, returning blocks without urls",
      JSON.stringify({
        sessionId: context.sessionId,
        operation: error instanceof ChatReadError ? error.operation : "unknown",
      }),
    );
    return withoutProjection;
  }

  // Sign each row with its own bucket; `signProjectAssetUrls` omits whatever it
  // cannot sign and never falls back to a public URL.
  const signedByAssetId = new Map<string, string>();
  await Promise.all(
    rows.map(async (row) => {
      const signed = await signProjectAssetUrls(store, [row.object_path], {
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

/**
 * Which write failures may be confirmed and replayed (workorder 21B).
 *
 * The predicate is the accepted one (workorder 21-前置A) and it is not modified
 * here; what changes is where its input comes from. The write repository wraps
 * the driver's own error as `cause`, and that object IS the shape the predicate
 * was verified against — a Node socket code, or the socket's own text with no
 * SQLSTATE at all.
 *
 * Everything else fails fast, which is what keeps a real database answer (an RLS
 * refusal, a constraint violation, an illegal uuid) from being confirmed and
 * replayed: it would fail again identically, and a replay on top of a row that
 * DID land is the duplicate-reply bug this whole branch exists to prevent.
 */
function isWriteTransportFailure(error: unknown): boolean {
  return isTransportFailure(chatWriteCause(error));
}

/**
 * The transport's own text, for the one log line that reports a transport
 * failure. Safe by construction: the predicate only reaches the message when the
 * error carries no code at all, and a statement that reached PostgreSQL always
 * answers with a SQLSTATE.
 */
function transportFailureMessage(error: unknown): string | undefined {
  const cause = chatWriteCause(error);
  if (!cause || typeof cause !== "object") return undefined;

  const message = (cause as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
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
  /**
   * T-133 (9th slice), re-shaped by 45BF / T-133 (10a): a FACTORY over the
   * CALLER's access token, not a client, and not a shared store — the same form
   * brand-kit (45BB), uploads (45BC), canvas (45BC) and projects (45BE) take.
   * The chat projection signs for the caller, so the store is built from the
   * caller's own token and Storage answers under that user's RLS; handing the
   * service the server's/admin's store would widen the permission on this
   * feature. The service no longer names a client: this factory is where the
   * backend is named, and 10a is a signature change only — both backends behave
   * exactly as they did.
   */
  createObjectStore: (accessToken: string) => ObjectStore;
  chatReadRepository: ChatReadRepository;
  /**
   * Required, never optional: the create path writes through the pure `pg`
   * repository or it fails. A missing repository must not fall back to PostgREST.
   */
  chatWriteRepository: ChatWriteRepository;
  /**
   * Required for the same reason (workorder 21C): the session CRUD — create,
   * rename, delete — goes through its own narrow repository, and a missing one
   * is a failed call rather than a fallback to PostgREST.
   */
  chatSessionWriteRepository: ChatSessionWriteRepository;
  threadService: Pick<ThreadService, "createThreadId">;
}): ChatService {
  return {
    async listSessions(user, canvasId) {
      // ADR-0001 / workorder 20D: the session list is read through the pure `pg`
      // repository, so the project ACL is the statement's own predicate. `null`
      // means "no canvas you may read" (404); `[]` means a readable canvas with
      // no sessions yet (200 with an empty list) — the two must not collapse.
      let rows: ChatSessionReadRow[] | null;
      try {
        rows = await options.chatReadRepository.listReadableSessions({
          actorId: user.id,
          canvasId,
        });
      } catch (error) {
        console.log(
          "[chat-service] listSessions failed",
          "canvasId=" + canvasId,
          "operation=" +
            String(error instanceof ChatReadError ? error.operation : "unknown"),
        );
        throw new ChatServiceError("chat_error", "Failed to list sessions.", 500);
      }

      if (rows === null) {
        throw new ChatServiceError(
          "session_not_found",
          "Canvas not found.",
          404,
        );
      }

      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
      }));
    },

    async createSession(user, canvasId, title) {
      // ADR-0001 / workorder 21C: the insert goes through the pure `pg`
      // repository, so `canvas → project → workspace_members` and
      // `projects.created_by = actor` are the statement's own predicate. An
      // archived project is NOT filtered: an archived project's author can still
      // open a conversation (T-34).
      //
      // The thread id is still minted HERE, by the thread service, and handed to
      // the repository as a value: the repository stores what it is given and
      // never produces an id of its own.
      //
      // `createdBy` is the caller's own id, but it is passed as DATA, not as
      // authority — the write ACL is the project's author, so the column carries
      // no weight and the repository is free to store whatever it is handed.
      const actorId = user.id;
      const threadId = options.threadService.createThreadId();

      let data: ChatSessionWriteRow;
      try {
        data = await options.chatSessionWriteRepository.createSession({
          actorId,
          canvasId,
          threadId,
          // The old insert omitted the column for a falsy title, which let the
          // schema's `DEFAULT 'New Chat'` decide. `null` keeps that exact
          // meaning; the default stays in the migration instead of being copied
          // here where the two would drift.
          title: title ? title : null,
          createdBy: actorId,
        });
      } catch (error) {
        // Only the fixed operation name is logged: the driver's message embeds
        // the statement and its bind values, and this line is read by operators.
        console.log(
          "[chat-service] createSession failed",
          "canvasId=" + canvasId,
          "operation=" +
            String(error instanceof ChatSessionWriteError ? error.operation : "unknown"),
        );
        throw new ChatServiceError("chat_error", "Failed to create session.", 500);
      }

      // `chat_sessions.title` is `text NOT NULL DEFAULT 'New Chat'`, so this
      // cannot happen against the schema this repository was written for. If the
      // column ever stops being NOT NULL, serving the null would make the route's
      // own response schema fail and come back as a 400 blaming the CLIENT for a
      // server-side shape drift — so it fails here instead, as the same 500 the
      // write failure above uses.
      if (data.title === null) {
        console.log(
          "[chat-service] createSession returned no title",
          "canvasId=" + canvasId,
          "operation=createSession",
        );
        throw new ChatServiceError("chat_error", "Failed to create session.", 500);
      }

      return {
        id: data.id,
        title: data.title,
        updatedAt: data.updatedAt,
      };
    },

    async updateSessionTitle(user, sessionId, title) {
      try {
        // ADR-0001 / workorder 21C: the rename re-walks `session → canvas →
        // project` and requires the project's author. A 0-row result — the
        // session is gone, or this actor may not write it — stays a SILENT
        // success (T-34), exactly as the old PostgREST update behaved: it never
        // inspected its result either. `affectedRows` is deliberately not turned
        // into control flow, so nothing new is enumerable through the route.
        await options.chatSessionWriteRepository.updateSessionTitle({
          actorId: user.id,
          sessionId,
          title,
        });
      } catch (error) {
        console.log(
          "[chat-service] updateSessionTitle failed",
          "sessionId=" + sessionId,
          "operation=" +
            String(error instanceof ChatSessionWriteError ? error.operation : "unknown"),
        );
        throw new ChatServiceError("chat_error", "Failed to update session title.", 500);
      }
    },

    async deleteSession(user, sessionId) {
      try {
        // ADR-0001 / workorder 21C: the delete removes the session row under the
        // same write ACL, and the schema's own `ON DELETE CASCADE` decides what
        // happens to the messages. A 0-row delete is the same legal silent
        // success as the rename above.
        await options.chatSessionWriteRepository.deleteSession({
          actorId: user.id,
          sessionId,
        });
      } catch (error) {
        // The existing wording and status are kept verbatim: the route's contract
        // is unchanged, and a repository failure must not become a new way to
        // probe whether a session exists.
        console.log(
          "[chat-service] deleteSession failed",
          "sessionId=" + sessionId,
          "operation=" +
            String(error instanceof ChatSessionWriteError ? error.operation : "unknown"),
        );
        throw new ChatServiceError("session_not_found", "Session not found.", 404);
      }
    },

    async listMessages(user, sessionId) {
      const store = options.createObjectStore(user.accessToken);

      // ADR-0001 / workorder 20D: the history rows come from the pure `pg`
      // repository, so `session → canvas → project` is re-walked inside the
      // statement instead of being delegated to the old RLS policies. `null` is
      // "no session you may read" (404); `[]` is a readable session whose history
      // is genuinely empty (200).
      let rows: ChatMessageReadRow[] | null;
      try {
        rows = await options.chatReadRepository.listReadableMessages({
          actorId: user.id,
          sessionId,
        });
      } catch (error) {
        // Log the fixed operation name before wrapping the failure. The reason
        // (statement timeout, illegal id, an unusable row shape) stays
        // attributable without any SQL or credential reaching a log line.
        console.log(
          "[chat-service] listMessages failed",
          "sessionId=" + sessionId,
          "operation=" +
            String(error instanceof ChatReadError ? error.operation : "unknown"),
        );
        throw new ChatServiceError("chat_error", "Failed to list messages.", 500);
      }

      if (rows === null) {
        throw new ChatServiceError("session_not_found", "Session not found.", 404);
      }

      const messages = rows.map((row) => {
        const contentBlocks =
          Array.isArray(row.content_blocks) && row.content_blocks.length > 0
            ? (row.content_blocks as ContentBlock[])
            : synthesizeLegacyBlocks(
                row.content,
                row.tool_activities as unknown[] | null,
              );

        return {
          id: row.id,
          role: row.role,
          content: row.content,
          toolActivities: row.tool_activities as ChatMessage["toolActivities"],
          contentBlocks,
          createdAt: row.created_at,
        };
      });

      // X-52: re-sign every block that names an asset, for THIS caller. The
      // stored rows carry no url at all for post-X-52 messages; the url below is
      // a projection minted now, from the caller's own readable assets, so the
      // project ACL decides what they may see. Legacy url-only rows are counted,
      // not repaired.
      const projected = await Promise.all(
        messages.map(async (message) => {
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
              options.chatReadRepository,
              store,
              message.contentBlocks,
              { sessionId, actorId: user.id },
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
      const store = options.createObjectStore(user.accessToken);
      const safeBlocks = input.contentBlocks
        ? stripProjectedUrls(
            stripInlineImageBytes(input.contentBlocks, {
              sessionId,
              role: input.role,
            }),
          )
        : null;

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
      // id. The insert stays a plain insert under the caller's own id — the write
      // repository stores it as given and never lets the database mint one.
      const messageId = randomUUID();
      const actorId = user.id;

      const attemptInsert = async (): Promise<ChatMessageWriteRow> =>
        await options.chatWriteRepository.insertMessage({
          actorId,
          messageId,
          sessionId,
          role: input.role,
          content: input.content,
          toolActivities: input.toolActivities
            ? (input.toolActivities as unknown as Json)
            : null,
          contentBlocks: safeBlocks ? (safeBlocks as unknown as Json) : null,
        });

      let data: ChatMessageWriteRow | null = null;
      let failure: unknown = null;

      try {
        data = await attemptInsert();
      } catch (error) {
        if (!isWriteTransportFailure(error)) {
          // A real answer from PostgreSQL — a SQLSTATE, a constraint, or the write
          // ACL's silent zero rows. It would fail again identically, so it is not
          // confirmed and not replayed; the transport narrowing is what makes this
          // branch safe.
          failure = error;
        } else {
          console.log(
            "[chat.createMessage] transport failure, checking whether the row landed",
            JSON.stringify({
              sessionId,
              messageId,
              message: transportFailureMessage(error),
            }),
          );
          await new Promise((r) => setTimeout(r, 400));

          try {
            const existing =
              await options.chatWriteRepository.findMessageForRecovery({
                actorId,
                messageId,
              });

            if (existing) {
              // The first attempt did reach Postgres; only its answer was lost.
              console.log(
                "[chat.createMessage] row had landed, reusing it",
                JSON.stringify({ sessionId, messageId }),
              );
              data = existing;
            } else {
              // Confirmed absent, so the statement never executed — safe to replay.
              data = await attemptInsert();
            }
          } catch (confirmationError) {
            // If the confirmation itself failed we cannot tell, and inserting again
            // risks a duplicate. Fall through to the error path: losing one message
            // is recoverable by the user re-asking; two identical assistant replies
            // in the transcript are not. The transport failure stays the reported
            // reason. A replay attempt that fails lands here too, which is what
            // keeps "at most one replay" true.
            failure = error;
            console.log(
              "[chat.createMessage] could not confirm whether the row landed",
              JSON.stringify({
                sessionId,
                messageId,
                operation:
                  confirmationError instanceof ChatWriteError
                    ? confirmationError.operation
                    : "unknown",
              }),
            );
          }
        }
      }

      if (failure || !data) {
        // Log the driver's own CODE, never its message: `pg` echoes the failing
        // statement and its bind values inside the message, and this line is read
        // by operators, not by the caller. Collapsing every failure into one
        // generic sentence is what turned a statement timeout into a multi-hour
        // hunt, so the operation name and the SQLSTATE stay attributable.
        console.log(
          "[chat.createMessage] insert failed",
          JSON.stringify({
            sessionId,
            messageId,
            operation:
              failure instanceof ChatWriteError ? failure.operation : "unknown",
            code: chatWriteFailureCode(failure),
          }),
        );
        throw new ChatServiceError("chat_error", "Failed to save message.", 500);
      }

      // Touch session updated_at.
      //
      // T-34 (workorder 21B): a touch that affects ZERO rows — the session is
      // gone, or this actor may not write it — is a legal outcome and must NOT
      // become a business error. The old update never inspected its result
      // either, so the message stays a stored, successful write; a repository
      // failure is swallowed for the same reason. Only the safe operation name is
      // logged, and `affectedRows` is deliberately not turned into control flow.
      try {
        await options.chatWriteRepository.touchSession({
          actorId,
          sessionId,
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.log(
          "[chat.createMessage] session touch failed, the message stays stored",
          JSON.stringify({
            sessionId,
            operation: error instanceof ChatWriteError ? error.operation : "unknown",
          }),
        );
      }

      const storedBlocks =
        Array.isArray(data.content_blocks) && data.content_blocks.length > 0
          ? (data.content_blocks as ContentBlock[])
          : synthesizeLegacyBlocks(
              data.content,
              data.tool_activities as unknown[] | null,
            );

      // X-52 (工单14 fixup T2): project THIS read's urls onto what is returned,
      // through the SAME function `listMessages` uses.
      //
      // The row was written with stable identity only (`stripProjectedUrls`), so
      // echoing it verbatim handed the client an image block with no url at all.
      // That is a legal answer — it is what `listMessages` returns when signing
      // fails — but `imageBlockSchema` used to require the field, so the create
      // response failed its own Zod parse and a successful write surfaced as a
      // 500. Projecting here fixes the shape rather than the schema alone: the
      // caller is handed a url the server minted FOR THEM, which is the whole
      // point of not persisting the request's url. Should signing fail, the block
      // keeps its identity and simply carries no url — never the stale one from
      // the row, and never a 500.
      const contentBlocks =
        storedBlocks === null
          ? null
          : await projectBlockUrls(
              options.chatReadRepository,
              store,
              storedBlocks,
              {
                sessionId,
                actorId: user.id,
              },
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
