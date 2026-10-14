// The dangerous mistakes this file exists to prevent:
//
//   1. retrying something Postgres actually answered (multiplies the wait for a
//      failure that will repeat identically)
//   2. NOT retrying a transport blip (the whole reason this helper exists: one blip
//      turned a successful agent run into "请求处理失败，请重试")
//   3. retrying forever
//
// `_retry-predicate.mjs` carries the table copied out of the server log; here we
// pin the LOOP's behaviour, plus the pg/Node classification the migrated mutation
// lookups now depend on (工单20E fixup).
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

// 工单20E fixup: the mutation lookups moved off PostgREST onto the pg repository,
// so the predicate is now asked about error shapes supabase-js never produced.
// The two tables below are that contract, in both directions: the driver's real
// transport shapes must retry, and everything the database actually answered with
// must not — including when its message mentions a connection.
describe("isTransportFailure pg/Node classification", () => {
  const NODE_NETWORK_CODES = [
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EAI_AGAIN",
  ];

  const RETRYABLE: Array<[string, unknown]> = [
    // node-postgres' own disconnect: no code at all.
    [
      "pg disconnect, code undefined",
      new Error("Connection terminated unexpectedly"),
    ],
    [
      "pg disconnect, code empty string (the supabase-js shape)",
      { code: "", message: "Connection terminated unexpectedly" },
    ],
    ...NODE_NETWORK_CODES.map(
      (code): [string, unknown] => [
        `Node socket error ${code}`,
        Object.assign(new Error(`read ${code} 198.18.0.20:5432`), { code }),
      ],
    ),
    // The pre-existing Supabase/proxy shapes must keep working: the read paths
    // still run through PostgREST.
    ["proxy blip, empty code", { code: "", message: "TypeError: fetch failed" }],
  ];

  const FAIL_FAST: Array<[string, unknown]> = [
    [
      "22P02 invalid_text_representation",
      { code: "22P02", message: "invalid input syntax for type uuid" },
    ],
    [
      "23505 unique_violation",
      { code: "23505", message: "duplicate key value violates unique constraint" },
    ],
    [
      "42501 insufficient_privilege",
      { code: "42501", message: "new row violates row-level security policy" },
    ],
    [
      "57014 query_canceled",
      { code: "57014", message: "canceling statement due to statement timeout" },
    ],
    // 57P01's real text contains "connection": a predicate that looked at the
    // message before the code would replay a failure Postgres already answered.
    [
      "57P01 admin_shutdown (message says connection)",
      {
        code: "57P01",
        message: "terminating connection due to administrator command",
      },
    ],
    // 工单20E: the 08 class stays fail-fast too — do not widen to all 08xxx.
    [
      "08006 connection_failure is still a SQLSTATE",
      { code: "08006", message: "connection failure" },
    ],
    [
      "unknown PostgREST code",
      { code: "PGRST116", message: "JSON object requested, multiple rows returned" },
    ],
    // Unknown code beats a message that the regex alone would match: the driver
    // named a failure, so it has to be on the whitelist to be replayed.
    [
      "unknown code with a transport-looking message",
      { code: "UNPROVEN", message: "fetch failed on the way back" },
    ],
    [
      "no code, unrelated message",
      { code: "", message: "invalid input syntax for type json" },
    ],
    ["plain business error", new Error("Project not found.")],
    ["null", null],
    ["undefined", undefined],
    ["a bare string", "fetch failed"],
    ["an empty object", {}],
  ];

  it("retries every real pg/Node transport shape", () => {
    for (const [name, error] of RETRYABLE) {
      expect(isTransportFailure(error), name).toBe(true);
    }
  });

  it("fails fast on every SQLSTATE and every unknown code", () => {
    for (const [name, error] of FAIL_FAST) {
      expect(isTransportFailure(error), name).toBe(false);
    }
  });
});
