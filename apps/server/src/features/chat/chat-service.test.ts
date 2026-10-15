// The one invariant that matters here: a proxy blip must never turn one assistant
// reply into two.
//
// Background (observed 2026-09-15): a generated image landed on the canvas, then
// `chat_messages` insert failed with `TypeError: fetch failed` / TLS ECONNRESET.
// The reply was lost permanently — on reload the conversation showed the picture
// with no text. Adding a naive retry would fix that at the cost of a worse bug,
// because `fetch failed` also covers a response lost on the way BACK, in which case
// the row DID land and replaying posts the message twice.
//
// createMessage therefore generates the id itself and, on a transport failure,
// LOOKS to see whether the row landed before deciding. These tests pin all four
// branches of that decision.
//
// Workorder 21B moved the three writes of that state machine (the insert, the
// "did it land?" read, the session touch) from PostgREST into
// `ChatWriteRepository`. The branches above are unchanged; what moved is the
// surface they are observed through, so the doubles below record the same insert
// payloads they always did and answer the same way — a scripted `error` still
// means "this call failed", and it is now thrown as the repository's own error.
import { describe, expect, it, vi } from "vitest";

import {
  messageCreateResponseSchema,
  messageListResponseSchema,
} from "@loomic/shared";

import {
  LIST_READABLE_SESSION_ASSETS,
  ChatReadError,
  type ChatAssetReadRow,
  type ChatMessageReadRow,
  type ChatReadRepository,
  type ChatSessionReadRow,
} from "../../db/chat-read-repository.js";
import {
  CREATE_SESSION,
  DELETE_SESSION,
  UPDATE_SESSION_TITLE,
  ChatSessionWriteError,
  type ChatSessionWriteRepository,
  type ChatSessionWriteRow,
} from "../../db/chat-session-write-repository.js";
import {
  FIND_MESSAGE_FOR_RECOVERY,
  INSERT_MESSAGE,
  TOUCH_SESSION,
  ChatWriteError,
  type ChatMessageWriteRow,
  type ChatWriteRepository,
} from "../../db/chat-write-repository.js";
import { createChatService, ChatServiceError } from "./chat-service.js";

const USER = { accessToken: "t", id: "u1" } as never;
const SESSION = "s1";
const INPUT = { content: "hello", role: "assistant" } as never;

const TRANSPORT = { code: "", message: "TypeError: fetch failed" };
const PG_DENIED = {
  code: "42501",
  message: "new row violates row-level security policy",
};

/**
 * The read side of this service moved to the chat read repository (workorder
 * 20D), so the doubles below answer those reads and record the actor and parent
 * ids they were called with. `assetError` / `messagesError` model the repository
 * failing, which the service must classify rather than leak.
 */
type RepositoryScript = {
  sessions?: { rows: ChatSessionReadRow[] | null; error?: unknown };
  messages?: { rows: ChatMessageReadRow[] | null; error?: unknown };
  assets?: ChatAssetReadRow[];
  assetError?: unknown;
};

type RepositoryCalls = {
  sessions: Array<{ actorId: string; canvasId: string }>;
  messages: Array<{ actorId: string; sessionId: string }>;
  assets: Array<{ actorId: string; sessionId: string; assetIds: readonly string[] }>;
};

function repositoryStub(script: RepositoryScript): {
  repository: ChatReadRepository;
  calls: RepositoryCalls;
} {
  const calls: RepositoryCalls = { sessions: [], messages: [], assets: [] };

  const repository: ChatReadRepository = {
    async listReadableSessions(input) {
      calls.sessions.push({ ...input });
      if (script.sessions?.error) throw script.sessions.error;
      // `null` is the repository's "not readable" answer and must survive: `?? []`
      // here would silently turn every 404 case into an empty list.
      if (script.sessions === undefined) return [];
      return script.sessions.rows;
    },
    async listReadableMessages(input) {
      calls.messages.push({ ...input });
      if (script.messages?.error) throw script.messages.error;
      if (script.messages === undefined) return [];
      return script.messages.rows;
    },
    async listReadableSessionAssets(input) {
      calls.assets.push({ ...input });
      if (script.assetError) throw script.assetError;
      return script.assets ?? [];
    },
    async findReadableSessionThread() {
      return null;
    },
  };

  return { repository, calls };
}

function sessionRow(
  id: string,
  title: string,
  updatedAt: string,
): ChatSessionReadRow {
  return { id, title, updated_at: updatedAt };
}

function messageRow(
  id: string,
  overrides: Partial<ChatMessageReadRow> = {},
): ChatMessageReadRow {
  return {
    id,
    role: "assistant",
    content: "hello",
    tool_activities: null,
    content_blocks: null,
    created_at: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

function row(id: string) {
  return {
    id,
    role: "assistant",
    content: "hello",
    tool_activities: null,
    content_blocks: null,
    created_at: "2026-09-15T00:00:00.000Z",
  };
}

/**
 * What the WRITE repository should answer, scripted per call.
 *
 * `insertResults` is consumed in order and the last entry is sticky, so a replay
 * after the last scripted entry answers the same way again — the shape the old
 * PostgREST double had, kept so every existing case keeps its own script.
 *
 * An entry with `error` makes the call FAIL the way the repository fails: it
 * throws `ChatWriteError` wrapping that driver error. An entry with `data` is the
 * stored row (the insert's `RETURNING`, echoed back).
 */
type WriteScript = {
  insertResults: Array<{ data?: unknown; error?: unknown }>;
  /**
   * Answer the insert with the row the caller asked to store, which is what
   * PostgREST's `RETURNING` did. Used by the read-path harness.
   */
  echo?: boolean;
  /** Result of the "did it land?" lookup, when one happens. */
  lookup?: { data?: unknown; error?: unknown };
  /** Result of the session touch. Defaults to one affected row. */
  touch?: { affectedRows?: number; error?: unknown };
};

type WriteCalls = {
  inserts: Array<Record<string, unknown>>;
  lookups: Array<{ actorId: string; messageId: string }>;
  touches: Array<{ actorId: string; sessionId: string; updatedAt: string }>;
};

/**
 * The write repository as this service sees it.
 *
 * `inserts` stays the thing under test: its LENGTH is still how a duplicate would
 * show up, and each entry is the payload the old PostgREST insert carried, so the
 * assertions written against it did not have to change when the transport did.
 */
function writeRepositoryStub(script: WriteScript): {
  repository: ChatWriteRepository;
  calls: WriteCalls;
} {
  const calls: WriteCalls = { inserts: [], lookups: [], touches: [] };
  let insertCalls = 0;

  const repository: ChatWriteRepository = {
    async insertMessage(input) {
      calls.inserts.push({
        id: input.messageId,
        session_id: input.sessionId,
        role: input.role,
        content: input.content,
        tool_activities: input.toolActivities,
        content_blocks: input.contentBlocks,
      });

      const result =
        script.insertResults[Math.min(insertCalls, script.insertResults.length - 1)];
      insertCalls += 1;

      if (result?.error) throw new ChatWriteError(INSERT_MESSAGE, result.error);

      if (script.echo) {
        return {
          id: input.messageId,
          role: input.role,
          content: input.content,
          tool_activities: Array.isArray(input.toolActivities) ? input.toolActivities : null,
          content_blocks: Array.isArray(input.contentBlocks) ? input.contentBlocks : null,
          created_at: "2026-09-15T00:00:00.000Z",
        };
      }

      if (!result?.data) {
        // What the real repository does when the write ACL answers zero rows.
        throw new ChatWriteError(
          INSERT_MESSAGE,
          new Error("chat write inserted no row"),
        );
      }

      return result.data as ChatMessageWriteRow;
    },

    async findMessageForRecovery(input) {
      calls.lookups.push({ ...input });
      if (script.lookup?.error) {
        throw new ChatWriteError(FIND_MESSAGE_FOR_RECOVERY, script.lookup.error);
      }
      return (script.lookup?.data as ChatMessageWriteRow | undefined) ?? null;
    },

    async touchSession(input) {
      calls.touches.push({ ...input });
      if (script.touch?.error) {
        throw new ChatWriteError(TOUCH_SESSION, script.touch.error);
      }
      return { affectedRows: script.touch?.affectedRows ?? 1 };
    },
  };

  return { repository, calls };
}

/**
 * A fake for the CREATE path: the three writes are answered by the write
 * repository above, the asset identities come from the chat read repository
 * (workorder 20D), and the storage signing still goes through the user client.
 */
/**
 * What the SESSION write repository should answer, scripted per call
 * (workorder 21C).
 *
 * An entry with `error` makes the call FAIL the way the repository fails: it
 * throws `ChatSessionWriteError` wrapping that driver error. An entry with `data`
 * is the row the insert's `RETURNING` echoed back.
 */
type SessionWriteScript = {
  create?: { data?: ChatSessionWriteRow; error?: unknown };
  update?: { affectedRows?: number; error?: unknown };
  delete?: { affectedRows?: number; error?: unknown };
};

type SessionWriteCalls = {
  creates: Array<{
    actorId: string;
    canvasId: string;
    threadId: string;
    title: string | null;
    createdBy: string | null;
  }>;
  updates: Array<{ actorId: string; sessionId: string; title: string }>;
  deletes: Array<{ actorId: string; sessionId: string }>;
};

/**
 * The session write repository as this service sees it. The recorded CALLS are
 * the thing under test: which actor, which canvas/session, and the thread id and
 * `createdBy` the service decided to hand over.
 */
function sessionWriteRepositoryStub(script: SessionWriteScript = {}): {
  repository: ChatSessionWriteRepository;
  calls: SessionWriteCalls;
} {
  const calls: SessionWriteCalls = { creates: [], updates: [], deletes: [] };

  const repository: ChatSessionWriteRepository = {
    async createSession(input) {
      calls.creates.push({ ...input });

      if (script.create?.error) {
        throw new ChatSessionWriteError(CREATE_SESSION, script.create.error);
      }

      if (!script.create?.data) {
        // What the real repository does when the write ACL answers zero rows.
        throw new ChatSessionWriteError(
          CREATE_SESSION,
          new Error("chat session write created no row"),
        );
      }

      return script.create.data;
    },

    async updateSessionTitle(input) {
      calls.updates.push({ ...input });
      if (script.update?.error) {
        throw new ChatSessionWriteError(UPDATE_SESSION_TITLE, script.update.error);
      }
      return { affectedRows: script.update?.affectedRows ?? 1 };
    },

    async deleteSession(input) {
      calls.deletes.push({ ...input });
      if (script.delete?.error) {
        throw new ChatSessionWriteError(DELETE_SESSION, script.delete.error);
      }
      return { affectedRows: script.delete?.affectedRows ?? 1 };
    },
  };

  return { repository, calls };
}

function sessionWriteRow(
  id: string,
  title: string | null,
  updatedAt: string,
): ChatSessionWriteRow {
  return { id, title, updatedAt };
}

/**
 * A harness for the session CRUD only (workorder 21C).
 *
 * `createUserClient` THROWS on purpose: the three session writes moved into the
 * repository, so reaching for the caller's PostgREST client here is a regression
 * — there is no fallback transport — and any case that would do it fails loudly
 * instead of quietly succeeding.
 *
 * `threadService.createThreadId` is a counter, so a case can prove the id came
 * from the service and was passed through untouched.
 */
function sessionService(script: SessionWriteScript = {}) {
  const logs: string[] = [];
  const spy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

  const { repository: chatReadRepository } = repositoryStub({});
  const { repository: chatWriteRepository } = writeRepositoryStub({ insertResults: [] });
  const { repository: chatSessionWriteRepository, calls } =
    sessionWriteRepositoryStub(script);

  let threadIds = 0;
  const service = createChatService({
    createUserClient: () => {
      throw new Error(
        "the session CRUD must not reach the user client (21C: the session writes have a repository)",
      );
    },
    chatReadRepository,
    chatWriteRepository,
    chatSessionWriteRepository,
    threadService: {
      createThreadId: () => {
        threadIds += 1;
        return `thread-${threadIds}`;
      },
    },
  });

  return {
    service,
    calls,
    logs,
    threadIds: () => threadIds,
    restore: () => spy.mockRestore(),
  };
}

function fakeClient(script: {
  insertResults: Array<{ data?: unknown; error?: unknown }>;
  /** Result of the "did it land?" lookup, when one happens. */
  lookup?: { data?: unknown; error?: unknown };
  /** Result of the session touch; defaults to one affected row. */
  touch?: { affectedRows?: number; error?: unknown };
  /**
   * Rows the caller may read from `asset_objects` (工单14 fixup T2: the create
   * response is projected through the same signing path as the list response).
   * Since 20D they are read through the chat read repository, not the client.
   */
  assets?: ChatAssetReadRow[];
  /** Set when the asset read itself fails. */
  assetError?: unknown;
  /** Object paths the storage API refuses to sign. */
  unsignable?: ReadonlySet<string>;
}) {
  const client = {
    // Workorder 21B: no part of the create path may reach a table through the
    // user's own client any more. A call here is a regression — there is no
    // PostgREST fallback — so it fails the case loudly for ANY table.
    from: (table: string) => {
      throw new Error(
        `${table} must not be reached through the user client (21B: writes and reads both have repositories)`,
      );
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string) => {
          if (script.unsignable?.has(path)) {
            return { data: null, error: { message: "permission denied" } };
          }
          return {
            data: { signedUrl: `${SIGNED}&bucket=${bucket}&path=${path}` },
            error: null,
          };
        },
      }),
    },
  };

  const { repository, calls } = repositoryStub({
    assets: script.assets ?? [],
    ...(script.assetError ? { assetError: script.assetError } : {}),
  });
  const { repository: chatWriteRepository, calls: writeCalls } = writeRepositoryStub({
    insertResults: script.insertResults,
    ...(script.lookup ? { lookup: script.lookup } : {}),
    ...(script.touch ? { touch: script.touch } : {}),
  });
  const { repository: chatSessionWriteRepository } = sessionWriteRepositoryStub();

  return {
    service: createChatService({
      createUserClient: () => client as never,
      chatReadRepository: repository,
      chatWriteRepository,
      chatSessionWriteRepository,
      threadService: { createThreadId: () => "th" },
    }),
    inserts: writeCalls.inserts,
    calls,
    writeCalls,
    lookupCount: () => writeCalls.lookups.length,
    touchCount: () => writeCalls.touches.length,
  };
}

describe("createMessage transport handling", () => {
  it("supplies its own id, so 'did it land?' is answerable at all", async () => {
    const f = fakeClient({ insertResults: [{ data: row("fixed") }] });
    await f.service.createMessage(USER, SESSION, INPUT);
    expect(f.inserts).toHaveLength(1);
    // Without this the database would generate the id and a lost response would be
    // indistinguishable from a lost request.
    expect(typeof f.inserts[0]!.id).toBe("string");
    expect(f.inserts[0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("★ lost RESPONSE: reuses the landed row instead of inserting twice", async () => {
    vi.useFakeTimers();
    const f = fakeClient({
      insertResults: [{ error: TRANSPORT }],
      lookup: { data: row("already-there") },
    });
    const promise = f.service.createMessage(USER, SESSION, INPUT);
    await vi.runAllTimersAsync();
    const message = await promise;

    expect(message.id).toBe("already-there");
    expect(f.lookupCount()).toBe(1);
    // THE assertion of this file. Two inserts here = duplicated assistant reply.
    expect(f.inserts).toHaveLength(1);
    vi.useRealTimers();
  });

  it("lost REQUEST: confirmed absent, so it replays and succeeds", async () => {
    vi.useFakeTimers();
    const f = fakeClient({
      insertResults: [{ error: TRANSPORT }, { data: row("second-try") }],
      lookup: { data: null, error: null },
    });
    const promise = f.service.createMessage(USER, SESSION, INPUT);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ id: "second-try" });
    expect(f.inserts).toHaveLength(2);
    // Both attempts must carry the SAME id, or the lookup was pointless.
    expect(f.inserts[0]!.id).toBe(f.inserts[1]!.id);
    vi.useRealTimers();
  });

  it("★ lookup itself failed: refuses to guess, does not insert again", async () => {
    vi.useFakeTimers();
    const f = fakeClient({
      insertResults: [{ error: TRANSPORT }],
      lookup: { data: null, error: TRANSPORT },
    });
    const promise = f.service.createMessage(USER, SESSION, INPUT);
    const settled = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await settled;
    // Losing one message is recoverable (the user re-asks); two identical replies in
    // the transcript are not. So when we cannot tell, we do not write.
    expect(f.inserts).toHaveLength(1);
    vi.useRealTimers();
  });

  it("a real database answer is NOT retried and NOT looked up", async () => {
    const f = fakeClient({ insertResults: [{ error: PG_DENIED }] });
    await expect(
      f.service.createMessage(USER, SESSION, INPUT),
    ).rejects.toThrow();
    expect(f.inserts).toHaveLength(1);
    expect(f.lookupCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// X-52 (工单14 T2): a chat row persists IDENTITY, and re-signs on read.
//
// A signed URL lives about an hour and a chat row lives as long as the
// conversation, so storing the URL is how history fills up with dead image
// links the server can no longer repair. The write keeps
// assetId/objectPath/mimeType/source; the read mints a fresh url for the caller
// and, when it cannot, returns the block WITHOUT one rather than falling back to
// whatever URL the row happened to contain.
// ---------------------------------------------------------------------------

const SIGNED = "https://proj.test/storage/v1/object/sign/project-assets/ws/a.png?token=fresh";
const STALE = "https://proj.test/storage/v1/object/sign/project-assets/ws/a.png?token=stale";

type ReadHarness = {
  service: ReturnType<typeof createChatService>;
  inserts: Array<Record<string, unknown>>;
  calls: RepositoryCalls;
  writeCalls: WriteCalls;
  logs: string[];
  lookupCount: () => number;
  touchCount: () => number;
};

/**
 * A fake for the READ path: the message history and the asset identities come
 * from the chat read repository (workorder 20D), the three chat writes from the
 * write repository (workorder 21B), while the storage signing still goes through
 * the user client.
 */
function fakeReadClient(options: {
  rows: Array<Record<string, unknown>>;
  /** Session-list rows or failure, for the `listSessions` cases. */
  sessions?: { rows: ChatSessionReadRow[] | null; error?: unknown };
  /** Message-history rows or failure; overrides `rows` when given. */
  messages?: { rows: ChatMessageReadRow[] | null; error?: unknown };
  /** Set when the message read itself fails. */
  messagesError?: unknown;
  assets?: ChatAssetReadRow[];
  assetError?: unknown;
  /** Object paths the storage API refuses to sign. */
  unsignable?: ReadonlySet<string>;
  /** Result of the session touch; defaults to one affected row. */
  touch?: { affectedRows?: number; error?: unknown };
}): ReadHarness {
  const logs: string[] = [];

  const client = {
    // Workorder 21B: the create path may not reach a table through the user's own
    // client any more (see `fakeClient`).
    from: (table: string) => {
      throw new Error(
        `${table} must not be reached through the user client (21B: writes and reads both have repositories)`,
      );
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string) => {
          if (options.unsignable?.has(path)) {
            return { data: null, error: { message: "permission denied" } };
          }
          return { data: { signedUrl: `${SIGNED}&bucket=${bucket}&path=${path}` }, error: null };
        },
      }),
    },
  };

  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });

  const { repository, calls } = repositoryStub({
    ...(options.sessions ? { sessions: options.sessions } : {}),
    messages: options.messages ?? {
      rows: options.rows as unknown as ChatMessageReadRow[],
      ...(options.messagesError ? { error: options.messagesError } : {}),
    },
    assets: options.assets ?? [],
    ...(options.assetError ? { assetError: options.assetError } : {}),
  });
  // The insert answers with the row the caller asked to store, which is what
  // PostgREST's `RETURNING` did — so the response is built from the STORED
  // (identity-only) blocks, never from anything the test handed in.
  const { repository: chatWriteRepository, calls: writeCalls } = writeRepositoryStub({
    insertResults: [],
    echo: true,
    ...(options.touch ? { touch: options.touch } : {}),
  });
  const { repository: chatSessionWriteRepository } = sessionWriteRepositoryStub();

  const service = createChatService({
    createUserClient: () => client as never,
    chatReadRepository: repository,
    chatWriteRepository,
    chatSessionWriteRepository,
    threadService: { createThreadId: () => "th" },
  });

  return {
    service,
    inserts: writeCalls.inserts,
    calls,
    writeCalls,
    logs,
    lookupCount: () => writeCalls.lookups.length,
    touchCount: () => writeCalls.touches.length,
    // Restore in the test itself so the spy does not leak between cases.
    ...({ restore: () => spy.mockRestore() } as object),
  } as ReadHarness;
}

function rowWithBlocks(blocks: unknown): Record<string, unknown> {
  return {
    id: "msg-1",
    role: "assistant",
    content: "hi",
    tool_activities: null,
    content_blocks: blocks,
    created_at: "2026-10-12T00:00:00.000Z",
  };
}

describe("createMessage persists stable identity only (X-52)", () => {
  it("case 1: an image block is written without url or thumbnailUrl", async () => {
    const f = fakeClient({ insertResults: [{ data: row("m1") }] });
    await f.service.createMessage(USER, SESSION, {
      role: "user",
      content: "look",
      contentBlocks: [
        {
          type: "image",
          assetId: "asset-1",
          objectPath: "ws-team/p/a.png",
          mimeType: "image/png",
          source: "upload",
          url: SIGNED,
          thumbnailUrl: SIGNED,
          name: "a.png",
        },
      ],
    } as never);

    const stored = f.inserts[0]?.content_blocks as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      type: "image",
      assetId: "asset-1",
      objectPath: "ws-team/p/a.png",
      mimeType: "image/png",
      source: "upload",
      name: "a.png",
    });
    expect(stored[0]).not.toHaveProperty("url");
    expect(stored[0]).not.toHaveProperty("thumbnailUrl");
  });

  it("case 2: a data: block is still refused outright", async () => {
    const f = fakeClient({ insertResults: [{ data: row("m1") }] });
    await f.service.createMessage(USER, SESSION, {
      role: "user",
      content: "look",
      contentBlocks: [
        { type: "image", assetId: "asset-1", url: `data:image/png;base64,${"A".repeat(64)}` },
      ],
    } as never);

    const stored = f.inserts[0]?.content_blocks as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(0);
  });
});

describe("listMessages re-signs assets for the caller (X-52)", () => {
  it("case 1: a stored block with no url gets a freshly signed one", async () => {
    const harness = fakeReadClient({
      rows: [
        rowWithBlocks([
          {
            type: "image",
            assetId: "asset-1",
            objectPath: "ws-team/p/a.png",
            mimeType: "image/png",
            source: "upload",
          },
        ]),
      ],
      assets: [{ id: "asset-1", object_path: "ws-team/p/a.png", bucket: "project-assets" }],
    });

    const messages = await harness.service.listMessages(USER, SESSION);
    const blocks = messages[0]?.contentBlocks as Array<Record<string, unknown>>;

    expect(blocks[0]?.assetId).toBe("asset-1");
    expect(String(blocks[0]?.url)).toContain("token=fresh");
  });

  it("case 2: an unsignable asset yields a block with NO url, never the old one", async () => {
    const harness = fakeReadClient({
      rows: [
        rowWithBlocks([
          {
            type: "image",
            assetId: "asset-locked",
            objectPath: "ws-team/p/secret.png",
            mimeType: "image/png",
            source: "upload",
            // A stale url is NOT a fallback: it is a token that used to work.
            url: STALE,
          },
        ]),
      ],
      assets: [
        { id: "asset-locked", object_path: "ws-team/p/secret.png", bucket: "project-assets" },
      ],
      unsignable: new Set(["ws-team/p/secret.png"]),
    });

    const messages = await harness.service.listMessages(USER, SESSION);
    const blocks = messages[0]?.contentBlocks as Array<Record<string, unknown>>;

    // The block survives with its identity, and with NO url at all: the stale
    // one was removed rather than re-served.
    expect(blocks[0]?.assetId).toBe("asset-locked");
    expect(blocks[0]?.url).toBeUndefined();
    expect(blocks[0]?.thumbnailUrl).toBeUndefined();
    expect(JSON.stringify(blocks)).not.toContain("token=stale");
  });

  it("case 3: an asset the caller cannot read is dropped from the projection", async () => {
    const harness = fakeReadClient({
      rows: [
        rowWithBlocks([
          {
            type: "image",
            assetId: "asset-other",
            objectPath: "ws-team/p/other.png",
            mimeType: "image/png",
            source: "upload",
          },
        ]),
      ],
      // RLS answered with none of the requested rows.
      assets: [],
    });

    const messages = await harness.service.listMessages(USER, SESSION);
    const blocks = messages[0]?.contentBlocks as Array<Record<string, unknown>>;

    expect(blocks[0]?.assetId).toBe("asset-other");
    expect(blocks[0]?.url).toBeUndefined();
  });

  it("case 4: a lookup failure returns the blocks without urls, and logs no url", async () => {
    const harness = fakeReadClient({
      rows: [
        rowWithBlocks([
          { type: "image", assetId: "asset-1", objectPath: "ws-team/p/a.png", mimeType: "image/png" },
        ]),
      ],
      assetError: new ChatReadError(
        LIST_READABLE_SESSION_ASSETS,
        new Error("statement timeout"),
      ),
    });

    const messages = await harness.service.listMessages(USER, SESSION);
    const blocks = messages[0]?.contentBlocks as Array<Record<string, unknown>>;

    expect(blocks[0]?.url).toBeUndefined();
    // The reason is logged — the repository's fixed operation name — and the URL
    // never is (a signed URL is a bearer token).
    expect(harness.logs.join("\n")).toContain("asset lookup failed");
    expect(harness.logs.join("\n")).toContain(LIST_READABLE_SESSION_ASSETS);
    expect(harness.logs.join("\n")).not.toContain("token=");
  });

  it("case 5: a url-less list response parses — no-URL is a legal shape, not a 500", async () => {
    const harness = fakeReadClient({
      rows: [
        rowWithBlocks([
          {
            type: "image",
            assetId: "asset-locked",
            objectPath: "ws-team/p/secret.png",
            mimeType: "image/png",
            source: "upload",
          },
        ]),
      ],
      assets: [
        { id: "asset-locked", object_path: "ws-team/p/secret.png", bucket: "project-assets" },
      ],
      unsignable: new Set(["ws-team/p/secret.png"]),
    });

    const messages = await harness.service.listMessages(USER, SESSION);

    // The route parses exactly this payload before answering.
    const parsed = messageListResponseSchema.parse({ messages });
    const block = parsed.messages[0]?.contentBlocks?.[0] as Record<string, unknown>;

    expect(block.type).toBe("image");
    expect(block.assetId).toBe("asset-locked");
    expect(block.url).toBeUndefined();
    // The stored identity survives the parse rather than being stripped, so a
    // client can still tell WHICH asset could not be projected.
    expect(block.objectPath).toBe("ws-team/p/secret.png");
    expect(block.source).toBe("upload");
  });
});

// ---------------------------------------------------------------------------
// X-52 (工单14 fixup T2): the CREATE response goes through the same projection.
//
// The row is written with stable identity only, so echoing it back handed the
// client an image block with no url — a shape the response schema used to
// reject, which turned a successful write into a 500 on the way out. The fix is
// to project a url for this caller before answering; a signing failure is still
// a legal answer (identity, no url), never a failure.
// ---------------------------------------------------------------------------
describe("createMessage projects urls for this caller (X-52 T2)", () => {
  const REQUEST_URL = "https://proj.test/storage/v1/object/sign/project-assets/ws/a.png?token=from-the-request";

  /** A user message carrying one image block, as the composer sends it. */
  const IMAGE_INPUT = (assetId: string, objectPath: string) =>
    ({
      role: "user",
      content: "look",
      contentBlocks: [
        {
          type: "image",
          assetId,
          objectPath,
          mimeType: "image/png",
          source: "upload",
          url: REQUEST_URL,
        },
      ],
    }) as never;

  it("case 1: the response carries a freshly signed url, and never the request's", async () => {
    // `fakeReadClient` echoes the inserted row back, which is exactly what
    // PostgREST does — so the response is built from the STORED (identity-only)
    // blocks, not from anything the test handed in.
    const f = fakeReadClient({
      rows: [],
      assets: [{ id: "asset-1", object_path: "ws-team/p/a.png", bucket: "project-assets" }],
    });

    const message = await f.service.createMessage(
      USER,
      SESSION,
      IMAGE_INPUT("asset-1", "ws-team/p/a.png"),
    );

    // What was WRITTEN keeps identity only.
    const stored = f.inserts[0]?.content_blocks as Array<Record<string, unknown>>;
    expect(stored[0]).not.toHaveProperty("url");
    expect(stored[0]).toMatchObject({ assetId: "asset-1", objectPath: "ws-team/p/a.png" });

    // What was RETURNED carries a url the server minted FOR THIS CALLER. It is
    // not the request's url echoed back: re-serving a caller-supplied projection
    // is the "回退旧URL" the ticket forbids.
    const blocks = message.contentBlocks as Array<Record<string, unknown>>;
    expect(blocks[0]?.assetId).toBe("asset-1");
    expect(String(blocks[0]?.url)).toContain("token=fresh");
    expect(JSON.stringify(blocks)).not.toContain("from-the-request");

    // And the route's own schema accepts it.
    expect(() => messageCreateResponseSchema.parse({ message })).not.toThrow();
  });

  it("case 2: a signing failure returns a stable block with NO url, and the CREATE schema parses it", async () => {
    const f = fakeReadClient({
      rows: [],
      assets: [
        { id: "asset-locked", object_path: "ws-team/p/secret.png", bucket: "project-assets" },
      ],
      unsignable: new Set(["ws-team/p/secret.png"]),
    });

    const message = await f.service.createMessage(
      USER,
      SESSION,
      IMAGE_INPUT("asset-locked", "ws-team/p/secret.png"),
    );

    const blocks = message.contentBlocks as Array<Record<string, unknown>>;
    expect(blocks[0]?.assetId).toBe("asset-locked");
    expect(blocks[0]?.url).toBeUndefined();
    expect(JSON.stringify(blocks)).not.toContain("from-the-request");

    // THE assertion of this block: the create response the route sends parses,
    // so a signature that could not be minted is a display limitation rather
    // than a 500 on a write that already succeeded.
    const parsed = messageCreateResponseSchema.parse({ message });
    const parsedBlock = parsed.message.contentBlocks?.[0] as Record<string, unknown>;
    expect(parsedBlock.assetId).toBe("asset-locked");
    expect(parsedBlock.url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// X-52 (工单14 fixup2): the SAME projection rule, one level down — a tool
// block's artifacts.
//
// fixup T2 closed this for `image` blocks; a tool block's `artifacts` carry the
// identical identity/projection split, and `projectBlockUrls()` already strips
// and re-signs them. But `toolArtifactSchema` still required `url`, so the
// url-less artifact the projection deliberately produces failed the response
// parse — a 500 on a state the server had just built on purpose. These cases
// pin both reads (list and create) and both media types, ending in the parse
// the route itself performs.
// ---------------------------------------------------------------------------
describe("tool block artifacts without a projection (X-52 fixup2)", () => {
  const TOOL_STALE =
    "https://proj.test/storage/v1/object/sign/project-assets/ws-team/p/secret.png?token=stale";

  function toolBlock(artifacts: unknown[]): Record<string, unknown> {
    return {
      type: "tool",
      toolCallId: "call-1",
      toolName: "generate_image",
      status: "completed",
      artifacts,
    };
  }

  function firstArtifact(blocks: unknown): Record<string, unknown> {
    const list = blocks as Array<Record<string, unknown>>;
    const artifacts = list[0]?.artifacts as Array<Record<string, unknown>>;
    return artifacts[0] as Record<string, unknown>;
  }

  const LOCKED_IMAGE = {
    type: "image",
    assetId: "asset-locked",
    objectPath: "ws-team/p/secret.png",
    mimeType: "image/png",
    width: 512,
    height: 512,
    // A stale url is NOT a fallback: it is a token that used to work.
    url: TOOL_STALE,
  };

  it("case 1: an un-signable image artifact keeps its identity and loses the url", async () => {
    const harness = fakeReadClient({
      rows: [rowWithBlocks([toolBlock([LOCKED_IMAGE])])],
      assets: [
        { id: "asset-locked", object_path: "ws-team/p/secret.png", bucket: "project-assets" },
      ],
      unsignable: new Set(["ws-team/p/secret.png"]),
    });

    const messages = await harness.service.listMessages(USER, SESSION);
    const artifact = firstArtifact(messages[0]?.contentBlocks);

    expect(artifact.assetId).toBe("asset-locked");
    expect(artifact.objectPath).toBe("ws-team/p/secret.png");
    expect(artifact.url).toBeUndefined();
    expect(JSON.stringify(messages)).not.toContain("token=stale");

    // The parse the route performs before answering.
    const parsed = messageListResponseSchema.parse({ messages });
    const parsedArtifact = firstArtifact(
      parsed.messages[0]?.contentBlocks,
    );
    expect(parsedArtifact.assetId).toBe("asset-locked");
    expect(parsedArtifact.url).toBeUndefined();
  });

  it("case 2: an un-signable VIDEO artifact behaves the same way", async () => {
    const harness = fakeReadClient({
      rows: [
        rowWithBlocks([
          {
            ...toolBlock([
              {
                type: "video",
                assetId: "asset-locked-video",
                objectPath: "ws-team/p/secret.mp4",
                mimeType: "video/mp4",
                width: 1280,
                height: 720,
                durationSeconds: 5,
              },
            ]),
            toolName: "generate_video",
          },
        ]),
      ],
      assets: [
        {
          id: "asset-locked-video",
          object_path: "ws-team/p/secret.mp4",
          bucket: "project-assets",
        },
      ],
      unsignable: new Set(["ws-team/p/secret.mp4"]),
    });

    const messages = await harness.service.listMessages(USER, SESSION);
    const artifact = firstArtifact(messages[0]?.contentBlocks);

    expect(artifact.type).toBe("video");
    expect(artifact.assetId).toBe("asset-locked-video");
    expect(artifact.url).toBeUndefined();

    const parsed = messageListResponseSchema.parse({ messages });
    const parsedArtifact = firstArtifact(parsed.messages[0]?.contentBlocks);
    expect(parsedArtifact.type).toBe("video");
    expect(parsedArtifact.assetId).toBe("asset-locked-video");
    expect(parsedArtifact.url).toBeUndefined();
  });

  it("case 3: a signable artifact still gets a freshly signed url (behaviour unchanged)", async () => {
    const harness = fakeReadClient({
      rows: [
        rowWithBlocks([
          { ...toolBlock([{ ...LOCKED_IMAGE, assetId: "asset-1", objectPath: "ws-team/p/a.png" }]) },
        ]),
      ],
      assets: [{ id: "asset-1", object_path: "ws-team/p/a.png", bucket: "project-assets" }],
    });

    const messages = await harness.service.listMessages(USER, SESSION);
    const artifact = firstArtifact(messages[0]?.contentBlocks);

    expect(artifact.assetId).toBe("asset-1");
    expect(String(artifact.url)).toContain("token=fresh");
    expect(messageListResponseSchema.parse({ messages })).toBeDefined();
  });

  it("case 4: the CREATE response parses for a url-less stable tool artifact", async () => {
    // `fakeReadClient` echoes the inserted row back, exactly like PostgREST, so
    // the response is built from the STORED (identity-only) artifacts — the same
    // path the create route parses before answering.
    const f = fakeReadClient({
      rows: [],
      assets: [
        { id: "asset-locked", object_path: "ws-team/p/secret.png", bucket: "project-assets" },
      ],
      unsignable: new Set(["ws-team/p/secret.png"]),
    });

    const message = await f.service.createMessage(USER, SESSION, {
      role: "assistant",
      content: "here it is",
      contentBlocks: [toolBlock([LOCKED_IMAGE])],
    } as never);

    // What was WRITTEN keeps identity only — the request's url is not persisted.
    const stored = f.inserts[0]?.content_blocks as Array<Record<string, unknown>>;
    const storedArtifact = firstArtifact(stored);
    expect(storedArtifact).not.toHaveProperty("url");
    expect(storedArtifact.assetId).toBe("asset-locked");

    // What was RETURNED is the stable artifact with no url, and it parses.
    const artifact = firstArtifact(message.contentBlocks);
    expect(artifact.assetId).toBe("asset-locked");
    expect(artifact.objectPath).toBe("ws-team/p/secret.png");
    expect(artifact.url).toBeUndefined();
    expect(JSON.stringify(message.contentBlocks)).not.toContain("token=stale");

    const parsed = messageCreateResponseSchema.parse({ message });
    expect(firstArtifact(parsed.message.contentBlocks).assetId).toBe(
      "asset-locked",
    );
    expect(firstArtifact(parsed.message.contentBlocks).url).toBeUndefined();
  });

  it("case 5: a URL-less, identity-less tool artifact is still refused by the contract", () => {
    // The boundary the server must keep even now that `url` is optional.
    const message = {
      id: "message-1",
      role: "assistant" as const,
      content: "x",
      contentBlocks: [
        toolBlock([{ type: "image", mimeType: "image/png", width: 512, height: 512 }]),
      ],
      createdAt: "2026-10-12T00:00:00.000Z",
    };

    expect(messageListResponseSchema.safeParse({ messages: [message] }).success).toBe(false);
    expect(messageCreateResponseSchema.safeParse({ message }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ADR-0001 / 工单20D: the two chat READS (session list, message history) and the
// asset-identity read behind the media projection move to the pure `pg`
// repository. These cases pin what the caller must do with each repository
// answer, because the two "empty" answers are not the same answer:
//
//   * `null` — no canvas/session the caller may read: 404, and no audit runs;
//   * `[]`   — a readable parent whose children are genuinely absent: 200.
//
// A repository failure is never a 404 and never a broken write: it is the
// existing fixed 500 for the lists, and for the asset read it is a safe
// degradation (identity kept, url dropped, no fallback to the stale url).
// ---------------------------------------------------------------------------
describe("chat-service reads through the repository (20D)", () => {
  const CANVAS = "canvas-1";

  it("case 1: listSessions passes the REAL actor and canvas ids and maps the rows", async () => {
    const harness = fakeReadClient({
      rows: [],
      sessions: {
        rows: [
          sessionRow("s-new", "Newest", "2026-03-02T00:00:00.000Z"),
          sessionRow("s-old", "Older", "2026-03-01T00:00:00.000Z"),
        ],
      },
    });

    const sessions = await harness.service.listSessions(USER, CANVAS);

    expect(harness.calls.sessions).toEqual([
      { actorId: "u1", canvasId: CANVAS },
    ]);
    expect(sessions).toEqual([
      { id: "s-new", title: "Newest", updatedAt: "2026-03-02T00:00:00.000Z" },
      { id: "s-old", title: "Older", updatedAt: "2026-03-01T00:00:00.000Z" },
    ]);
  });

  it("case 2: listSessions turns an unreadable canvas into the existing 404", async () => {
    const harness = fakeReadClient({ rows: [], sessions: { rows: null } });

    const error = await harness.service
      .listSessions(USER, CANVAS)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).code).toBe("session_not_found");
    expect((error as ChatServiceError).statusCode).toBe(404);
    expect((error as ChatServiceError).message).toBe("Canvas not found.");
  });

  it("case 3: listSessions keeps [] legal and a repository failure a fixed 500", async () => {
    const empty = fakeReadClient({ rows: [], sessions: { rows: [] } });
    await expect(empty.service.listSessions(USER, CANVAS)).resolves.toEqual([]);

    const failing = fakeReadClient({
      rows: [],
      sessions: { rows: null, error: new Error("connect ECONNREFUSED") },
    });
    const error = await failing.service
      .listSessions(USER, CANVAS)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).code).toBe("chat_error");
    expect((error as ChatServiceError).statusCode).toBe(500);
    expect((error as ChatServiceError).message).toBe("Failed to list sessions.");
    // The driver's own text never reaches the caller.
    expect((error as ChatServiceError).message).not.toContain("ECONNREFUSED");
  });

  it("case 4: listMessages passes the REAL actor and session ids, keeps order, synthesis and the dedupe", async () => {
    const harness = fakeReadClient({
      rows: [
        messageRow("m1", {
          role: "user",
          content: "legacy",
          content_blocks: null,
          tool_activities: null,
          created_at: "2026-03-01T00:00:00.000Z",
        }),
        messageRow("m2", {
          role: "assistant",
          content: "same",
          created_at: "2026-03-02T00:00:00.000Z",
        }),
        messageRow("m3", {
          role: "assistant",
          content: "same",
          created_at: "2026-03-03T00:00:00.000Z",
        }),
      ],
    });

    const messages = await harness.service.listMessages(USER, SESSION);

    expect(harness.calls.messages).toEqual([
      { actorId: "u1", sessionId: SESSION },
    ]);
    // Oldest first, exactly as the statement returned them.
    expect(messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    // A null `content_blocks` still becomes the legacy text block.
    expect(messages[0]?.contentBlocks).toEqual([
      { type: "text", text: "legacy" },
    ]);
  });

  it("case 5: listMessages turns an unreadable session into 404, a failure into the fixed 500", async () => {
    const missing = fakeReadClient({ rows: [], messages: { rows: null } });
    const missingError = await missing.service
      .listMessages(USER, SESSION)
      .catch((reason: unknown) => reason);

    expect(missingError).toBeInstanceOf(ChatServiceError);
    expect((missingError as ChatServiceError).code).toBe("session_not_found");
    expect((missingError as ChatServiceError).statusCode).toBe(404);
    expect((missingError as ChatServiceError).message).toBe("Session not found.");

    const failing = fakeReadClient({
      rows: [],
      messagesError: new Error("invalid input syntax for type uuid"),
    });
    const failingError = await failing.service
      .listMessages(USER, SESSION)
      .catch((reason: unknown) => reason);

    expect(failingError).toBeInstanceOf(ChatServiceError);
    expect((failingError as ChatServiceError).code).toBe("chat_error");
    expect((failingError as ChatServiceError).statusCode).toBe(500);
    expect((failingError as ChatServiceError).message).toBe(
      "Failed to list messages.",
    );
  });

  it("case 6: a readable session with no messages is [] and touches no asset read", async () => {
    const harness = fakeReadClient({ rows: [], messages: { rows: [] } });

    await expect(harness.service.listMessages(USER, SESSION)).resolves.toEqual([]);
    expect(harness.calls.assets).toEqual([]);
  });

  it("case 7: a failing asset read neither breaks the list nor the successful write", async () => {
    const failingAssets = () =>
      new ChatReadError(LIST_READABLE_SESSION_ASSETS, new Error("statement timeout"));

    const list = fakeReadClient({
      rows: [
        messageRow("m1", {
          content_blocks: [
            {
              type: "image",
              assetId: "asset-1",
              objectPath: "ws-team/p/a.png",
              mimeType: "image/png",
              source: "upload",
              url: STALE,
            },
          ],
        }),
      ],
      assetError: failingAssets(),
    });

    const messages = await list.service.listMessages(USER, SESSION);
    const blocks = messages[0]?.contentBlocks as Array<Record<string, unknown>>;
    expect(blocks[0]?.assetId).toBe("asset-1");
    expect(blocks[0]?.url).toBeUndefined();
    expect(JSON.stringify(messages)).not.toContain("token=stale");

    // The write already succeeded; a read-side asset failure must not turn it
    // into a 500 on the way out.
    const create = fakeReadClient({
      rows: [],
      assets: [],
      assetError: failingAssets(),
    });
    const created = await create.service.createMessage(USER, SESSION, {
      role: "user",
      content: "look",
      contentBlocks: [
        {
          type: "image",
          assetId: "asset-1",
          objectPath: "ws-team/p/a.png",
          mimeType: "image/png",
          source: "upload",
          url: STALE,
        },
      ],
    } as never);

    expect(create.inserts).toHaveLength(1);
    const createdBlocks = created.contentBlocks as Array<Record<string, unknown>>;
    expect(createdBlocks[0]?.assetId).toBe("asset-1");
    expect(createdBlocks[0]?.url).toBeUndefined();
    expect(() => messageCreateResponseSchema.parse({ message: created })).not.toThrow();
  });

  it("case 8: the create response's asset read carries the REAL actor and session", async () => {
    const harness = fakeReadClient({
      rows: [],
      assets: [
        { id: "asset-1", object_path: "ws-team/p/a.png", bucket: "project-assets" },
      ],
    });

    const created = await harness.service.createMessage(USER, SESSION, {
      role: "user",
      content: "look",
      contentBlocks: [
        {
          type: "image",
          assetId: "asset-1",
          objectPath: "ws-team/p/a.png",
          mimeType: "image/png",
          source: "upload",
        },
      ],
    } as never);

    expect(harness.calls.assets).toEqual([
      { actorId: "u1", sessionId: SESSION, assetIds: ["asset-1"] },
    ]);
    const blocks = created.contentBlocks as Array<Record<string, unknown>>;
    expect(String(blocks[0]?.url)).toContain("token=fresh");
    // The write protocol is untouched: exactly one insert, carrying the stored
    // identity only.
    expect(harness.inserts).toHaveLength(1);
    expect(
      (harness.inserts[0]?.content_blocks as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty("url");
  });
});

// ---------------------------------------------------------------------------
// Workorder 21B: the create-message state machine, driven through
// `ChatWriteRepository` instead of PostgREST.
//
// The DECISION is unchanged — insert under a caller-supplied id, and on a
// transport failure look before replaying — but every branch of it now gets its
// evidence from the repository, and two of those branches are the ones the old
// transport could not express:
//
//   * a write ACL that refuses SILENTLY (zero rows, no SQLSTATE) must not look
//     like a transport failure, or the service would wait 400ms and confirm a
//     write that never happened;
//   * a touch that fails or affects zero rows must not turn an already-stored
//     message into a 500 (T-34).
// ---------------------------------------------------------------------------
describe("createMessage write state machine through the repository (21B)", () => {
  it("case 1: a first insert that succeeds touches the session once, for the REAL actor", async () => {
    const f = fakeClient({ insertResults: [{ data: row("m1") }] });

    const message = await f.service.createMessage(USER, SESSION, INPUT);

    expect(message.id).toBe("m1");
    expect(f.inserts).toHaveLength(1);
    expect(f.lookupCount()).toBe(0);
    expect(f.touchCount()).toBe(1);
    expect(f.writeCalls.touches[0]).toMatchObject({
      actorId: "u1",
      sessionId: SESSION,
    });
    // The touch is published as an ISO-8601 timestamp, which is the shape the
    // repository validates before it binds anything.
    const updatedAt = f.writeCalls.touches[0]!.updatedAt;
    expect(new Date(updatedAt).toISOString()).toBe(updatedAt);
  });

  it("case 2: the confirmation read carries the real actor and the same id the insert used", async () => {
    vi.useFakeTimers();
    const f = fakeClient({
      insertResults: [{ error: TRANSPORT }],
      lookup: { data: row("landed") },
    });

    const promise = f.service.createMessage(USER, SESSION, INPUT);
    await vi.runAllTimersAsync();
    const message = await promise;

    expect(f.writeCalls.lookups).toEqual([
      { actorId: "u1", messageId: String(f.inserts[0]!.id) },
    ]);
    // Reusing the landed row is still a successful write: it touches too.
    expect(message.id).toBe("landed");
    expect(f.touchCount()).toBe(1);
    vi.useRealTimers();
  });

  it("case 3: ★ the 400ms wait happens BEFORE the confirmation, never instead of it", async () => {
    vi.useFakeTimers();
    const f = fakeClient({
      insertResults: [{ error: TRANSPORT }],
      lookup: { data: row("landed") },
    });

    const promise = f.service.createMessage(USER, SESSION, INPUT);
    await vi.advanceTimersByTimeAsync(399);
    // Not confirmed yet: the wait is what makes the lost-response case rare
    // rather than a race against the database's own commit.
    expect(f.lookupCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(f.lookupCount()).toBe(1);
    expect(f.inserts).toHaveLength(1);
    vi.useRealTimers();
  });

  it("case 4: ★ a landed row is reused — insert=1, confirm=1, touch=1, never a replay", async () => {
    vi.useFakeTimers();
    const f = fakeClient({
      insertResults: [{ error: TRANSPORT }],
      lookup: { data: row("landed") },
    });

    const promise = f.service.createMessage(USER, SESSION, INPUT);
    await vi.runAllTimersAsync();
    const message = await promise;

    // THE assertion of this file, restated on the repository surface: two
    // inserts here would be two identical assistant replies in the transcript.
    expect(f.inserts).toHaveLength(1);
    expect(f.lookupCount()).toBe(1);
    expect(f.touchCount()).toBe(1);
    expect(message.id).toBe("landed");
    vi.useRealTimers();
  });

  it("case 5: confirmed absent → exactly ONE replay, both payloads carrying the same id", async () => {
    vi.useFakeTimers();
    const f = fakeClient({
      insertResults: [{ error: TRANSPORT }, { data: row("second-try") }],
      lookup: { data: null, error: null },
    });

    const promise = f.service.createMessage(USER, SESSION, INPUT);
    await vi.runAllTimersAsync();
    const message = await promise;

    expect(f.inserts).toHaveLength(2);
    expect(f.lookupCount()).toBe(1);
    // Same id both times, or the confirmation was pointless.
    expect(f.inserts[0]!.id).toBe(f.inserts[1]!.id);
    expect(message.id).toBe("second-try");
    expect(f.touchCount()).toBe(1);
    vi.useRealTimers();
  });

  it("case 6: ★ a replay that fails is not confirmed a second time (at most one replay)", async () => {
    vi.useFakeTimers();
    const f = fakeClient({
      insertResults: [{ error: TRANSPORT }, { error: TRANSPORT }],
      lookup: { data: null, error: null },
    });

    const promise = f.service.createMessage(USER, SESSION, INPUT);
    const settled = expect(promise).rejects.toBeInstanceOf(ChatServiceError);
    await vi.runAllTimersAsync();
    await settled;

    expect(f.inserts).toHaveLength(2);
    // One confirmation for the ONE insert that was in doubt — a second one would
    // mean the replay's fate was being probed too, and a third insert is how a
    // duplicate gets written.
    expect(f.lookupCount()).toBe(1);
    expect(f.touchCount()).toBe(0);
    vi.useRealTimers();
  });

  it("case 7: a confirmation read that fails is never replayed on top of (insert=1, confirm=1, 500)", async () => {
    vi.useFakeTimers();
    const f = fakeClient({
      insertResults: [{ error: TRANSPORT }],
      lookup: { data: null, error: TRANSPORT },
    });

    const promise = f.service.createMessage(USER, SESSION, INPUT);
    const settled = expect(promise).rejects.toBeInstanceOf(ChatServiceError);
    await vi.runAllTimersAsync();
    await settled;

    expect(f.inserts).toHaveLength(1);
    expect(f.lookupCount()).toBe(1);
    expect(f.touchCount()).toBe(0);
    vi.useRealTimers();
  });

  it("case 8: ★ the write ACL's SILENT zero rows is not a transport failure", async () => {
    // The repository answers a refused insert with a `ChatWriteError` that wraps a
    // plain error and carries NO driver code — exactly what "inserted no row"
    // looks like. Misreading that as a transport failure would make the service
    // sleep 400ms and then confirm a write that never happened.
    const f = fakeClient({ insertResults: [] });

    const error = await f.service
      .createMessage(USER, SESSION, INPUT)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).statusCode).toBe(500);
    expect((error as ChatServiceError).message).toBe("Failed to save message.");
    expect(f.inserts).toHaveLength(1);
    expect(f.lookupCount()).toBe(0);
    expect(f.touchCount()).toBe(0);
  });

  it("case 9: a real SQLSTATE is never confirmed and never replayed (insert=1, confirm=0, 500)", async () => {
    // A duplicate primary key: a real answer from PostgreSQL, which would answer
    // the same way again. It fails fast.
    const duplicate = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "chat_messages_pkey"',
    };
    const f = fakeClient({ insertResults: [{ error: duplicate }] });

    const error = await f.service
      .createMessage(USER, SESSION, INPUT)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).statusCode).toBe(500);
    expect((error as ChatServiceError).message).not.toContain("duplicate key");
    expect(f.inserts).toHaveLength(1);
    expect(f.lookupCount()).toBe(0);
    expect(f.touchCount()).toBe(0);
  });

  it("case 10: ★ a 0-row touch does not turn a stored message into an error (T-34)", async () => {
    const f = fakeReadClient({ rows: [], touch: { affectedRows: 0 } });

    const created = await f.service.createMessage(USER, SESSION, {
      role: "user",
      content: "stored anyway",
    } as never);

    // The message is stored and returned; the session row simply was not this
    // actor's to touch.
    expect(created.content).toBe("stored anyway");
    expect(f.inserts).toHaveLength(1);
    expect(f.touchCount()).toBe(1);
    // Zero rows is a legal answer, so it is not reported as a failure either.
    expect(f.logs.join("\n")).not.toContain("touch failed");
    expect(() => messageCreateResponseSchema.parse({ message: created })).not.toThrow();
  });

  it("case 11: ★ a touch that FAILS is swallowed and logged without the driver's text", async () => {
    const f = fakeReadClient({
      rows: [],
      touch: {
        error: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      },
    });

    const created = await f.service.createMessage(USER, SESSION, {
      role: "assistant",
      content: "already stored",
    } as never);

    // The write already succeeded; a touch failure must not undo that.
    expect(created.content).toBe("already stored");
    expect(f.inserts).toHaveLength(1);
    expect(f.logs.join("\n")).toContain("session touch failed");
    expect(f.logs.join("\n")).toContain(TOUCH_SESSION);
    // The driver's own text never reaches a log line — it can embed SQL.
    expect(f.logs.join("\n")).not.toContain("deadlock");
  });

  it("case 12: the projection is unchanged, and the write path performs no Storage write", async () => {
    const f = fakeReadClient({
      rows: [],
      assets: [
        { id: "asset-1", object_path: "ws-team/p/a.png", bucket: "project-assets" },
      ],
    });

    const created = await f.service.createMessage(USER, SESSION, {
      role: "user",
      content: "look",
      contentBlocks: [
        {
          type: "image",
          assetId: "asset-1",
          objectPath: "ws-team/p/a.png",
          mimeType: "image/png",
          source: "upload",
          url: "https://proj.test/storage/v1/object/sign/project-assets/ws/a.png?token=stale",
        },
      ],
    } as never);

    // What was stored keeps identity only: no url, no stale token, no rewrite.
    const stored = f.inserts[0]?.content_blocks as Array<Record<string, unknown>>;
    expect(stored[0]).not.toHaveProperty("url");
    expect(JSON.stringify(stored)).not.toContain("token=");

    // What was returned is this caller's fresh projection, through the same
    // signing path as the list response.
    const blocks = created.contentBlocks as Array<Record<string, unknown>>;
    expect(String(blocks[0]?.url)).toContain("token=fresh");

    // Exactly the three write operations, and nothing else: no extra write, no
    // Storage WRITE of any kind on this path.
    expect(f.inserts).toHaveLength(1);
    expect(f.lookupCount()).toBe(0);
    expect(f.touchCount()).toBe(1);
    expect(messageCreateResponseSchema.parse({ message: created })).toBeDefined();
  });
});

describe("chat session CRUD through the repository (21C)", () => {
  it("case 1: createSession passes the REAL actor and canvas, and maps the row it gets back", async () => {
    const h = sessionService({
      create: { data: sessionWriteRow("s-new", "New Chat", "2026-10-15T00:00:00.000Z") },
    });

    const created = await h.service.createSession(USER, "canvas-1");

    expect(created).toEqual({
      id: "s-new",
      title: "New Chat",
      updatedAt: "2026-10-15T00:00:00.000Z",
    });

    expect(h.calls.creates).toHaveLength(1);
    expect(h.calls.creates[0]).toMatchObject({
      actorId: "u1",
      canvasId: "canvas-1",
    });
    h.restore();
  });

  it("case 2: the thread id is minted by the thread service and stored as handed over", async () => {
    const h = sessionService({ create: { data: sessionWriteRow("s-new", "t", "2026-10-15T00:00:00.000Z") } });

    await h.service.createSession(USER, "canvas-1");

    // The repository stores the value; it never produces one — so the id has to
    // come from `threadService.createThreadId()` exactly once per create.
    expect(h.threadIds()).toBe(1);
    expect(h.calls.creates[0]?.threadId).toBe("thread-1");
    h.restore();
  });

  it("case 3: createdBy is the caller's own id — passed as data, not as authority", async () => {
    const h = sessionService({ create: { data: sessionWriteRow("s-new", "t", "2026-10-15T00:00:00.000Z") } });

    await h.service.createSession(USER, "canvas-1");

    // The write ACL is the PROJECT's author; this column only records who asked.
    expect(h.calls.creates[0]?.createdBy).toBe("u1");
    h.restore();
  });

  it("case 4: a falsy title becomes null, so the schema's DEFAULT decides", async () => {
    const h = sessionService({ create: { data: sessionWriteRow("s-new", "New Chat", "2026-10-15T00:00:00.000Z") } });

    // No title at all, and an empty one: both used to omit the column from the
    // PostgREST insert (`...(title ? {title} : {})`), and `null` is the value
    // that keeps that meaning in the repository.
    await h.service.createSession(USER, "canvas-1");
    await h.service.createSession(USER, "canvas-1", "");
    await h.service.createSession(USER, "canvas-1", "Named");

    expect(h.calls.creates.map((call) => call.title)).toEqual([null, null, "Named"]);
    h.restore();
  });

  it("case 5: a repository failure is the existing 500, and the log carries no driver text", async () => {
    const h = sessionService({
      create: {
        error: Object.assign(new Error('insert into "chat_sessions" failed at db.internal'), {
          code: "42501",
        }),
      },
    });

    const error = await h.service
      .createSession(USER, "canvas-1")
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).statusCode).toBe(500);
    expect((error as ChatServiceError).message).toBe("Failed to create session.");
    expect((error as ChatServiceError).code).toBe("chat_error");

    const logged = h.logs.join("\n");
    expect(logged).toContain("createSession failed");
    expect(logged).toContain(CREATE_SESSION);
    // The driver's message embeds the statement and the host; neither may be logged.
    expect(logged).not.toContain("db.internal");
    expect(logged).not.toContain("chat_sessions");
    h.restore();
  });

  it("case 6: a null title from the repository is not served — the route's schema must never blame the client", async () => {
    const h = sessionService({ create: { data: sessionWriteRow("s-new", null, "2026-10-15T00:00:00.000Z") } });

    const error = await h.service
      .createSession(USER, "canvas-1")
      .catch((reason: unknown) => reason);

    // `ChatSessionSummary.title` is a string, so serving the null would make the
    // route's own response parse fail and surface as a 400 blaming the caller.
    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).statusCode).toBe(500);
    expect((error as ChatServiceError).message).toBe("Failed to create session.");
    expect(h.logs.join("\n")).toContain("returned no title");
    h.restore();
  });

  it("case 7: updateSessionTitle passes the real actor, session and title, and returns nothing", async () => {
    const h = sessionService({ update: { affectedRows: 1 } });

    await expect(
      h.service.updateSessionTitle(USER, "s-1", "Renamed"),
    ).resolves.toBeUndefined();

    expect(h.calls.updates).toEqual([
      { actorId: "u1", sessionId: "s-1", title: "Renamed" },
    ]);
    h.restore();
  });

  it("case 8: ★ a 0-row title update stays a SILENT success (T-34)", async () => {
    const h = sessionService({ update: { affectedRows: 0 } });

    // The session is gone, or this actor may not write it. The old update never
    // inspected its result either, so the count must not become control flow.
    await expect(h.service.updateSessionTitle(USER, "s-1", "x")).resolves.toBeUndefined();
    expect(h.calls.updates).toHaveLength(1);
    expect(h.logs.join("\n")).not.toContain("updateSessionTitle failed");
    h.restore();
  });

  it("case 9: an update failure keeps the existing 500 text and the fixed operation name", async () => {
    const h = sessionService({
      update: { error: Object.assign(new Error("deadlock detected"), { code: "40P01" }) },
    });

    const error = await h.service
      .updateSessionTitle(USER, "s-1", "x")
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).statusCode).toBe(500);
    expect((error as ChatServiceError).message).toBe("Failed to update session title.");
    expect(h.logs.join("\n")).toContain(UPDATE_SESSION_TITLE);
    expect(h.logs.join("\n")).not.toContain("deadlock");
    h.restore();
  });

  it("case 10: deleteSession passes the real actor and session, and a 0-row delete is silent", async () => {
    const h = sessionService({ delete: { affectedRows: 0 } });

    await expect(h.service.deleteSession(USER, "s-1")).resolves.toBeUndefined();

    expect(h.calls.deletes).toEqual([{ actorId: "u1", sessionId: "s-1" }]);
    expect(h.logs.join("\n")).not.toContain("deleteSession failed");
    h.restore();
  });

  it("case 11: a delete failure keeps the EXISTING 404 wording and status", async () => {
    const h = sessionService({
      delete: { error: Object.assign(new Error("connection terminated"), { code: "" }) },
    });

    const error = await h.service
      .deleteSession(USER, "s-1")
      .catch((reason: unknown) => reason);

    // The route's contract is unchanged by the migration: same code, same text,
    // same status — nothing new is enumerable through the endpoint.
    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).code).toBe("session_not_found");
    expect((error as ChatServiceError).statusCode).toBe(404);
    expect((error as ChatServiceError).message).toBe("Session not found.");
    expect(h.logs.join("\n")).toContain(DELETE_SESSION);
    expect(h.logs.join("\n")).not.toContain("connection terminated");
    h.restore();
  });

  it("case 12: no session write reaches the caller's PostgREST client — there is no fallback", async () => {
    // `sessionService` builds `createUserClient` to THROW, so all three calls
    // below would fail if any of them still went out through the user client.
    const h = sessionService({
      create: { data: sessionWriteRow("s-new", "New Chat", "2026-10-15T00:00:00.000Z") },
    });

    await h.service.createSession(USER, "canvas-1");
    await h.service.updateSessionTitle(USER, "s-1", "Renamed");
    await h.service.deleteSession(USER, "s-1");

    expect(h.calls.creates).toHaveLength(1);
    expect(h.calls.updates).toHaveLength(1);
    expect(h.calls.deletes).toHaveLength(1);
    h.restore();
  });
});
