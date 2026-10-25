/**
 * OP-11: where an operational alert actually goes (workorder 45CH).
 *
 * THE GAP THIS CLOSES
 * `stuck-job-reaper-schedule`, `job-retention-schedule` and
 * `daily-reconcile-schedule` all end a bad pass in `console.warn`. On a server
 * nobody reads stdout, so a housekeeping chore that has been failing every
 * night is indistinguishable from one that has nothing to do. This module is
 * the place those failures can be delivered to instead of the log.
 *
 * PLUGGABLE LIKE `mailer.ts` (45CE), WITH ONE DELIBERATE DIFFERENCE
 * One interface, two implementations:
 *
 *   - `noop` — the default. No `HAHART_ALERT_WEBHOOK_URL` means nothing leaves
 *     the process; `notify` prints one line and resolves.
 *   - `webhook` — active only when `HAHART_ALERT_WEBHOOK_URL` is set. It POSTs
 *     one JSON object to that URL with a ten-second ceiling. The body is the
 *     alert itself (`{ title, severity, detail? }`) plus a flat `text` field, so
 *     a chat-robot webhook (企业微信 / Slack incoming webhook and friends) reads
 *     something human-sized without an adapter. `HAHART_ALERT_WEBHOOK_TOKEN`,
 *     when set, becomes `Authorization: Bearer <token>`; unlike the mailer a
 *     token is OPTIONAL, because the common receiver is a bot URL that
 *     authenticates by being unguessable.
 *
 * THE FAILURE POLICY IS THE OPPOSITE OF THE MAILER
 * `createMailer().send` THROWS on a non-2xx, because a human is waiting for
 * that mail and the caller must decide what to do. An alert is the opposite
 * case: it is raised while another job is ALREADY failing, so a failed
 * delivery must never become a second failure. `notify` therefore NEVER
 * rejects — a non-2xx answer, a DNS error, a timeout are each reported with
 * `console.warn` and swallowed. A schedule that could be killed by its own
 * alert channel would be worse off than one that only logs, which is exactly
 * the property the three schedules this serves are built around.
 */

/** How loud an alert is. `"warn"` is a finding, `"error"` is a failed pass. */
export type AlertSeverity = "warn" | "error";

/** One operational alert: a short title, a severity, and optional structured context. */
export type Alert = {
  title: string;
  severity: AlertSeverity;
  detail?: Record<string, unknown>;
};

/** The pluggable channel. `kind` names the implementation in logs and tests. */
export interface AlertSink {
  notify(alert: Alert): Promise<void>;
  readonly kind: string;
}

/** Environment variable holding the webhook URL. Unset means `noop`. */
export const ALERT_WEBHOOK_URL_ENV = "HAHART_ALERT_WEBHOOK_URL";

/** Optional bearer token for the webhook URL. */
export const ALERT_WEBHOOK_TOKEN_ENV = "HAHART_ALERT_WEBHOOK_TOKEN";

/** Ticket contract: a configured webhook gets ten seconds, then the request is aborted. */
export const ALERT_REQUEST_TIMEOUT_MS = 10_000;

export type AlertSinkEnv = {
  url?: string;
  token?: string;
};

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** The `detail` as one JSON string; `{}` when there is none to show. */
function detailJson(alert: Alert): string {
  return JSON.stringify(alert.detail ?? {});
}

/**
 * The no-op channel. It is not silent: the alert is printed so a local run
 * leaves the trace of what would have been sent, but nothing is opened,
 * resolved or awaited over the network. Never rejects.
 */
function createNoopAlertSink(): AlertSink {
  return {
    kind: "noop",
    async notify(alert: Alert): Promise<void> {
      console.warn(
        `[alert:noop] ${alert.severity} ${alert.title} ${detailJson(alert)}`,
      );
    },
  };
}

/**
 * The configured channel: one JSON POST per alert, ten-second ceiling, and no
 * exception ever leaves `notify` — see "THE FAILURE POLICY IS THE OPPOSITE OF
 * THE MAILER" above.
 */
function createWebhookAlertSink(url: string, token: string | undefined): AlertSink {
  return {
    kind: "webhook",
    async notify(alert: Alert): Promise<void> {
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (token !== undefined) {
          headers.authorization = `Bearer ${token}`;
        }

        const detailText =
          alert.detail === undefined ? "" : ` ${JSON.stringify(alert.detail)}`;

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: alert.title,
            severity: alert.severity,
            ...(alert.detail === undefined ? {} : { detail: alert.detail }),
            text: `[${alert.severity}] ${alert.title}${detailText}`,
          }),
          signal: AbortSignal.timeout(ALERT_REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          // Reported, not thrown: the pass that raised this alert is already
          // in its own error path and must not collect a second one.
          console.warn(
            `[alert:webhook] delivery failed: ${response.status} ${alert.title}`,
          );
        }
      } catch (error) {
        console.warn(
          `[alert:webhook] delivery failed: ${
            error instanceof Error ? error.message : String(error)
          } ${alert.title}`,
        );
      }
    },
  };
}

/**
 * Pick a channel from explicit configuration. No `url` means `noop`; a `url`
 * with no token is still a working webhook, because the receiver is usually a
 * bot URL that authenticates itself.
 *
 * Called with no argument it reads the two documented variables out of
 * `process.env` — that is how the three schedules build their sink at the
 * moment a pass fails, without the sink becoming a constructor argument.
 */
export function createAlertSink(env?: AlertSinkEnv): AlertSink {
  const url = configured(
    env === undefined ? process.env[ALERT_WEBHOOK_URL_ENV] : env.url,
  );
  const token = configured(
    env === undefined ? process.env[ALERT_WEBHOOK_TOKEN_ENV] : env.token,
  );

  if (url === undefined) {
    return createNoopAlertSink();
  }

  return createWebhookAlertSink(url, token);
}

/** `createAlertSink` reading the two documented variables out of an environment. */
export function createAlertSinkFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): AlertSink {
  const url = configured(source[ALERT_WEBHOOK_URL_ENV]);
  const token = configured(source[ALERT_WEBHOOK_TOKEN_ENV]);

  if (url === undefined) {
    return createNoopAlertSink();
  }

  return createWebhookAlertSink(url, token);
}
