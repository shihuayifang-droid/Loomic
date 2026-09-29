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
