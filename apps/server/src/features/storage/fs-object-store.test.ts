import { promises as fsp, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFsObjectStore } from "./fs-object-store.js";
import { ObjectStoreError } from "./object-store.js";
import type { ObjectStore } from "./object-store.js";
import {
  objectUrlSecretFrom,
  verifyObjectUrl,
} from "./object-url-signature.js";

const secret = objectUrlSecretFrom("0123456789abcdef0123456789abcdef");

let sandbox: string;
let rootDir: string;
let store: ObjectStore;

async function listAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listAll(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof ObjectStoreError ? error.code : "other";
  }
}

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), "fs-object-store-"));
  rootDir = path.join(sandbox, "root");
  await fsp.mkdir(rootDir);
  store = createFsObjectStore({
    rootDir,
    secret,
    publicBase: "https://files.example.test",
    now: () => new Date(2_000_000_000_000),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(sandbox, { recursive: true, force: true });
});

const ref = { bucket: "assets", key: "ws/proj/file.bin" };
const data = Buffer.from("0123456789");

describe("fs-object-store", () => {
  it("round-trips put / get / head / delete", async () => {
    await store.put(ref, data, { contentType: "image/png" });
    const got = await store.get(ref);
    expect(got.body.equals(data)).toBe(true);
    expect(got.size).toBe(10);
    expect(got.contentType).toBe("image/png");
    expect(got.range).toBeUndefined();
    expect(await store.head(ref)).toEqual({ size: 10, contentType: "image/png" });

    await store.delete([ref]);
    expect(await store.head(ref)).toBeNull();
    expect(await code(store.get(ref))).toBe("not_found");
    await store.delete([ref]); // idempotent
    expect(await listAll(rootDir)).toEqual([]);
  });

  it("copies content and metadata, across buckets too", async () => {
    await store.put(ref, data, { contentType: "image/png" });
    const to = { bucket: "other", key: "x/copy.bin" };
    await store.copy(ref, to);
    const got = await store.get(to);
    expect(got.body.equals(data)).toBe(true);
    expect(got.contentType).toBe("image/png");
    expect(await code(store.copy({ bucket: "assets", key: "nope" }, to))).toBe("not_found");
  });

  it("fails a repeated put with exists, and upsert replaces", async () => {
    await store.put(ref, data, { contentType: "a/b" });
    expect(await code(store.put(ref, Buffer.from("zz"), { contentType: "a/b" }))).toBe("exists");
    expect((await store.get(ref)).body.equals(data)).toBe(true);

    await store.put(ref, Buffer.from("zz"), { contentType: "c/d", upsert: true });
    const got = await store.get(ref);
    expect(got.body.toString()).toBe("zz");
    expect(got.contentType).toBe("c/d");
    const leftovers = (await listAll(rootDir)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("serves byte ranges with inclusive ends", async () => {
    await store.put(ref, data, { contentType: "a/b" });
    const mid = await store.get(ref, { start: 2, end: 4 });
    expect(mid.body.toString()).toBe("234");
    expect(mid.range).toEqual({ start: 2, end: 4 });
    expect(mid.size).toBe(10);

    const tail = await store.get(ref, { start: 5 });
    expect(tail.body.toString()).toBe("56789");
    expect(tail.range).toEqual({ start: 5, end: 9 });

    const clamped = await store.get(ref, { start: 8, end: 100 });
    expect(clamped.body.toString()).toBe("89");
    expect(clamped.range).toEqual({ start: 8, end: 9 });

    await expect(store.get(ref, { start: 10 })).rejects.toMatchObject({
      code: "invalid_key",
      message: "range not satisfiable",
    });
  });

  it("falls back to octet-stream without a meta file", async () => {
    await store.put(ref, data, { contentType: "image/png" });
    await fsp.rm(path.join(rootDir, "assets", "ws", "proj", "file.bin.meta.json"));
    expect((await store.get(ref)).contentType).toBe("application/octet-stream");
    expect((await store.head(ref))?.contentType).toBe("application/octet-stream");
  });

  it("rejects hostile addresses and creates nothing outside the root", async () => {
    const bad = [
      { bucket: "assets", key: "../x" },
      { bucket: "assets", key: "a/../../x" },
      { bucket: "assets", key: "/abs" },
      { bucket: "assets", key: "a\\b" },
      { bucket: "assets", key: "a//b" },
      { bucket: "assets", key: "a/file.meta.json" },
      { bucket: "assets", key: "" },
      { bucket: "assets", key: "a/./b" },
      { bucket: "assets", key: "a\0b" },
      { bucket: "..", key: "x" },
      { bucket: "A", key: "x" },
    ];
    for (const badRef of bad) {
      expect(await code(store.put(badRef, data, { contentType: "a/b" }))).toBe("invalid_key");
      expect(await code(store.get(badRef))).toBe("invalid_key");
      expect(await code(store.head(badRef))).toBe("invalid_key");
      expect(await code(store.delete([badRef]))).toBe("invalid_key");
      expect(await code(store.copy(badRef, ref))).toBe("invalid_key");
      expect(await code(store.signedReadUrl(badRef, { ttlSeconds: 60 }))).toBe("invalid_key");
    }
    expect(await listAll(sandbox)).toEqual([]);
  });

  it("leaves no target and no .tmp when the rename fails", async () => {
    const spy = vi.spyOn(fsp, "rename").mockRejectedValue(
      Object.assign(new Error("boom"), { code: "EIO" }),
    );
    expect(
      await code(store.put(ref, data, { contentType: "a/b", upsert: true })),
    ).toBe("backend_failed");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    const files = await listAll(rootDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(files.filter((f) => !f.endsWith(".meta.json") && !f.endsWith(".tmp"))).toEqual([]);
    expect(await store.head(ref)).toBeNull();
  });

  it("signs read URLs that verifyObjectUrl accepts", async () => {
    const url = await store.signedReadUrl(
      { bucket: "assets", key: "ws/proj/my-file.png" },
      { ttlSeconds: 120, download: "我的 图.png" },
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/objects/assets/ws/proj/my-file.png");
    expect(parsed.searchParams.get("exp")).toBe(String(2_000_000_000 + 120));

    const verified = verifyObjectUrl({
      secret,
      bucket: "assets",
      key: "ws/proj/my-file.png",
      exp: parsed.searchParams.get("exp") ?? undefined,
      disp: parsed.searchParams.get("disp") ?? undefined,
      sig: parsed.searchParams.get("sig") ?? undefined,
      now: 2_000_000_000,
    });
    expect(verified).toEqual({ ok: true, download: "我的 图.png" });
  });

  it("does not depend on the previous storage backend", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "fs-object-store.ts"),
      "utf8",
    );
    expect(source.toLowerCase()).not.toContain("supa" + "base");
  });
});

// 43I: the batch spelling on the volume signs each key on its own, and a key the
// volume would reject is skipped instead of costing the caller every other URL.
describe("43I fs-object-store signedReadUrls", () => {
  it("signs every key so verifyObjectUrl accepts it", async () => {
    const keys = ["ws/a.png", "ws/b.pdf"];
    const urls = await store.signedReadUrls("assets", keys, { ttlSeconds: 300 });

    expect([...urls.keys()]).toStrictEqual(keys);
    for (const key of keys) {
      const parsed = new URL(urls.get(key) ?? "");
      expect(parsed.pathname).toBe(`/objects/assets/${key}`);
      expect(parsed.searchParams.get("exp")).toBe(String(2_000_000_000 + 300));

      const verified = verifyObjectUrl({
        secret,
        bucket: "assets",
        key,
        exp: parsed.searchParams.get("exp") ?? undefined,
        disp: parsed.searchParams.get("disp") ?? undefined,
        sig: parsed.searchParams.get("sig") ?? undefined,
        now: 2_000_000_000,
      });
      expect(verified.ok).toBe(true);
    }
  });

  it("skips an invalid key and still signs the valid ones", async () => {
    const urls = await store.signedReadUrls(
      "assets",
      ["../x", "ws/ok.png", "a\\b", ""],
      { ttlSeconds: 60 },
    );

    expect([...urls.keys()]).toStrictEqual(["ws/ok.png"]);
  });
});
