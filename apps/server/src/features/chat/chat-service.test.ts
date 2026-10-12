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
}) {
  const inserts: Array<Record<string, unknown>> = [];
  let lookups = 0;
  let insertCalls = 0;

  const client = {
    from: (table: string) => {
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
});
