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
 * swap stays a config change. Anything the provider needs beyond those four
 * fields (a from-address, a template id, signing) belongs to that adapter.
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
function createHttpMailer(url: string, token: string): Mailer {
  return {
    kind: "http",
    async send(msg: MailMessage): Promise<void> {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
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
 * `noop` rather than sending unauthenticated requests somewhere.
 */
export function createMailer(env: MailerEnv): Mailer {
  const url = configured(env.url);
  const token = configured(env.token);

  if (url === undefined || token === undefined) {
    return createNoopMailer();
  }

  return createHttpMailer(url, token);
}

/** `createMailer` reading the two documented variables out of an environment. */
export function createMailerFromEnv(source: NodeJS.ProcessEnv = process.env): Mailer {
  const url = configured(source[MAIL_API_URL_ENV]);
  const token = configured(source[MAIL_API_TOKEN_ENV]);

  if (url === undefined || token === undefined) {
    return createMailer({});
  }

  return createMailer({ url, token });
}
