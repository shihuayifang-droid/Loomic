/**
 * BR-09 / workorder 45CM: one command that answers "is the mail gateway really
 * wired up and does it really deliver?" once U-28 supplies the credentials.
 *
 * Usage (from `apps/server`):
 *   pnpm run mail:send -- --to <email> [--template verify-email|login-code|reset-password]
 *
 * WHY THIS EXISTS AS ITS OWN CLI
 * The server only sends mail on real auth flows, so before this there was no way
 * to exercise the configured transport without creating an account. `deploy/
 * verify-mail.sh` runs this inside the running container and reads its exit code.
 *
 * EXIT CODES (the contract `deploy/verify-mail.sh` depends on)
 *   0 — the mailer was `http` and `send()` resolved
 *   1 — the mailer was `http` and `send()` threw (bad URL, non-2xx, timeout)
 *   2 — usage error: missing/invalid `--to` or `--template`
 *   3 — the mailer is `noop`, i.e. `HAHART_MAIL_API_URL` / `HAHART_MAIL_API_TOKEN`
 *       are not both set. Distinct from 1 on purpose: "not configured yet" and
 *       "configured wrong" need different fixes.
 *
 * SECRETS
 * The token is never printed, and neither is the gateway URL: only its host goes
 * to stdout (`url_host=<host>`), which is enough to spot a wrong endpoint
 * without writing a credential or a private path into a log or a ticket.
 *
 * CONTENT
 * This is a delivery test, not an auth flow, so the template gets fixed sample
 * values. The link/code are inert placeholders and cannot verify anything.
 */
import { pathToFileURL } from "node:url";

import {
  loginCode,
  resetPassword,
  verifyEmail,
  type EmailContent,
} from "../features/notifications/email-templates.js";
import {
  createMailerFromEnv,
  MAIL_API_TOKEN_ENV,
  MAIL_API_URL_ENV,
} from "../features/notifications/mailer.js";

const USAGE =
  "usage: mail:send -- --to <email> [--template verify-email|login-code|reset-password]";

export const TEMPLATE_ARG_NAMES = ["verify-email", "login-code", "reset-password"] as const;

export type TemplateArgName = (typeof TEMPLATE_ARG_NAMES)[number];

export const DEFAULT_TEMPLATE_ARG: TemplateArgName = "verify-email";

/** Marker printed when nothing is configured; the shell script keys on exit 3. */
export const NOOP_LINE = "mailer=noop (not configured: set HAHART_MAIL_API_URL/TOKEN)";

/** Inert placeholders — a delivery test must not mint a usable link or code. */
const PLACEHOLDER_VERIFY_LINK =
  "https://hahart.example.com/verify?token=mail-send-cli-placeholder";
const PLACEHOLDER_RESET_LINK =
  "https://hahart.example.com/reset-password?token=mail-send-cli-placeholder";
const PLACEHOLDER_LOGIN_CODE = "135790";

export type SendOptions = {
  readonly to: string;
  readonly template: TemplateArgName;
};

function isTemplateArgName(value: string): value is TemplateArgName {
  return (TEMPLATE_ARG_NAMES as readonly string[]).includes(value);
}

/** Minimal, strict on purpose: an unknown flag is a typo, not something to ignore. */
function valueAfter(
  argv: readonly string[],
  index: number,
  flag: string,
): { value: string; next: number } {
  const inline = argv[index]?.startsWith(`${flag}=`) === true;
  const value = inline ? argv[index]?.slice(flag.length + 1) : argv[index + 1];

  if (value === undefined || value === "" || (!inline && value.startsWith("--"))) {
    throw new Error(`${flag} needs a value`);
  }

  return { value, next: inline ? index : index + 1 };
}

export function parseSendArgs(argv: readonly string[]): SendOptions {
  let to: string | undefined;
  let template: TemplateArgName = DEFAULT_TEMPLATE_ARG;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      continue;
    }

    // pnpm forwards the `--` separator verbatim (`pnpm run mail:send -- --to x`,
    // the documented invocation), so a bare `--` is a separator, not a typo.
    if (arg === "--") {
      continue;
    }

    if (arg === "--to" || arg.startsWith("--to=")) {
      const parsed = valueAfter(argv, index, "--to");

      to = parsed.value;
      index = parsed.next;
      continue;
    }

    if (arg === "--template" || arg.startsWith("--template=")) {
      const parsed = valueAfter(argv, index, "--template");

      if (!isTemplateArgName(parsed.value)) {
        throw new Error(
          `unknown template: ${parsed.value} (expected ${TEMPLATE_ARG_NAMES.join("|")})`,
        );
      }

      template = parsed.value;
      index = parsed.next;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  if (to === undefined || to.trim() === "") {
    throw new Error("--to <email> is required");
  }

  return { to: to.trim(), template };
}

/** Render one of the three BR-09 templates with the sample values above. */
export function renderTemplate(template: TemplateArgName): EmailContent {
  switch (template) {
    case "login-code":
      return loginCode({ code: PLACEHOLDER_LOGIN_CODE });
    case "reset-password":
      return resetPassword({ link: PLACEHOLDER_RESET_LINK });
    case "verify-email":
      return verifyEmail({ link: PLACEHOLDER_VERIFY_LINK });
  }
}

/**
 * Host only — never the full URL, which can carry a path, a query or a token.
 * A malformed URL degrades to `invalid` instead of echoing back what was set.
 */
export function urlHost(url: string | undefined): string {
  if (url === undefined || url.trim() === "") {
    return "invalid";
  }

  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(argv: readonly string[]): Promise<number> {
  let options: SendOptions;

  try {
    options = parseSendArgs(argv);
  } catch (error) {
    console.error(messageOf(error));
    console.error(USAGE);

    return 2;
  }

  const mailer = createMailerFromEnv();

  if (mailer.kind !== "http") {
    console.info(NOOP_LINE);

    return 3;
  }

  const { subject, html, text } = renderTemplate(options.template);

  console.info(`url_host=${urlHost(process.env[MAIL_API_URL_ENV])}`);

  try {
    await mailer.send({ to: options.to, subject, html, text });
  } catch (error) {
    console.info(`mailer=http failed: ${messageOf(error)}`);

    return 1;
  }

  console.info(
    `mailer=http sent to=${options.to} template=${options.template} subject=${subject}`,
  );

  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}

export { main as runMailSend };

/** Re-exported so callers cannot accidentally hard-code the variable names. */
export const MAIL_ENV_NAMES = [MAIL_API_URL_ENV, MAIL_API_TOKEN_ENV] as const;
