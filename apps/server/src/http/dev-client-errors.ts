import type { FastifyInstance } from "fastify";

/**
 * LOCAL FORK — development only.
 *
 * Browser-side failures (the red box in the bottom-left corner) never reach the
 * server log, so debugging them meant asking the user for screenshots. Worse,
 * some of them are invisible to the server by construction: a 401 is rejected by
 * the auth layer before any business code runs, so "the server log looks clean"
 * proves nothing about whether the app is actually working.
 *
 * This route lets the web app forward its own errors into the server's stdout,
 * so one log tail covers both sides.
 *
 * SECURITY: intentionally unauthenticated — the reporter runs before/outside any
 * session, and requiring a token would drop exactly the auth errors we care
 * about. It is therefore registered ONLY when NODE_ENV !== "production", accepts
 * nothing but strings, returns no data, and only ever writes to the log. Do not
 * enable it in a deployed environment.
 */

/** Hard caps so a runaway loop in the browser cannot flood the log. */
const MAX_ENTRIES_PER_REQUEST = 20;
const MAX_MESSAGE_CHARS = 600;
const MAX_STACK_FRAMES = 4;

type ClientErrorEntry = {
  kind?: unknown;
  message?: unknown;
  stack?: unknown;
  url?: unknown;
};

function asText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * Keep the frames that point at our own code. Next's dev build produces stacks
 * that are ~90% react-dom/webpack internals, which is what made the raw browser
 * console unreadable in the first place.
 */
function condenseStack(stack: unknown): string {
  if (typeof stack !== "string") return "";
  const frames = stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .filter(
      (line) =>
        !line.includes("/node_modules/") &&
        !line.includes("react-dom") &&
        !line.includes("react-server-dom"),
    )
    .map((line) =>
      line
        .replace(/^at\s+/, "")
        .replace("webpack-internal:///(app-pages-browser)/", "")
        .replace("webpack-internal:///", ""),
    )
    .slice(0, MAX_STACK_FRAMES);
  return frames.join(" | ");
}

export async function registerDevClientErrorRoutes(app: FastifyInstance) {
  if (process.env.NODE_ENV === "production") return;

  app.post("/api/dev/client-errors", async (request, reply) => {
    const body = request.body as { entries?: unknown } | undefined;
    const rawEntries = Array.isArray(body?.entries) ? body.entries : [];

    for (const raw of rawEntries.slice(0, MAX_ENTRIES_PER_REQUEST)) {
      const entry = (raw ?? {}) as ClientErrorEntry;
      const kind = asText(entry.kind, 40) || "error";
      const message = asText(entry.message, MAX_MESSAGE_CHARS) || "(no message)";
      const where = asText(entry.url, 200);
      const frames = condenseStack(entry.stack);

      // Goes through pino (stdout, timestamped) rather than console.error:
      // console.error writes to stderr, and a PowerShell-tee'd log turns every
      // stderr line into a multi-line error record, which mangles the output.
      // The "[client-error]" prefix is what scripts/temp/loomic-errors.ps1 greps.
      request.log.error(
        `[client-error] ${kind} | ${message}` +
          (frames ? ` | at ${frames}` : "") +
          (where ? ` | page=${where}` : ""),
      );
    }

    return reply.code(204).send();
  });
}
