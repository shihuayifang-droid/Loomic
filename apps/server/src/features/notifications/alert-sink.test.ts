import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALERT_REQUEST_TIMEOUT_MS,
  ALERT_WEBHOOK_TOKEN_ENV,
  ALERT_WEBHOOK_URL_ENV,
  createAlertSink,
  createAlertSinkFromEnv,
  type Alert,
} from "./alert-sink.js";

/**
 * OP-11 / workorder 45CH: the alert sink.
 *
 * `fetch` is stubbed, never called for real. The load-bearing assertion in this
 * file is that `notify` DOES NOT REJECT on a non-2xx answer — the exact
 * opposite of `mailer.test.ts`, because an alert is raised while another job is
 * already failing and must never become a second failure.
 */

const ALERT: Alert = {
  title: "任务保留期清理失败",
  severity: "error",
  detail: { message: "database timed out" },
};

type FetchCall = { url: string; init: RequestInit | undefined };

function stubFetch(respond: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];

  const fake = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);

    return respond(call);
  });

  vi.stubGlobal("fetch", fake);

  return calls;
}

describe("OP-11 alert sink: noop", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("OP-11: no url yields the noop sink", () => {
    expect(createAlertSink({}).kind).toBe("noop");
    expect(createAlertSink({ token: "t" }).kind).toBe("noop");
    expect(createAlertSink({ url: "  ", token: "  " }).kind).toBe("noop");
    expect(createAlertSink({ url: "" }).kind).toBe("noop");
  });

  it("OP-11: a missing HAHART_ALERT_WEBHOOK_URL in the environment is noop too", () => {
    expect(createAlertSinkFromEnv({}).kind).toBe("noop");
    expect(createAlertSinkFromEnv({ [ALERT_WEBHOOK_TOKEN_ENV]: "t" }).kind).toBe(
      "noop",
    );
  });

  it("OP-11: the noop sink logs and does not throw, and makes no network call", async () => {
    const calls = stubFetch(() => new Response(null, { status: 200 }));

    await expect(createAlertSink({}).notify(ALERT)).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
    const line = String(vi.mocked(console.warn).mock.calls[0]?.[0]);
    expect(line).toContain("[alert:noop]");
    expect(line).toContain("error");
    expect(line).toContain(ALERT.title);
  });
});

describe("OP-11 alert sink: webhook", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("OP-11: a url yields the webhook sink and posts the alert as JSON", async () => {
    const calls = stubFetch(() => new Response(null, { status: 200 }));
    const sink = createAlertSink({ url: "https://hooks.example.com/alert" });

    expect(sink.kind).toBe("webhook");

    await expect(sink.notify(ALERT)).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hooks.example.com/alert");
    expect(calls[0]?.init?.method).toBe("POST");

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    // No token configured: no Authorization header is invented.
    expect(headers.authorization).toBeUndefined();

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.title).toBe(ALERT.title);
    expect(body.severity).toBe("error");
    expect(body.detail).toEqual({ message: "database timed out" });
    expect(typeof body.text).toBe("string");
  });

  it("OP-11: the bearer token is sent when configured", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await createAlertSink({
      url: "https://hooks.example.com/alert",
      token: "secret-token",
    }).notify(ALERT);

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-token");
  });

  it("OP-11: a non-2xx answer is a warning, NOT a rejection (unlike the mailer)", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));

    // `resolves`, not `rejects`: an alert channel must never fail the job that
    // raised it. This assertion is deliberately the inverse of mailer.test.ts.
    await expect(
      createAlertSink({ url: "https://hooks.example.com/alert" }).notify(ALERT),
    ).resolves.toBeUndefined();

    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain("500");
  });

  it("OP-11: a network error is a warning too, not a rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND hooks.example.com");
      }),
    );

    await expect(
      createAlertSink({ url: "https://hooks.example.com/alert" }).notify(ALERT),
    ).resolves.toBeUndefined();

    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain(
      "ENOTFOUND",
    );
  });

  it("OP-11: the request carries a ten-second ceiling", async () => {
    let observed: AbortSignal | null | undefined;

    const calls = stubFetch((call) => {
      observed = call.init?.signal;
      return new Response(null, { status: 200 });
    });

    await createAlertSink({ url: "https://hooks.example.com/alert" }).notify(ALERT);

    expect(ALERT_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(calls).toHaveLength(1);
    expect(observed).toBeInstanceOf(AbortSignal);
  });
});
