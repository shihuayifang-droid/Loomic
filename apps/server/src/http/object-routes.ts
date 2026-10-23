// OP-05 / 43E: the read side of the private file volume.
//
// A link looks like `/objects/<bucket>/<key>?exp=...&sig=...` and is produced by
// `signObjectUrl` (43D). Nothing else - no cookie, no Authorization header - is
// required, because an `<img>` or a `<video>` element cannot send one: the
// signature IS the credential, and it expires.
//
// Every rejected link answers the SAME 403 with the same body on purpose:
// telling "expired" apart from "forged" would let a caller probe the secret.
//
// `Range` is supported because `<video preload="metadata">` sends it: one byte
// range per request (that is what browsers ask for), a 206 with `Content-Range`
// when it is satisfiable, a 416 when it starts past the end, and a plain 200
// when the header is not one we understand (RFC 9110 lets a server ignore it).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ObjectStoreError } from "../features/storage/object-store.js";
import type {
  ObjectRange,
  ObjectStore,
} from "../features/storage/object-store.js";
import { verifyObjectUrl } from "../features/storage/object-url-signature.js";

/** One answer for every rejected link: missing, expired and forged look alike. */
const FORBIDDEN_BODY = {
  error: { code: "forbidden", message: "Link is invalid or expired." },
};

const NOT_FOUND_BODY = {
  error: { code: "asset_not_found", message: "Asset not found." },
};

const BAD_KEY_BODY = {
  error: { code: "invalid_request", message: "Object address is not readable." },
};

const BACKEND_BODY = {
  error: { code: "application_error", message: "Storage backend failed." },
};

/** The signed link never caches for longer than an hour, however long it lives. */
const MAX_CACHE_SECONDS = 3600;

/** `bytes=a-b`, `bytes=a-`, `bytes=-n`. A comma (multi-range) never matches. */
const BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

/** A decoded key segment may never be, or smuggle, a path separator. */
const FORBIDDEN_SEGMENT = /[\\/\u0000]/;

export type ObjectRouteOptions = {
  store: ObjectStore;
  /** The same HMAC key the signer uses. */
  secret: Uint8Array;
  /** Injected clock, so a test can make a link expire without waiting. */
  now?: () => Date;
};

type RangeOutcome =
  | { kind: "ignore" }
  | { kind: "unsatisfiable" }
  | { kind: "partial"; range: ObjectRange };

/**
 * Read the wildcard part of the URL as an object key.
 *
 * Each segment is percent-decoded once (a key is addressed segment by segment,
 * never as a single opaque string), and anything that decodes into a separator,
 * a `.` or a `..` collapses to "" - an unreadable address, answered with 400
 * before the store is touched. That is the traversal guard on the HTTP side;
 * the store has its own, and both must hold.
 */
function decodeKey(raw: string | undefined): string {
  if (!raw) {
    return "";
  }

  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return "";
    }
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      FORBIDDEN_SEGMENT.test(decoded)
    ) {
      return "";
    }
    segments.push(decoded);
  }

  return segments.join("/");
}

/** Query values arrive as strings, or as arrays when the parameter repeats. */
function firstValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

/**
 * Turn a `Range` header into what to serve. Anything that is not a single
 * `bytes` range is IGNORED (a full 200), never an error.
 */
function parseRange(header: string | undefined, size: number): RangeOutcome {
  if (!header) {
    return { kind: "ignore" };
  }

  const match = BYTE_RANGE.exec(header.trim());
  if (!match) {
    return { kind: "ignore" };
  }

  const first = match[1] ?? "";
  const last = match[2] ?? "";
  if (!first && !last) {
    return { kind: "ignore" };
  }

  if (!first) {
    // `bytes=-n`: the last n bytes.
    const suffix = Number(last);
    if (suffix <= 0) {
      return { kind: "unsatisfiable" };
    }
    const start = Math.max(size - suffix, 0);
    if (size === 0) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "partial", range: { start, end: size - 1 } };
  }

  const start = Number(first);
  if (start >= size) {
    return { kind: "unsatisfiable" };
  }
  if (!last) {
    return { kind: "partial", range: { start } };
  }

  const end = Number(last);
  if (end < start) {
    return { kind: "ignore" };
  }
  return { kind: "partial", range: { start, end: Math.min(end, size - 1) } };
}

/** RFC 5987 `filename*` value: percent-encode everything that is not an attr-char. */
function encodeFilename(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export async function registerObjectRoutes(
  app: FastifyInstance,
  options: ObjectRouteOptions,
): Promise<void> {
  const clock = options.now ?? (() => new Date());
  const currentSeconds = (): number => Math.floor(clock().getTime() / 1000);

  /** Map a store failure onto a reply. Never logs the full key (it is a link). */
  function storeFailure(
    request: FastifyRequest,
    reply: FastifyReply,
    bucket: string,
    error: unknown,
  ): FastifyReply {
    if (error instanceof ObjectStoreError) {
      if (error.code === "invalid_key") {
        return reply.code(400).send(BAD_KEY_BODY);
      }
      if (error.code === "not_found") {
        return reply.code(404).send(NOT_FOUND_BODY);
      }
    }

    // The bucket only: the key is part of a usable (if short-lived) link.
    request.log.error({ bucket }, "object read failed");
    return reply.code(500).send(BACKEND_BODY);
  }

  const handler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const params = request.params as { bucket?: string; "*"?: string };
    const bucket = params.bucket ?? "";
    const key = decodeKey(params["*"]);

    if (!key) {
      return reply.code(400).send(BAD_KEY_BODY);
    }

    const query = (request.query ?? {}) as Record<string, unknown>;
    const verified = verifyObjectUrl({
      secret: options.secret,
      bucket,
      key,
      exp: firstValue(query.exp),
      disp: firstValue(query.disp),
      sig: firstValue(query.sig),
      now: currentSeconds(),
    });

    if (!verified.ok) {
      return reply.code(403).send(FORBIDDEN_BODY);
    }

    let head;
    try {
      head = await options.store.head({ bucket, key });
    } catch (error) {
      return storeFailure(request, reply, bucket, error);
    }

    if (!head) {
      return reply.code(404).send(NOT_FOUND_BODY);
    }

    // The link expires: never let a cache outlive it, and never cache in public.
    const expiresAt = Number(firstValue(query.exp) ?? "0");
    const remaining = expiresAt - currentSeconds();
    const maxAge = Math.max(0, Math.min(remaining, MAX_CACHE_SECONDS));

    reply.header("accept-ranges", "bytes");
    reply.header("content-type", head.contentType);
    reply.header("cache-control", `private, max-age=${maxAge}`);
    reply.header("x-content-type-options", "nosniff");
    if (verified.download) {
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeFilename(verified.download)}`,
      );
    }

    const outcome = parseRange(request.headers.range, head.size);

    if (outcome.kind === "unsatisfiable") {
      reply.header("content-range", `bytes */${head.size}`);
      return reply.code(416).send();
    }

    const isHead = request.method === "HEAD";

    if (isHead) {
      // Headers only: same status and framing a GET would produce. The empty
      // string keeps the `content-length` set above; a bare `send()` would let
      // Fastify replace it with 0.
      if (outcome.kind === "partial") {
        const end = outcome.range.end ?? head.size - 1;
        reply.header(
          "content-range",
          `bytes ${outcome.range.start}-${end}/${head.size}`,
        );
        reply.header("content-length", String(end - outcome.range.start + 1));
        return reply.code(206).send("");
      }
      reply.header("content-length", String(head.size));
      return reply.code(200).send("");
    }

    try {
      if (outcome.kind === "partial") {
        const read = await options.store.get({ bucket, key }, outcome.range);
        const served = read.range ?? outcome.range;
        const end = served.end ?? served.start + read.body.byteLength - 1;
        reply.header("content-range", `bytes ${served.start}-${end}/${read.size}`);
        reply.header("content-length", String(read.body.byteLength));
        return reply.code(206).send(read.body);
      }

      const read = await options.store.get({ bucket, key });
      reply.header("content-length", String(read.body.byteLength));
      return reply.code(200).send(read.body);
    } catch (error) {
      return storeFailure(request, reply, bucket, error);
    }
  };

  // GET and HEAD are registered explicitly, with `exposeHeadRoute` off: Fastify's
  // auto-generated HEAD twin replaces `content-length` with 0 (head-route.js), and
  // a HEAD must report the size the GET would serve.
  app.route({
    method: "GET",
    url: "/objects/:bucket/*",
    exposeHeadRoute: false,
    handler,
  });
  app.route({
    method: "HEAD",
    url: "/objects/:bucket/*",
    handler,
  });
}
