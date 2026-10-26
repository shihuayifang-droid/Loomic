import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAIL_API_TOKEN_ENV,
  MAIL_API_URL_ENV,
} from "../features/notifications/mailer.js";
import {
  ALERT_CHANNEL_ENV,
  ALERT_DEDUP_WINDOW_MS,
  ALERT_EVENTS,
  ALERT_EVENT_TITLES,
  ALERT_MAIL_TO_ENV,
  ALERT_WEBHOOK_URL_ENV,
  alertChannelFromEnv,
  dispatchAlert,
  resetAlertDedup,
  type AlertEvent,
} from "./alerts.js";

/**
 * OP-18 / workorder 45DJ: the alert event taxonomy and its dispatcher.
 *
 * `fetch` is always stubbed — nothing here reaches the network, and one case
 * exists purely to prove that the default channel makes no call at all. The
 * dedup window is exercised by moving an injected clock, never by waiting.
 */

type FetchCall = { url: string; init: RequestInit | undefined };

function stubFetch(respond: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];

  const fake = vi.fn(
    async (input: unknown, init?: RequestInit): Promise<Response> => {
      const call: FetchCall = { url: String(input), init };
      calls.push(call);

      return respond(call);
    },
  );

  vi.stubGlobal("fetch", fake);

  return calls;
}

function ok(): Response {
  return new Response("{}", { status: 200 });
}

function envOf(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...extra };
}

beforeEach(() => {
  resetAlertDedup();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OP-18 channel selection", () => {
  it("defaults to off and makes no call at all", async () => {
    const calls = stubFetch(ok);

    expect(alertChannelFromEnv({})).toBe("off");
    expect(alertChannelFromEnv({ [ALERT_CHANNEL_ENV]: "  " })).toBe("off");

    const result = await dispatchAlert("cron_failed", { job: "reconcile" }, {
      env: envOf({}),
    });

    expect(result).toEqual({ delivered: false, reason: "channel_off" });
    expect(calls).toHaveLength(0);
  });

  it("treats an unknown channel value as off rather than guessing", async () => {
    const calls = stubFetch(ok);

    for (const value of ["off", "sms", "MAILBOX", "mail-ish"]) {
      expect(alertChannelFromEnv({ [ALERT_CHANNEL_ENV]: value })).toBe("off");

      const result = await dispatchAlert("worker_unhealthy", {}, {
        env: envOf({ [ALERT_CHANNEL_ENV]: value }),
      });

      expect(result).toEqual({ delivered: false, reason: "channel_off" });
    }

    expect(calls).toHaveLength(0);
  });

  it("reports a missing recipient instead of sending", async () => {
    const calls = stubFetch(ok);

    const result = await dispatchAlert("abnormal_spend", {}, {
      env: envOf({ [ALERT_CHANNEL_ENV]: "mail" }),
    });

    expect(result).toEqual({ delivered: false, reason: "mail_to_not_configured" });
    expect(calls).toHaveLength(0);
  });
});

describe("OP-18 mail channel", () => {
  it("sends one mail through the mailer built from the environment", async () => {
    const calls = stubFetch(ok);

    const result = await dispatchAlert("reconcile_mismatch", { diff: 12 }, {
      env: envOf({
        [ALERT_CHANNEL_ENV]: "mail",
        [ALERT_MAIL_TO_ENV]: "ops@example.com",
        [MAIL_API_URL_ENV]: "https://gateway.example.com/mail",
        [MAIL_API_TOKEN_ENV]: "token",
      }),
    });

    expect(result).toEqual({ delivered: true });
    expect(calls).toHaveLength(1);

    const [call] = calls;
    expect(call?.url).toBe("https://gateway.example.com/mail");
    expect(call?.init?.method).toBe("POST");

    const body = JSON.parse(String(call?.init?.body)) as Record<string, string>;
    expect(body.to).toBe("ops@example.com");
    expect(body.subject).toContain(ALERT_EVENT_TITLES.reconcile_mismatch);
    expect(body.text).toContain("reconcile_mismatch");
    expect(body.text).toContain("12");
  });

  it("uses an injected sender when the caller already owns a mailer", async () => {
    const sent: string[] = [];

    const result = await dispatchAlert("storage_above_80", { used: 0.85 }, {
      env: envOf({
        [ALERT_CHANNEL_ENV]: "mail",
        [ALERT_MAIL_TO_ENV]: "ops@example.com",
      }),
      sendMail: async (msg) => {
        sent.push(msg.subject);
      },
    });

    expect(result).toEqual({ delivered: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(ALERT_EVENT_TITLES.storage_above_80);
  });
});

describe("OP-18 webhook channel", () => {
  it("posts the event, its title and its detail", async () => {
    const calls = stubFetch(ok);

    const result = await dispatchAlert("compensation_failed", { orderId: "o-1" }, {
      env: envOf({
        [ALERT_CHANNEL_ENV]: "webhook",
        [ALERT_WEBHOOK_URL_ENV]: "https://example.com/hook",
      }),
    });

    expect(result).toEqual({ delivered: true });
    expect(calls).toHaveLength(1);

    const [call] = calls;
    expect(call?.url).toBe("https://example.com/hook");
    expect(call?.init?.method).toBe("POST");

    const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
    expect(body.event).toBe("compensation_failed");
    expect(body.title).toBe(ALERT_EVENT_TITLES.compensation_failed);
    expect(body.detail).toEqual({ orderId: "o-1" });
  });

  it("reports a missing url instead of calling fetch", async () => {
    const calls = stubFetch(ok);

    const result = await dispatchAlert("cron_failed", {}, {
      env: envOf({ [ALERT_CHANNEL_ENV]: "webhook" }),
    });

    expect(result).toEqual({
      delivered: false,
      reason: "webhook_url_not_configured",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("OP-18 dedup window", () => {
  it("delivers once per event per window, from an injected clock", async () => {
    let nowMs = 1_000_000;
    let sent = 0;

    const deps = {
      env: envOf({
        [ALERT_CHANNEL_ENV]: "mail",
        [ALERT_MAIL_TO_ENV]: "ops@example.com",
      }),
      now: () => nowMs,
      sendMail: async () => {
        sent += 1;
      },
    };

    expect(await dispatchAlert("cron_failed", {}, deps)).toEqual({
      delivered: true,
    });
    expect(sent).toBe(1);

    nowMs += 60_000;
    expect(await dispatchAlert("cron_failed", {}, deps)).toEqual({
      delivered: false,
      reason: "deduped",
    });
    expect(sent).toBe(1);

    // A different event inside the same window is not suppressed.
    expect(await dispatchAlert("abnormal_spend", {}, deps)).toEqual({
      delivered: true,
    });
    expect(sent).toBe(2);

    nowMs += ALERT_DEDUP_WINDOW_MS;
    expect(await dispatchAlert("cron_failed", {}, deps)).toEqual({
      delivered: true,
    });
    expect(sent).toBe(3);
  });
});

describe("OP-18 failure containment", () => {
  it("swallows a rejected send and reports it", async () => {
    const result = await dispatchAlert("cron_failed", {}, {
      env: envOf({
        [ALERT_CHANNEL_ENV]: "mail",
        [ALERT_MAIL_TO_ENV]: "ops@example.com",
      }),
      sendMail: async () => {
        throw new Error("smtp down");
      },
    });

    expect(result).toEqual({ delivered: false, reason: "delivery_failed" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("swallows a rejected webhook request and keeps the event retryable", async () => {
    const calls = stubFetch(() => {
      throw new Error("dns");
    });

    const deps = {
      env: envOf({
        [ALERT_CHANNEL_ENV]: "webhook",
        [ALERT_WEBHOOK_URL_ENV]: "https://example.com/hook",
      }),
    };

    expect(await dispatchAlert("worker_unhealthy", {}, deps)).toEqual({
      delivered: false,
      reason: "delivery_failed",
    });

    // Not recorded as sent, so the next pass tries again.
    expect(await dispatchAlert("worker_unhealthy", {}, deps)).toEqual({
      delivered: false,
      reason: "delivery_failed",
    });
    expect(calls).toHaveLength(2);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("OP-18 event taxonomy", () => {
  it("carries exactly the six OP-18 events, each with a title", () => {
    const all: AlertEvent[] = [...ALERT_EVENTS];

    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);

    for (const event of all) {
      const title = ALERT_EVENT_TITLES[event];
      expect(typeof title).toBe("string");
      expect(title.length).toBeGreaterThan(0);
    }

    expect([...all]).toEqual([
      "abnormal_spend",
      "reconcile_mismatch",
      "compensation_failed",
      "storage_above_80",
      "cron_failed",
      "worker_unhealthy",
    ]);
  });

  it("constructs and dispatches all six without throwing", async () => {
    stubFetch(ok);

    for (const event of ALERT_EVENTS) {
      const result = await dispatchAlert(event, { probe: true }, { env: envOf({}) });
      expect(result).toEqual({ delivered: false, reason: "channel_off" });
    }
  });
});
