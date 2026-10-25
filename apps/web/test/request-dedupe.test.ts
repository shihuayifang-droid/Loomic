import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearRequestDedupeCache,
  dedupeRequest,
} from "../src/lib/request-dedupe";

const CREDITS_KEY = "GET http://127.0.0.1:3001/api/credits";
const VIEWER_KEY = "GET http://127.0.0.1:3001/api/viewer";
const T0 = new Date("2026-01-01T00:00:00.000Z");

/** 假时钟：只替换 Date，微任务照常跑 */
function at(offsetMs: number) {
  vi.setSystemTime(new Date(T0.getTime() + offsetMs));
}

beforeEach(() => {
  clearRequestDedupeCache();
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});

afterEach(() => {
  clearRequestDedupeCache();
  vi.useRealTimers();
});

describe("dedupeRequest", () => {
  it("runs the underlying request once for concurrent calls with the same key", async () => {
    let release: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => pending);

    const first = dedupeRequest(CREDITS_KEY, run);
    const second = dedupeRequest(CREDITS_KEY, run);

    expect(run).toHaveBeenCalledTimes(1);

    release("balance");
    await expect(first).resolves.toBe("balance");
    await expect(second).resolves.toBe("balance");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("serves the cached result inside the TTL without running again", async () => {
    const run = vi.fn(async () => "balance");

    await expect(dedupeRequest(CREDITS_KEY, run, 5000)).resolves.toBe("balance");

    at(4999);
    await expect(dedupeRequest(CREDITS_KEY, run, 5000)).resolves.toBe("balance");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs again once the TTL has expired", async () => {
    const run = vi.fn(async () => "balance");

    await dedupeRequest(CREDITS_KEY, run, 5000);
    at(5001);
    await expect(dedupeRequest(CREDITS_KEY, run, 5000)).resolves.toBe("balance");

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not cache a rejection, so the next call retries", async () => {
    let attempt = 0;
    const run = vi.fn(async (): Promise<string> => {
      attempt += 1;
      if (attempt === 1) throw new Error("unauthorized");
      return "balance";
    });

    await expect(dedupeRequest(CREDITS_KEY, run)).rejects.toThrow("unauthorized");
    at(1);
    await expect(dedupeRequest(CREDITS_KEY, run)).resolves.toBe("balance");

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("hands the same rejection to every concurrent caller and caches nothing", async () => {
    const run = vi.fn(async (): Promise<string> => {
      throw new Error("unauthorized");
    });

    const first = dedupeRequest(CREDITS_KEY, run);
    const second = dedupeRequest(CREDITS_KEY, run);

    await expect(first).rejects.toThrow("unauthorized");
    await expect(second).rejects.toThrow("unauthorized");
    expect(run).toHaveBeenCalledTimes(1);

    await expect(dedupeRequest(CREDITS_KEY, run)).rejects.toThrow("unauthorized");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps different keys apart", async () => {
    const credits = vi.fn(async () => "credits");
    const viewer = vi.fn(async () => "viewer");

    await expect(dedupeRequest(CREDITS_KEY, credits)).resolves.toBe("credits");
    await expect(dedupeRequest(VIEWER_KEY, viewer)).resolves.toBe("viewer");

    expect(credits).toHaveBeenCalledTimes(1);
    expect(viewer).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a result when the TTL is zero", async () => {
    const run = vi.fn(async () => "balance");

    await dedupeRequest(CREDITS_KEY, run, 0);
    await dedupeRequest(CREDITS_KEY, run, 0);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("still collapses concurrent calls when the TTL is zero", async () => {
    let release: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => pending);

    const first = dedupeRequest(VIEWER_KEY, run, 0);
    const second = dedupeRequest(VIEWER_KEY, run, 0);

    expect(run).toHaveBeenCalledTimes(1);

    release("viewer");
    await expect(first).resolves.toBe("viewer");
    await expect(second).resolves.toBe("viewer");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not serve a zero-TTL call from an earlier cached result", async () => {
    const run = vi.fn(async () => "viewer");

    await dedupeRequest(VIEWER_KEY, run, 5000);
    await dedupeRequest(VIEWER_KEY, run, 0);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps keys that carry different tokens apart inside the TTL", async () => {
    const alice = vi.fn(async () => "alice");
    const bob = vi.fn(async () => "bob");

    await expect(dedupeRequest("credits:token_alice", alice)).resolves.toBe("alice");
    await expect(dedupeRequest("credits:token_bob", bob)).resolves.toBe("bob");

    expect(alice).toHaveBeenCalledTimes(1);
    expect(bob).toHaveBeenCalledTimes(1);
  });

  it("forgets everything on clearRequestDedupeCache", async () => {
    const run = vi.fn(async () => "balance");

    await dedupeRequest(CREDITS_KEY, run);
    clearRequestDedupeCache();
    await dedupeRequest(CREDITS_KEY, run);

    expect(run).toHaveBeenCalledTimes(2);
  });
});
