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
import { describe, expect, it, vi } from "vitest";

import { isTransportFailure } from "../../supabase/transport-retry.js";
import {
  CanvasNotFoundError,
  CanvasUnavailableError,
  readCanvasRow,
  readCanvasSnapshot,
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
