import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFsObjectStore } from "./fs-object-store.js";
import { createObjectStoreStorageClient } from "./object-store-storage-client.js";
import type { ObjectStore } from "./object-store.js";
import { objectUrlSecretFrom } from "./object-url-signature.js";
import {
  signProjectAssetUrl,
  signProjectAssetUrls,
} from "./project-asset-urls.js";
import { createSupabaseObjectStore } from "./supabase-object-store.js";
import type { SupabaseStorageLike } from "./supabase-object-store.js";

const PUBLIC_BASE = "http://test.invalid";
const BUCKET = "project-assets";

let sandbox: string;
let fsStore: ObjectStore;
let adapter: SupabaseStorageLike;
let viaAdapter: ObjectStore;

beforeEach(async () => {
  sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), "os-storage-client-"));
  fsStore = createFsObjectStore({
    rootDir: sandbox,
    secret: objectUrlSecretFrom("0123456789abcdef0123456789abcdef"),
    publicBase: PUBLIC_BASE,
  });
  adapter = createObjectStoreStorageClient(fsStore);
  viaAdapter = createSupabaseObjectStore(adapter);
}, 60_000);

afterEach(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true });
}, 60_000);

const ref = (key: string) => ({ bucket: BUCKET, key });

describe("createObjectStoreStorageClient", () => {
  it("puts and gets an object, and a second put without upsert is `exists`", async () => {
    await viaAdapter.put(ref("ws/p/a.bin"), Buffer.from("hello"), {
      contentType: "image/png",
    });

    const read = await viaAdapter.get(ref("ws/p/a.bin"));
    expect(read.body.toString()).toBe("hello");
    expect(read.size).toBe(5);
    expect(read.contentType).toBe("image/png");

    await expect(
      viaAdapter.put(ref("ws/p/a.bin"), Buffer.from("again"), {
        contentType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "exists" });

    await viaAdapter.put(ref("ws/p/a.bin"), Buffer.from("again"), {
      contentType: "image/png",
      upsert: true,
    });
    expect((await viaAdapter.get(ref("ws/p/a.bin"))).body.toString()).toBe(
      "again",
    );

    // The bytes really are on the volume, reachable without the adapter.
    expect((await fsStore.get(ref("ws/p/a.bin"))).body.toString()).toBe(
      "again",
    );
  }, 60_000);

  it("serves a byte range", async () => {
    await viaAdapter.put(ref("r.bin"), Buffer.from("0123456789"), {
      contentType: "application/octet-stream",
    });

    const part = await viaAdapter.get(ref("r.bin"), { start: 2, end: 4 });
    expect(part.body.toString()).toBe("234");
    expect(part.size).toBe(10);
    expect(part.range).toEqual({ start: 2, end: 4 });
  }, 60_000);

  it("reports a missing object on get as a backend failure", async () => {
    await expect(viaAdapter.get(ref("missing.bin"))).rejects.toMatchObject({
      code: "backend_failed",
    });
  }, 60_000);
  it("copies and deletes", async () => {
    await viaAdapter.put(ref("c/src.bin"), Buffer.from("copy-me"), {
      contentType: "text/plain",
    });

    await viaAdapter.copy(ref("c/src.bin"), ref("c/dst.bin"));
    expect((await viaAdapter.get(ref("c/dst.bin"))).body.toString()).toBe(
      "copy-me",
    );

    await viaAdapter.delete([ref("c/src.bin"), ref("c/dst.bin")]);
    expect(await fsStore.head(ref("c/src.bin"))).toBeNull();
    expect(await fsStore.head(ref("c/dst.bin"))).toBeNull();
    // Deleting what is not there is not an error.
    await viaAdapter.delete([ref("c/src.bin")]);
  }, 60_000);

  it("signs one URL on the public prefix, carrying the download name", async () => {
    const url = await viaAdapter.signedReadUrl(ref("s/a.png"), {
      ttlSeconds: 60,
      download: "my picture.png",
    });
    expect(url.startsWith(`${PUBLIC_BASE}/objects/`)).toBe(true);
    expect(url).toContain("disp=");
  }, 60_000);

  it("signs many URLs and skips a key the volume refuses", async () => {
    const signed = await viaAdapter.signedReadUrls(
      BUCKET,
      ["s/a.png", "s/b.png", "../escape.png"],
      { ttlSeconds: 60 },
    );
    expect([...signed.keys()].sort()).toEqual(["s/a.png", "s/b.png"]);
    for (const url of signed.values()) {
      expect(url.startsWith(`${PUBLIC_BASE}/objects/`)).toBe(true);
    }
  }, 60_000);

  it("signProjectAssetUrl(s) land on the same public prefix", async () => {
    const one = await signProjectAssetUrl(adapter as never, "p/one.png");
    expect(one.startsWith(`${PUBLIC_BASE}/objects/`)).toBe(true);

    const many = await signProjectAssetUrls(adapter as never, [
      "p/one.png",
      "p/two.png",
    ]);
    expect(many.size).toBe(2);
    for (const url of many.values()) {
      expect(url.startsWith(`${PUBLIC_BASE}/objects/`)).toBe(true);
    }
  }, 60_000);

  it("refuses a listing, so head through the Supabase wrapper fails loudly", async () => {
    await expect(viaAdapter.head(ref("p/a.png"))).rejects.toMatchObject({
      code: "backend_failed",
      detail: "list is not supported by the object store adapter",
    });
  }, 60_000);
});
