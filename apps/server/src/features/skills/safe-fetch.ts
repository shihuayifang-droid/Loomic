/**
 * SK-16: the only way the skill importer / marketplace is allowed to reach the
 * network.
 *
 * Three things it guarantees, each of which the previous bare `fetch` calls did
 * not:
 *   1. **Host allowlist, checked before the request is sent** — including on
 *      every redirect hop. `redirect: "manual"` + re-validation means an
 *      internal address can never be reached "on the way" to an allowed host.
 *   2. **A single overall deadline** covering all hops *and* the body read,
 *      instead of one timeout per hop.
 *   3. **A hard size cap that also works without `content-length`** — the
 *      marketplace responses are chunked and send no length, so the body is
 *      counted while it is read and aborted the moment it goes over.
 *
 * The returned `Response` is fully buffered, so callers keep using `.status`,
 * `.ok`, `.headers`, `.json()`, `.text()` and `.arrayBuffer()` unchanged.
 */

export const SKILL_FETCH_ALLOWED_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "skills.sh",
  "api.github.com",
  "raw.githubusercontent.com",
  "github.com",
];

export type SafeFetchErrorCode =
  | "bad_url"
  | "host_not_allowed"
  | "too_many_redirects"
  | "timeout"
  | "too_large";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;

  constructor(code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

/** Statuses that must not carry a body when rebuilding the Response. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function validateUrl(raw: string, allowedHosts: readonly string[]): URL {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new SafeFetchError("bad_url", `Not a valid absolute URL: ${raw}`);
  }

  // Exact host match — `endsWith`/`includes` would let
  // registry.npmjs.org.evil.example through. Checked before the scheme and the
  // port so an address we do not talk to at all is reported as a host problem
  // (that is the more specific reason), and so a redirect to a plain-http
  // internal address is rejected as host_not_allowed too.
  const host = parsed.hostname.toLowerCase();

  if (!allowedHosts.includes(host)) {
    throw new SafeFetchError("host_not_allowed", `Host is not allowed: ${host}`);
  }

  if (parsed.protocol !== "https:") {
    throw new SafeFetchError("bad_url", `Only https is allowed: ${raw}`);
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new SafeFetchError("bad_url", "Credentials in the URL are not allowed");
  }

  if (parsed.port !== "" && parsed.port !== "443") {
    throw new SafeFetchError("bad_url", `Only the default https port is allowed: ${parsed.port}`);
  }

  return parsed;
}

async function bufferWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Response> {
  const declared = response.headers.get("content-length");

  if (declared !== null) {
    const size = Number(declared);

    // Over the cap on the declared length alone: refuse without reading a byte.
    if (Number.isFinite(size) && size > maxBytes) {
      throw new SafeFetchError(
        "too_large",
        `Response is larger than ${maxBytes} bytes (content-length: ${size})`,
      );
    }
  }

  const body = response.body;

  if (body === null) {
    return rebuildResponse(new Uint8Array(0), response);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    if (!value) continue;

    total += value.byteLength;

    // No content-length (chunked) — this is the only defence, so count as we go
    // and stop the download the moment it goes over.
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SafeFetchError(
        "too_large",
        `Response is larger than ${maxBytes} bytes`,
      );
    }

    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return rebuildResponse(merged, response);
}

function rebuildResponse(bytes: Uint8Array<ArrayBuffer>, source: Response): Response {
  if (NULL_BODY_STATUSES.has(source.status)) {
    return new Response(null, {
      status: source.status,
      statusText: source.statusText,
      headers: source.headers,
    });
  }

  return new Response(bytes, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
  });
}

export async function safeFetch(
  url: string,
  init?: { headers?: Record<string, string> },
  options?: {
    allowedHosts?: readonly string[];
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<Response> {
  const allowedHosts = options?.allowedHosts ?? SKILL_FETCH_ALLOWED_HOSTS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchImpl = options?.fetchImpl ?? fetch;

  // One deadline for the whole operation — every hop and the body read share it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = validateUrl(url, allowedHosts);
    let redirects = 0;

    // `exactOptionalPropertyTypes` is on, so an absent `headers` must be absent
    // rather than explicitly undefined.
    const requestInit: RequestInit = {
      redirect: "manual",
      signal: controller.signal,
      ...(init?.headers ? { headers: init.headers } : {}),
    };

    for (;;) {
      const response = await fetchImpl(current.toString(), requestInit);

      if (response.status >= 300 && response.status < 400) {
        if (redirects >= maxRedirects) {
          throw new SafeFetchError(
            "too_many_redirects",
            `More than ${maxRedirects} redirects starting at ${url}`,
          );
        }

        const location = response.headers.get("location");

        if (!location) {
          throw new SafeFetchError("bad_url", `Redirect without a Location header: ${current}`);
        }

        // Validate BEFORE the next request goes out: a redirect to an internal
        // address must never be fetched, not even once.
        current = validateUrl(new URL(location, current).toString(), allowedHosts);
        redirects += 1;
        continue;
      }

      return await bufferWithLimit(response, maxBytes);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new SafeFetchError("timeout", `Request timed out after ${timeoutMs} ms: ${url}`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
