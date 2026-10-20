// What this file is defending
//
// A canvas read used to answer 404 for BOTH "no such row" and "the database did
// not answer". In production that meant a five-second proxy stall reached the
// user as a red "Failed to load canvas." — an infrastructure blip impersonating
// data loss, on a product whose history includes actually losing canvas content.
//
// The distinction is invisible in a type signature and cheap to undo by accident
// (one `.single()` instead of `.maybeSingle()` puts it straight back, because
// PostgREST reports "0 rows" as an ERROR). So it is pinned here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasContent } from "@loomic/shared";

import { isTransportFailure } from "../../supabase/transport-retry.js";
import {
  CanvasNotFoundError,
  CanvasUnavailableError,
  CanvasVersionConflictError,
  mutateCanvasContent,
  readCanvasRow,
  readCanvasSnapshot,
  replaceCanvasContent,
} from "./canvas-version.js";

/**
 * A client whose read returns each queued result in turn.
 *
 * Asserts `.maybeSingle()` is the terminator: if production reverts to
 * `.single()` the fake has no such method and the test fails loudly, instead of
 * quietly passing against an API that reports missing rows as errors.
 */
function fakeClient(
  results: Array<{ data?: unknown; error?: unknown }>,
): { client: { from: (t: string) => any }; calls: () => number } {
  let calls = 0;
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            const next = results[Math.min(calls, results.length - 1)];
            calls++;
            return { data: next?.data ?? null, error: next?.error ?? null };
          },
        }),
      }),
    }),
  };
  return { client, calls: () => calls };
}

const TRANSPORT = { code: "", message: "TypeError: fetch failed" };
const PG_TIMEOUT = {
  code: "57014",
  message: "canceling statement due to statement timeout",
};

describe("readCanvasRow classification", () => {
  it("absent row is not_found", async () => {
    const { client } = fakeClient([{ data: null }]);
    await expect(readCanvasRow(client, "c1", "content")).rejects.toBeInstanceOf(
      CanvasNotFoundError,
    );
  });

  it("driver error is unavailable, NOT not_found", async () => {
    // The whole point. Before the fix this produced CanvasNotFoundError.
    const { client } = fakeClient([{ error: PG_TIMEOUT }]);
    const err = await readCanvasRow(client, "c1", "content").catch((e) => e);
    expect(err).toBeInstanceOf(CanvasUnavailableError);
    expect(err).not.toBeInstanceOf(CanvasNotFoundError);
    expect((err as CanvasUnavailableError).statusCode).toBe(503);
  });

  it("a present row is returned as-is", async () => {
    const { client } = fakeClient([{ data: { content: { elements: [1] } } }]);
    await expect(readCanvasRow(client, "c1", "content")).resolves.toEqual({
      content: { elements: [1] },
    });
  });
});

describe("readCanvasRow retry", () => {
  it("recovers when a transport blip is followed by success", async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient([
      { error: TRANSPORT },
      { data: { content: {}, version: 7 } },
    ]);
    const promise = readCanvasRow(client, "c1", "content, version");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ version: 7 });
    expect(calls()).toBe(2);
    vi.useRealTimers();
  });

  it("does NOT retry an error Postgres actually answered with", async () => {
    // Replaying a statement timeout or an RLS denial just multiplies the wait.
    const { client, calls } = fakeClient([{ error: PG_TIMEOUT }]);
    await expect(
      readCanvasRow(client, "c1", "content"),
    ).rejects.toBeInstanceOf(CanvasUnavailableError);
    expect(calls()).toBe(1);
  });

  it("gives up after a bounded number of transport failures", async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient([{ error: TRANSPORT }]);
    const promise = readCanvasRow(client, "c1", "content");
    const settled = expect(promise).rejects.toBeInstanceOf(
      CanvasUnavailableError,
    );
    await vi.runAllTimersAsync();
    await settled;
    expect(calls()).toBe(3);
    vi.useRealTimers();
  });
});

describe("readCanvasSnapshot", () => {
  it("defaults a null content column instead of throwing", async () => {
    const { client } = fakeClient([{ data: { content: null, version: null } }]);
    await expect(readCanvasSnapshot(client, "c1")).resolves.toEqual({
      content: { elements: [], appState: {}, files: {} },
      version: 0,
    });
  });

  it("propagates the unavailable/not-found distinction", async () => {
    const missing = fakeClient([{ data: null }]);
    await expect(
      readCanvasSnapshot(missing.client, "c1"),
    ).rejects.toBeInstanceOf(CanvasNotFoundError);

    const broken = fakeClient([{ error: PG_TIMEOUT }]);
    await expect(
      readCanvasSnapshot(broken.client, "c1"),
    ).rejects.toBeInstanceOf(CanvasUnavailableError);
  });
});

describe("isTransportFailure", () => {
  // `_retry-predicate.mjs` carries the full table of shapes copied from the
  // server log; these are the two that the read path's behaviour hinges on.
  it("treats an empty-string code as no code", () => {
    // supabase-js was observed setting code to "" on transport failures, so a
    // `code === undefined` check would silently stop retrying.
    expect(isTransportFailure(TRANSPORT)).toBe(true);
  });

  it("refuses anything carrying a pg code", () => {
    expect(isTransportFailure(PG_TIMEOUT)).toBe(false);
  });
});

// CV-03: the two write paths.
//
// The reader above cannot express a version, so the writes were unpinned. What
// is being defended here is not "a write happened" but the two different answers
// to a conflict: the incremental path re-applies on top of the winner, and the
// whole-content path refuses and hands the decision back to the caller. Swap
// them and the original lost-update bug comes back with no failing test.

type Row = { content: CanvasContent; version: number };

/**
 * CV-03: a canvases row with a real version column.
 *
 * The guarded update only matches while the version it was handed is still the
 * row's version, exactly like the SQL predicate, and a non-matching update
 * returns no row rather than an error — that difference is what the production
 * code keys the conflict detection off.
 *
 * `beforeWrite` registers a one-shot callback that runs against the row just
 * before the predicate is evaluated, i.e. in the window between a read and its
 * write. Re-registering from inside the callback makes it persistent.
 */
function versionedCanvas(initial: { content: CanvasContent; version: number }) {
  const row: Row = { content: initial.content, version: initial.version };
  let successes = 0;
  let updates = 0;
  let hook: ((row: Row) => void) | null = null;

  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { content: row.content, version: row.version },
            error: null,
          }),
        }),
      }),
      update: (patch: Row) => ({
        eq: () => ({
          eq: (_column: string, expected: number) => ({
            select: () => ({
              maybeSingle: async () => {
                updates++;
                const concurrent = hook;
                hook = null;
                if (concurrent) concurrent(row);
                if (expected !== row.version) return { data: null, error: null };
                row.content = patch.content;
                row.version = patch.version;
                successes++;
                return { data: { version: patch.version }, error: null };
              },
            }),
          }),
        }),
      }),
    }),
  };

  return {
    client,
    row: () => row,
    writes: () => successes,
    attempts: () => updates,
    beforeWrite: (fn: (row: Row) => void) => {
      hook = fn;
    },
  };
}

const element = (id: string) => ({ id });
const ids = (row: Row) => row.content.elements.map((e) => e.id);
const canvas = (elements: Array<Record<string, unknown>>): CanvasContent => ({
  elements,
  appState: {},
  files: {},
});

describe("CV-03 optimistic concurrency", () => {
  beforeEach(() => {
    // The write paths log every conflict; the assertions are the signal here.
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("CV-03: an incremental write lands on top of a concurrent write instead of erasing it", async () => {
    const A = element("a");
    const B = element("b");
    const C = element("c");

    const db = versionedCanvas({ content: canvas([A]), version: 1 });

    // The other writer's row lands between our read (v1) and our update.
    db.beforeWrite((other) => {
      other.content = canvas([A, B]);
      other.version = 2;
    });

    const result = await mutateCanvasContent(db.client, "c1", (content) => ({
      ...content,
      elements: [...content.elements, C],
    }));

    // v2 was the base we re-applied to, so the result is v3 and contains both
    // writers' work. Before the fix this returned v2 holding [A, C].
    expect(result?.version).toBe(3);
    expect(ids(db.row())).toEqual(["a", "b", "c"]);
    expect(db.attempts()).toBe(2);
    expect(db.writes()).toBe(1);
  });

  it("CV-03: a mutation that returns null writes nothing", async () => {
    const db = versionedCanvas({ content: canvas([element("a")]), version: 1 });

    const result = await mutateCanvasContent(db.client, "c1", () => null);

    expect(result).toBeNull();
    expect(db.attempts()).toBe(0);
    expect(db.writes()).toBe(0);
  });

  it("CV-03: a canvas written continuously gives up with a 409 carrying the current state", async () => {
    const db = versionedCanvas({ content: canvas([element("ours")]), version: 1 });

    // Somebody else wins the race before every single attempt.
    const foreign = (other: Row) => {
      other.content = canvas([element(`theirs-${other.version}`)]);
      other.version += 1;
      db.beforeWrite(foreign);
    };
    db.beforeWrite(foreign);

    const err = await mutateCanvasContent(
      db.client,
      "c1",
      (content) => ({
        ...content,
        elements: [...content.elements, element("ours-too")],
      }),
      { maxAttempts: 3 },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(CanvasVersionConflictError);
    expect((err as CanvasVersionConflictError).statusCode).toBe(409);
    expect((err as CanvasVersionConflictError).currentVersion).toBe(
      db.row().version,
    );
    expect(db.attempts()).toBe(3);
    expect(db.writes()).toBe(0);
  });

  it("CV-03: a whole-content save with the current baseVersion succeeds and bumps the version", async () => {
    const X = canvas([element("x")]);
    const db = versionedCanvas({ content: canvas([]), version: 4 });

    const result = await replaceCanvasContent(db.client, "c1", X, 4);

    expect(result.version).toBe(5);
    expect(db.row().content).toEqual(X);
    expect(db.row().version).toBe(5);
    expect(db.attempts()).toBe(1);
  });

  it("CV-03: a whole-content save with a stale baseVersion is a 409 and is NOT retried", async () => {
    const current = canvas([element("current")]);
    const db = versionedCanvas({ content: current, version: 5 });

    const err = await replaceCanvasContent(
      db.client,
      "c1",
      canvas([element("mine")]),
      4,
    ).catch((e) => e);

    // One attempt only. A retry here would re-send the whole stale snapshot,
    // which is precisely the overwrite the lock exists to prevent.
    expect(err).toBeInstanceOf(CanvasVersionConflictError);
    expect((err as CanvasVersionConflictError).statusCode).toBe(409);
    expect(db.attempts()).toBe(1);
    expect(db.writes()).toBe(0);
    expect(db.row().content).toEqual(current);
    expect(db.row().version).toBe(5);
    expect((err as CanvasVersionConflictError).currentContent).toEqual(current);
  });

  it("CV-03: the first save after load carries its baseVersion and is checked", async () => {
    const db = versionedCanvas({ content: canvas([element("loaded")]), version: 7 });

    const loaded = await readCanvasSnapshot(db.client, "c1");
    expect(loaded.version).toBe(7);

    // Another tab saves while this one is still editing what it loaded.
    db.beforeWrite((other) => {
      other.content = canvas([element("other-tab")]);
      other.version = 8;
    });

    const err = await replaceCanvasContent(
      db.client,
      "c1",
      canvas([element("stale")]),
      loaded.version,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(CanvasVersionConflictError);
    expect((err as CanvasVersionConflictError).statusCode).toBe(409);
    expect(db.attempts()).toBe(1);
    expect(db.row().version).toBe(8);
    expect(ids(db.row())).toEqual(["other-tab"]);
  });

  it("CV-03: a save without baseVersion still never writes over a version that moved mid-save", async () => {
    const db = versionedCanvas({ content: canvas([element("loaded")]), version: 3 });

    db.beforeWrite((other) => {
      other.content = canvas([element("racing")]);
      other.version = 4;
    });

    const err = await replaceCanvasContent(
      db.client,
      "c1",
      canvas([element("mine")]),
      undefined,
    ).catch((e) => e);

    // A legacy client passes no baseVersion, so the write is unguarded by the
    // caller — but it still reads the current version first and is checked
    // against it, so a write landing in that window is not clobbered.
    expect(err).toBeInstanceOf(CanvasVersionConflictError);
    expect((err as CanvasVersionConflictError).statusCode).toBe(409);
    expect(db.row().version).toBe(4);
    expect(ids(db.row())).toEqual(["racing"]);
  });
});
