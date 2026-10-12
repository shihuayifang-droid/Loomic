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
import { describe, expect, it, vi } from "vitest";

import {
  messageCreateResponseSchema,
  messageListResponseSchema,
} from "@loomic/shared";

import { createChatService } from "./chat-service.js";

const USER = { accessToken: "t", id: "u1" } as never;
const SESSION = "s1";
const INPUT = { content: "hello", role: "assistant" } as never;

const TRANSPORT = { code: "", message: "TypeError: fetch failed" };
const PG_DENIED = {
  code: "42501",
  message: "new row violates row-level security policy",
};

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
 * A fake `chat_messages` table that records every insert and lets each test script
 * what the driver returns.
 *
 * `inserts` is the thing under test: its LENGTH is how a duplicate would show up.
 */
function fakeClient(script: {
  insertResults: Array<{ data?: unknown; error?: unknown }>;
  /** Result of the "did it land?" lookup, when one happens. */
  lookup?: { data?: unknown; error?: unknown };
  /**
   * Rows the caller may read from `asset_objects` (工单14 fixup T2: the create
   * response is projected through the same signing path as the list response).
   */
  assets?: Array<{ id: string; object_path: string; bucket: string }>;
  /** Object paths the storage API refuses to sign. */
  unsignable?: ReadonlySet<string>;
}) {
  const inserts: Array<Record<string, unknown>> = [];
  let lookups = 0;
  let insertCalls = 0;

  const client = {
    from: (table: string) => {
      if (table === "asset_objects") {
        return {
          select: () => ({
            in: async () => ({ data: script.assets ?? [], error: null }),
          }),
        };
      }
      if (table !== "chat_messages") {
        // chat_sessions updated_at touch — irrelevant here, must not blow up.
        return { update: () => ({ eq: async () => ({ error: null }) }) };
      }
      return {
        insert: (values: Record<string, unknown>) => {
          inserts.push(values);
          const result =
            script.insertResults[
              Math.min(insertCalls, script.insertResults.length - 1)
            ];
          insertCalls++;
          return {
            select: () => ({
              single: async () => ({
                data: result?.data ?? null,
                error: result?.error ?? null,
              }),
            }),
          };
        },
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              lookups++;
              return {
                data: script.lookup?.data ?? null,
                error: script.lookup?.error ?? null,
              };
            },
          }),
        }),
      };
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

  return {
    service: createChatService({
      createUserClient: () => client as never,
      threadService: { createThreadId: () => "th" },
    }),
    inserts,
    lookupCount: () => lookups,
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
  logs: string[];
};

/**
 * A fake client for the READ path: `chat_messages` returns the given rows and
 * `asset_objects` returns the given assets (or an error).
 */
function fakeReadClient(options: {
  rows: Array<Record<string, unknown>>;
  assets?: Array<{ id: string; object_path: string; bucket: string }>;
  assetError?: { code?: string; message: string } | null;
  /** Object paths the storage API refuses to sign. */
  unsignable?: ReadonlySet<string>;
  inserts?: Array<Record<string, unknown>>;
}): ReadHarness {
  const inserts = options.inserts ?? [];
  const logs: string[] = [];

  const client = {
    from: (table: string) => {
      if (table === "asset_objects") {
        return {
          select: () => ({
            in: async () => ({
              data: options.assetError ? null : (options.assets ?? []),
              error: options.assetError ?? null,
            }),
          }),
        };
      }
      if (table === "chat_sessions") {
        return { update: () => ({ eq: async () => ({ error: null }) }) };
      }
      return {
        insert: (values: Record<string, unknown>) => {
          inserts.push(values);
          return {
            select: () => ({
              single: async () => ({
                data: { ...row("m1"), ...values },
                error: null,
              }),
            }),
          };
        },
        select: () => ({
          eq: () => ({
            order: async () => ({ data: options.rows, error: null }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
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

  const service = createChatService({
    createUserClient: () => client as never,
    threadService: { createThreadId: () => "th" },
  });

  return {
    service,
    inserts,
    logs,
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
      assetError: { code: "57014", message: "statement timeout" },
    });

    const messages = await harness.service.listMessages(USER, SESSION);
    const blocks = messages[0]?.contentBlocks as Array<Record<string, unknown>>;

    expect(blocks[0]?.url).toBeUndefined();
    // The reason is logged; the URL never is (a signed URL is a bearer token).
    expect(harness.logs.join("\n")).toContain("asset lookup failed");
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
