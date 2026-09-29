// The dangerous mistakes this file exists to prevent:
//
//   1. retrying something Postgres actually answered (multiplies the wait for a
//      failure that will repeat identically)
//   2. NOT retrying a transport blip (the whole reason this helper exists: one blip
//      turned a successful agent run into "请求处理失败，请重试")
//   3. retrying forever
//
// The predicate's own table of real error shapes lives in `_retry-predicate.mjs`,
// which imports the shipped function; here we pin the LOOP's behaviour.
import { describe, expect, it, vi } from "vitest";

import {
  isTransportFailure,
  throwIfError,
  withTransportRetry,
} from "./transport-retry.js";

const TRANSPORT = { code: "", message: "TypeError: fetch failed" };
const PG_TIMEOUT = {
  code: "57014",
  message: "canceling statement due to statement timeout",
};

describe("withTransportRetry", () => {
  it("returns the first success without waiting", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(withTransportRetry("t", fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("replays a transport failure and returns the later success", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw TRANSPORT;
      return "recovered";
    });
    const promise = withTransportRetry("t", fn);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does NOT replay an error Postgres answered with, and rethrows it as-is", async () => {
    const fn = vi.fn(async () => {
      throw PG_TIMEOUT;
    });
    // Rethrown unchanged: callers match on `code` to build their own error.
    await expect(withTransportRetry("t", fn)).rejects.toBe(PG_TIMEOUT);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      throw TRANSPORT;
    });
    const promise = withTransportRetry("t", fn, { maxAttempts: 3 });
    const settled = expect(promise).rejects.toBe(TRANSPORT);
    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("honours maxAttempts: 1 as 'no retry'", async () => {
    const fn = vi.fn(async () => {
      throw TRANSPORT;
    });
    await expect(
      withTransportRetry("t", fn, { maxAttempts: 1 }),
    ).rejects.toBe(TRANSPORT);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("throwIfError", () => {
  // supabase-js never rejects, so without this the retry loop above would never
  // see anything and would silently do nothing.
  it("converts the {data,error} shape into a rejection carrying the driver error", () => {
    expect(() => throwIfError({ data: null, error: PG_TIMEOUT })).toThrow();
    try {
      throwIfError({ data: null, error: TRANSPORT });
    } catch (e) {
      // The identity matters: the predicate reads `code` off this object.
      expect(e).toBe(TRANSPORT);
      expect(isTransportFailure(e)).toBe(true);
    }
  });

  it("passes data through untouched on success", () => {
    const data = { workspace_id: "w1" };
    expect(throwIfError({ data, error: null })).toBe(data);
  });
});
