/**
 * OP-18: the operational alert taxonomy and its dispatcher (workorder 45DJ).
 *
 * WHAT THIS IS FOR
 * Six named failures are listed as "must be told to a human": abnormal spend,
 * a reconcile mismatch, a failed compensation, storage above 80%, a failed cron
 * pass, and an unhealthy worker. `alert-sink.ts` (OP-11 / 45CH) already knows
 * HOW to reach one webhook; this module adds WHAT the six events are and the
 * one entry point that decides whether and where a given event goes.
 *
 * THE CHANNEL IS A USER DECISION, SO IT IS A CONFIGURATION VALUE
 * U-30 (which channel the product actually uses — mail or 企业微信 webhook) is
 * still open. Nothing here picks a side: `HAHART_ALERT_CHANNEL` selects
 * `off` | `mail` | `webhook`, and `off` is the default. An unset or unknown
 * value is treated as `off` on purpose — a server that starts firing alerts
 * the moment it boots is worse than one that stays quiet until someone
 * configures it.
 *
 * IT NEVER THROWS
 * A dispatch happens while some other path is ALREADY in its error handling.
 * Every failure mode here (no recipient, no gateway, a non-2xx, a rejected
 * promise, a broken clock) is reported as `{ delivered: false, reason }` and
 * logged; nothing bubbles out. This mirrors `alert-sink.ts` and is the
 * opposite of `mailer.ts`, which throws because a human is waiting for that
 * message.
 *
 * DEDUPLICATION USES AN INJECTABLE CLOCK
 * A flapping condition (a worker that fails its health check every ten
 * seconds) must not produce a message per pass. The same event inside the
 * window (`ALERT_DEDUP_WINDOW_MS`, five minutes by default) is answered from
 * the store with `reason: "deduped"`. The clock and the store are both
 * injectable, so tests move time instead of sleeping.
 */

import {
  createMailerFromEnv,
  type Mailer,
  type MailMessage,
} from "../features/notifications/mailer.js";

/** Selects the channel: `off` (default) / `mail` / `webhook`. */
export const ALERT_CHANNEL_ENV = "HAHART_ALERT_CHANNEL";

/** Recipient of the `mail` channel. Required for that channel to send. */
export const ALERT_MAIL_TO_ENV = "HAHART_ALERT_MAIL_TO";

/** Endpoint of the `webhook` channel. Required for that channel to send. */
export const ALERT_WEBHOOK_URL_ENV = "HAHART_ALERT_WEBHOOK_URL";

/** Default dedup window: one message per event per five minutes. */
export const ALERT_DEDUP_WINDOW_MS = 5 * 60 * 1000;

/** A configured webhook gets ten seconds, then the request is aborted. */
export const ALERT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The six operational events OP-18 requires. English constants are the wire
 * value (logs, webhook body, dedup key); the Chinese titles live next to them
 * in `ALERT_EVENT_TITLES` because they are what a human reads.
 */
export type AlertEvent =
  | "abnormal_spend"
  | "reconcile_mismatch"
  | "compensation_failed"
  | "storage_above_80"
  | "cron_failed"
  | "worker_unhealthy";

/** Every event, in the order OP-18 lists them. */
export const ALERT_EVENTS: readonly AlertEvent[] = [
  "abnormal_spend",
  "reconcile_mismatch",
  "compensation_failed",
  "storage_above_80",
  "cron_failed",
  "worker_unhealthy",
];

/** Human-readable title per event, used as the mail subject / webhook title. */
export const ALERT_EVENT_TITLES: Record<AlertEvent, string> = {
  abnormal_spend: "异常消耗",
  reconcile_mismatch: "对账不一致",
  compensation_failed: "补偿失败",
  storage_above_80: "存储使用率超过 80%",
  cron_failed: "定时任务失败",
  worker_unhealthy: "worker 不健康",
};

/** The three legal values of `HAHART_ALERT_CHANNEL`. */
export type AlertChannel = "off" | "mail" | "webhook";

/** Free-form, JSON-serialisable context attached to an alert. */
export type AlertDetail = Record<string, unknown>;

/**
 * The result of one dispatch. `reason` is present only when `delivered` is
 * `false`, and is one of the short constants the tests and the caller check:
 * `channel_off`, `deduped`, `mail_to_not_configured`, `mailer_not_configured`,
 * `webhook_url_not_configured`, `delivery_failed`.
 */
export type AlertDelivery = {
  delivered: boolean;
  reason?: string;
};

/** The injectable edges of the dispatcher: everything that is not pure. */
export type AlertDeps = {
  /** Environment to read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Clock in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Dedup window override. Defaults to `ALERT_DEDUP_WINDOW_MS`. */
  dedupWindowMs?: number;
  /** Dedup store; defaults to the module-level one. */
  seenAt?: Map<AlertEvent, number>;
  /** Mail transport. Defaults to one built from `env` via the existing mailer. */
  mailer?: Mailer;
  /** Direct send hook, for callers that already own a mailer. */
  sendMail?: (msg: MailMessage) => Promise<void>;
  /** Fetch used by the webhook channel. Defaults to the global one. */
  fetchImpl?: typeof fetch;
};

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * Read the channel. Anything that is not exactly `mail` or `webhook` — missing,
 * blank, unknown, misspelt — is `off`: failing closed here is the whole point.
 */
export function alertChannelFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): AlertChannel {
  const raw = configured(source[ALERT_CHANNEL_ENV])?.toLowerCase();

  if (raw === "mail") {
    return "mail";
  }

  if (raw === "webhook") {
    return "webhook";
  }

  return "off";
}

/** The module-level dedup store, shared by every caller that does not inject one. */
const defaultSeenAt = new Map<AlertEvent, number>();

/** Forget every recorded send. For tests and for an operator-driven reset. */
export function resetAlertDedup(): void {
  defaultSeenAt.clear();
}

/** One line of human text, shared by the two channels. */
function alertBody(event: AlertEvent, detail: AlertDetail): string {
  return `${ALERT_EVENT_TITLES[event]} (${event}) ${JSON.stringify(detail)}`;
}

function buildMail(to: string, event: AlertEvent, detail: AlertDetail): MailMessage {
  const title = ALERT_EVENT_TITLES[event];

  return {
    to,
    subject: `[HaHart 告警] ${title}`,
    html: `<p><strong>${title}</strong> (${event})</p><pre>${JSON.stringify(
      detail,
      null,
      2,
    )}</pre>`,
    text: alertBody(event, detail),
  };
}

/**
 * The mail sender: an explicit `sendMail`, else an explicit `mailer`, else one
 * built from `env`. `undefined` means "the mail channel is configured but no
 * transport is" — a noop mailer would make an unconfigured server look like it
 * delivered, so it is treated as missing instead.
 */
function resolveMailSender(
  deps: AlertDeps,
  env: NodeJS.ProcessEnv,
): ((msg: MailMessage) => Promise<void>) | undefined {
  if (deps.sendMail !== undefined) {
    return deps.sendMail;
  }

  const mailer = deps.mailer ?? createMailerFromEnv(env);

  if (mailer.kind === "noop") {
    return undefined;
  }

  return (msg) => mailer.send(msg);
}

async function postWebhook(
  doFetch: typeof fetch,
  url: string,
  event: AlertEvent,
  detail: AlertDetail,
): Promise<void> {
  const title = ALERT_EVENT_TITLES[event];

  const response = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event,
      title,
      detail,
      text: alertBody(event, detail),
    }),
    signal: AbortSignal.timeout(ALERT_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`alert webhook responded ${response.status}`);
  }
}

/**
 * Deliver one event, if the channel is on and this event has not already been
 * sent inside the dedup window. Never throws — see the header.
 */
export async function dispatchAlert(
  event: AlertEvent,
  detail: AlertDetail = {},
  deps: AlertDeps = {},
): Promise<AlertDelivery> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const windowMs = deps.dedupWindowMs ?? ALERT_DEDUP_WINDOW_MS;
  const seenAt = deps.seenAt ?? defaultSeenAt;

  const channel = alertChannelFromEnv(env);

  if (channel === "off") {
    return { delivered: false, reason: "channel_off" };
  }

  const lastSentAt = seenAt.get(event);

  if (lastSentAt !== undefined && now() - lastSentAt < windowMs) {
    return { delivered: false, reason: "deduped" };
  }

  try {
    if (channel === "mail") {
      const to = configured(env[ALERT_MAIL_TO_ENV]);

      if (to === undefined) {
        return { delivered: false, reason: "mail_to_not_configured" };
      }

      const send = resolveMailSender(deps, env);

      if (send === undefined) {
        return { delivered: false, reason: "mailer_not_configured" };
      }

      await send(buildMail(to, event, detail));
    } else {
      const url = configured(env[ALERT_WEBHOOK_URL_ENV]);

      if (url === undefined) {
        return { delivered: false, reason: "webhook_url_not_configured" };
      }

      await postWebhook(deps.fetchImpl ?? fetch, url, event, detail);
    }
  } catch (error) {
    // The pass that raised this alert is already failing; a second failure in
    // its alert channel must not compound it.
    console.warn(
      `[alert:${channel}] delivery failed: ${
        error instanceof Error ? error.message : String(error)
      } ${event}`,
    );

    return { delivered: false, reason: "delivery_failed" };
  }

  // Recorded only after a successful send: a failed attempt must stay
  // retryable rather than being suppressed for a whole window.
  seenAt.set(event, now());

  return { delivered: true };
}
