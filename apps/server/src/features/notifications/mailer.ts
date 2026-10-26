/**
 * BR-09: the sending half of the authentication emails — pluggable by design.
 *
 * TRANSPORT IS A DECISION SOMEONE ELSE HAS TO MAKE
 * The product decision on which provider sends HaHart's mail (and the API key
 * for it) is still open — tracked as U-28. So this module does not import a
 * provider SDK. It exposes one interface, `Mailer`, and two implementations:
 *
 *   - `noop` — the default. No configuration means no network call is ever
 *     attempted; `send` logs one line and resolves. A missing key must never
 *     turn into a failed registration.
 *   - `http` — active only when BOTH `HAHART_MAIL_API_URL` and
 *     `HAHART_MAIL_API_TOKEN` are set. It POSTs a flat JSON body to that URL
 *     with `Authorization: Bearer <token>`.
 *
 * The URL is a GENERIC JSON GATEWAY, not a vendor endpoint: whatever is put
 * behind it must accept `{ to, subject, html, text }` and answer 2xx. Resend,
 * Alibaba Cloud DirectMail (邮件推送) and friends each get a thin adapter on the
 * gateway side, so this server never learns a provider's schema and a provider
 * swap stays a config change.
 *
 * THE ONE EXCEPTION IS THE SENDER ADDRESS (U-28, workorder 45D9)
 * Resend's `POST /emails` rejects a request that has no `from` (422), so a
 * from-address cannot stay purely on the adapter side. It is therefore an
 * opaque, optional string taken from `HAHART_MAIL_FROM`: when it is set the
 * body gains a `from` field, when it is not the body is byte-for-byte what it
 * always was (older gateways that reject unknown fields keep working). The
 * value itself is not interpreted here — no default, no address validation, no
 * vendor knowledge. Anything else a provider needs (a template id, signing)
 * still belongs to the adapter.
 *
 * FAILURE POLICY
 * A non-2xx response from a configured gateway is a configuration or provider
 * fault, not a user error, so it throws — the caller decides whether to log and
 * carry on. With no configuration there is nothing to fail: `noop` never throws.
 */

/** Environment variable holding the JSON gateway URL. */
export const MAIL_API_URL_ENV = "HAHART_MAIL_API_URL";

/** Environment variable holding the gateway bearer token. */
export const MAIL_API_TOKEN_ENV = "HAHART_MAIL_API_TOKEN";

/**
 * Environment variable holding the optional sender address (U-28 / workorder
 * 45D9). Unset means "send no `from` field at all", not "send a default".
 */
export const MAIL_FROM_ENV = "HAHART_MAIL_FROM";

/** Ticket contract: a configured gateway gets ten seconds, then the request is aborted. */
export const MAIL_REQUEST_TIMEOUT_MS = 10_000;

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
  readonly kind: string;
}

export type MailerEnv = {
  url?: string;
  token?: string;
  /**
   * Optional sender. Absent/blank leaves the body exactly as it was before
   * workorder 45D9; present adds one `from` field (see `MAIL_FROM_ENV`).
   */
  from?: string;
};

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * The no-op transport. Deliberately not silent at the wrong level: the call is
 * logged so that a local run leaves a trace of what would have been sent, but
 * nothing is opened, resolved or awaited over the network.
 */
function createNoopMailer(): Mailer {
  return {
    kind: "noop",
    async send(msg: MailMessage): Promise<void> {
      console.info(`mail(noop) to=${msg.to} subject=${msg.subject}`);
    },
  };
}

/** The configured transport: one JSON POST per message, ten-second ceiling. */
function createHttpMailer(url: string, token: string, from: string | undefined): Mailer {
  return {
    kind: "http",
    async send(msg: MailMessage): Promise<void> {
      const body: Record<string, string> = {
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      };

      // Only when configured: an unconditional `from: undefined` would drop the
      // key anyway, but keeping the branch explicit is what makes the "unset
      // means byte-identical body" promise reviewable.
      if (from !== undefined) {
        body.from = from;
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MAIL_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`mail provider responded ${response.status}`);
      }
    },
  };
}

/**
 * Pick a transport from explicit configuration. `url` and `token` are both
 * required for the HTTP transport: a half-configured gateway falls back to
 * `noop` rather than sending unauthenticated requests somewhere. `from` is
 * optional and never changes which transport is picked — it only annotates the
 * body of a transport that is already going to send.
 */
export function createMailer(env: MailerEnv): Mailer {
  const url = configured(env.url);
  const token = configured(env.token);
  const from = configured(env.from);

  if (url === undefined || token === undefined) {
    return createNoopMailer();
  }

  return createHttpMailer(url, token, from);
}

/** `createMailer` reading the documented variables out of an environment. */
export function createMailerFromEnv(source: NodeJS.ProcessEnv = process.env): Mailer {
  const url = configured(source[MAIL_API_URL_ENV]);
  const token = configured(source[MAIL_API_TOKEN_ENV]);
  const from = configured(source[MAIL_FROM_ENV]);

  if (url === undefined || token === undefined) {
    return createMailer({});
  }

  return createMailer({ url, token, ...(from === undefined ? {} : { from }) });
}
