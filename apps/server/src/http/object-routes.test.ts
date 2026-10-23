// OP-05 / 43E: the `/objects` read route, exercised against a real file-volume
// store in a temporary directory and a Fastify instance that registers nothing
// but this route - so every status here comes from the route, not from a gate.
import { promises as fsp, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFsObjectStore } from "../features/storage/fs-object-store.js";
import {
  objectUrlSecretFrom,
  signObjectUrl,
} from "../features/storage/object-url-signature.js";
import { registerObjectRoutes } from "./object-routes.js";

const secret = objectUrlSecretFrom("0123456789abcdef0123456789abcdef");
const BUCKET = "project-assets";
const PUBLIC_BASE = "https://files.example.test";
/** Exactly 20 bytes, so the range arithmetic in the assertions is obvious. */
const BODY = Buffer.from("0123456789abcdefghij");

let sandbox: string;
let app: FastifyInstance;

/** A signed link for `key`, reduced to the path + query `inject` understands. */
function link(
  key: string,
  options: { exp?: number; download?: string } = {},
): string {
  const signed = signObjectUrl({
    secret,
    publicBase: PUBLIC_BASE,
    bucket: BUCKET,
    key,
    expiresAt: options.exp ?? Math.floor(Date.now() / 1000) + 600,
    ...(options.download ? { download: options.download } : {}),
  });
  return signed.slice(PUBLIC_BASE.length);
}

function queryOf(signed: string): string {
  return signed.slice(signed.indexOf("?"));
}

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), "object-routes-"));
  const store = createFsObjectStore({
    rootDir: path.join(sandbox, "root"),
    secret,
    publicBase: PUBLIC_BASE,
  });
  await store.put({ bucket: BUCKET, key: "a.png" }, BODY, {
    contentType: "text/plain",
  });

  app = Fastify();
  await registerObjectRoutes(app, { store, secret });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await fsp.rm(sandbox, { recursive: true, force: true });
});

describe("43E /objects read route", () => {
  it("serves a valid signed link in full, with range support advertised", async () => {
    const response = await app.inject({ method: "GET", url: link("a.png") });

    expect(response.statusCode).toBe(200);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(String(response.headers["content-type"])).toContain("text/plain");
    expect(String(response.headers["cache-control"])).toMatch(
      /^private, max-age=\d+$/,
    );
    expect(String(response.headers["x-content-type-options"])).toBe("nosniff");
    expect(response.rawPayload.byteLength).toBe(20);
    expect(response.body).toBe(BODY.toString("utf8"));
  });

  it("answers HEAD with the framing headers and no body", async () => {
    const response = await app.inject({ method: "HEAD", url: link("a.png") });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-length"]).toBe("20");
    expect(String(response.headers["accept-ranges"])).toBe("bytes");
    expect(response.body).toBe("");
  });

  it("refuses a missing sig, an expired link, a re-expired link and a re-keyed link with one 403", async () => {
    const valid = link("a.png");
    const withoutSig = valid.replace(/&sig=[^&]+/, "");
    const expired = link("a.png", {
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const reExpired = valid.replace(/(exp=)(\d+)/, (_match, name: string, value: string) => {
      return `${name}${Number(value) + 60}`;
    });
    const reKeyed = valid.replace("/a.png", "/b.png");

    const bodies: string[] = [];
    for (const target of [withoutSig, expired, reExpired, reKeyed]) {
      const response = await app.inject({ method: "GET", url: target });
      expect(response.statusCode).toBe(403);
      bodies.push(response.body);
    }

    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? "")).toEqual({
      error: { code: "forbidden", message: "Link is invalid or expired." },
    });
  });

  it("answers a signed link to an absent object with 404", async () => {
    const response = await app.inject({ method: "GET", url: link("nope.png") });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: "asset_not_found" },
    });
  });

  it("serves the three single byte ranges and a 416 past the end", async () => {
    const head = await app.inject({
      method: "GET",
      url: link("a.png"),
      headers: { range: "bytes=0-9" },
    });
    expect(head.statusCode).toBe(206);
    expect(head.headers["content-range"]).toBe("bytes 0-9/20");
    expect(head.headers["content-length"]).toBe("10");
    expect(head.rawPayload.byteLength).toBe(10);
    expect(head.body).toBe(BODY.subarray(0, 10).toString("utf8"));

    const open = await app.inject({
      method: "GET",
      url: link("a.png"),
      headers: { range: "bytes=15-" },
    });
    expect(open.statusCode).toBe(206);
    expect(open.headers["content-range"]).toBe("bytes 15-19/20");
    expect(open.rawPayload.byteLength).toBe(5);
    expect(open.body).toBe(BODY.subarray(15).toString("utf8"));

    const suffix = await app.inject({
      method: "GET",
      url: link("a.png"),
      headers: { range: "bytes=-5" },
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers["content-range"]).toBe("bytes 15-19/20");
    expect(suffix.body).toBe(BODY.subarray(15).toString("utf8"));

    const past = await app.inject({
      method: "GET",
      url: link("a.png"),
      headers: { range: "bytes=20-" },
    });
    expect(past.statusCode).toBe(416);
    expect(past.headers["content-range"]).toBe("bytes */20");
    expect(past.body).toBe("");
  });

  it("ignores a multi-range request and serves the whole object", async () => {
    const response = await app.inject({
      method: "GET",
      url: link("a.png"),
      headers: { range: "bytes=0-1,4-5" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.byteLength).toBe(20);
    expect(response.body).toBe(BODY.toString("utf8"));
  });

  it("turns a named download into an attachment with a UTF-8 filename", async () => {
    const name = "项目 图标.png";
    const response = await app.inject({
      method: "GET",
      url: link("a.png", { download: name }),
    });

    expect(response.statusCode).toBe(200);
    const disposition = String(response.headers["content-disposition"]);
    expect(disposition.startsWith("attachment; filename*=UTF-8''")).toBe(true);
    expect(disposition).toContain(encodeURIComponent(name));
  });

  it("never serves a signed key that tries to leave the bucket", async () => {
    const query = queryOf(link("../../etc/passwd"));
    const response = await app.inject({
      method: "GET",
      url: `/objects/${BUCKET}/..%2F..%2Fetc%2Fpasswd${query}`,
    });

    expect(response.statusCode).not.toBe(200);
    expect([400, 403]).toContain(response.statusCode);
  });

  // The default (Supabase) install must not expose `/objects` at all. Building
  // the whole app here would drag in a database, so the condition is read from
  // the source: the call must sit inside the `storageProvider === "fs"` block.
  it("registers the route only inside the file-volume branch of app.ts", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const guard = source.indexOf('if (env.storageProvider === "fs")');
    const call = source.indexOf("registerObjectRoutes(app");

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(guard);
    expect(call).toBeLessThan(source.indexOf("\n  }", guard));
  });
});
