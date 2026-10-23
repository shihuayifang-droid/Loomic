// 43B: the Supabase backend must forward EXACTLY what the call sites send today.
// Every case records the client calls and asserts the arguments verbatim, so a
// later refactor of the wrapper cannot silently drop `upsert`, `contentType`, a
// transform or a download name.
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadServerEnv } from "../../config/env.js";
import { createObjectStore } from "./object-store-factory.js";
import { ObjectStoreError } from "./object-store.js";
import { createSupabaseObjectStore } from "./supabase-object-store.js";
import type { SupabaseStorageLike } from "./supabase-object-store.js";

const BUCKET = "project-assets";

type Recorded = { method: string; args: readonly unknown[] };
type Handler = (...args: unknown[]) => unknown;

/**
 * A bucket handle whose six methods record their arguments and answer from
 * `handlers`. `from(name)` on the client records the bucket it was asked for, so
 * a case can prove the bucket really travels through.
 */
function recordingBucket(
  recorded: Recorded[],
  handlers: Record<string, Handler> = {},
) {
  const wrap = (method: string, fallback: Handler): Handler =>
    (...args: unknown[]) => {
      recorded.push({ method, args });
      return (handlers[method] ?? fallback)(...args);
    };

  return {
    upload: wrap("upload", () => ({ data: { path: "stored" }, error: null })),
    download: wrap("download", () => ({
      data: null,
      error: { message: "download not stubbed" },
    })),
    remove: wrap("remove", () => ({ data: [], error: null })),
    copy: wrap("copy", () => ({ data: { path: "copied" }, error: null })),
    createSignedUrl: wrap("createSignedUrl", () => ({
      data: { signedUrl: "https://example.invalid/object" },
      error: null,
    })),
    list: wrap("list", () => ({ data: [], error: null })),
  };
}

function clientFor(bucketApi: object, recorded: Recorded[]): SupabaseStorageLike {
  const client = {
    storage: {
      from(name: string) {
        recorded.push({ method: "from", args: [name] });
        return bucketApi;
      },
    },
  };

  return client as unknown as SupabaseStorageLike;
}

/** A downloaded object with a known label, shaped like the SDK's `Blob`. */
function downloaded(bytes: string, contentType?: string) {
  const buffer = Buffer.from(bytes, "utf8");
  return {
    data: {
      ...(contentType === undefined ? {} : { type: contentType }),
      async arrayBuffer(): Promise<ArrayBuffer> {
        return Uint8Array.from(buffer).buffer as ArrayBuffer;
      },
    },
    error: null,
  };
}

function storeWith(
  recorded: Recorded[],
  handlers: Record<string, Handler> = {},
  bucketApi: object = recordingBucket(recorded, handlers),
) {
  const store = createSupabaseObjectStore(clientFor(bucketApi, recorded));
  return { store, bucketApi };
}

const objectRef = (key: string, bucket = BUCKET) => ({ bucket, key });

describe("43B Supabase object store: put", () => {
  it("43B: put uploads the bytes with the content type and an explicit upsert", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded);
    const body = Buffer.from("png-bytes", "utf8");

    await store.put(objectRef("a/b.png"), body, { contentType: "image/png" });

    expect(recorded.map((call) => call.method)).toEqual(["from", "upload"]);
    expect(recorded[0]?.args).toStrictEqual([BUCKET]);
    expect(recorded[1]?.args).toStrictEqual([
      "a/b.png",
      body,
      { contentType: "image/png", upsert: false },
    ]);
  });

  it("43B: put forwards upsert=true", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded);
    const body = Buffer.from("overwrite", "utf8");

    await store.put(objectRef("a/b.png"), body, {
      contentType: "image/png",
      upsert: true,
    });

    expect(recorded[1]?.args).toStrictEqual([
      "a/b.png",
      body,
      { contentType: "image/png", upsert: true },
    ]);
  });

  it("43B: put maps a 409 to exists", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      upload: () => ({
        data: null,
        error: { message: "The resource already exists", statusCode: "409" },
      }),
    });

    const failure = store.put(objectRef("a.png"), Buffer.from("x"), {
      contentType: "text/plain",
    });

    await expect(failure).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(failure).rejects.toMatchObject({ code: "exists" });
  });

  it("43B: put maps an already-exists message without a status to exists", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      upload: () => ({
        data: null,
        error: { message: "The resource already exists" },
      }),
    });

    await expect(
      store.put(objectRef("a.png"), Buffer.from("x"), {
        contentType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "exists" });
  });

  it("43B: put maps any other backend error to backend_failed", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      upload: () => ({ data: null, error: { message: "bucket is gone" } }),
    });

    await expect(
      store.put(objectRef("a.png"), Buffer.from("x"), {
        contentType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "backend_failed" });
  });

  it("43F: put keeps the raw backend message in ObjectStoreError.detail", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      upload: () => ({
        data: null,
        error: { message: "bucket is gone" },
      }),
    });

    const failure = store.put(objectRef("a.png"), Buffer.from("x"), {
      contentType: "text/plain",
    });

    await expect(failure).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(failure).rejects.toMatchObject({
      code: "backend_failed",
      detail: "bucket is gone",
    });
  });
});

describe("43B Supabase object store: get", () => {
  it("43B: get returns the bytes, the size and the backend label", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      download: () => downloaded("abcdefgh", "image/png"),
    });

    const result = await store.get(objectRef("k.png"));

    expect(recorded.map((call) => call.method)).toEqual(["from", "download"]);
    expect(recorded[1]?.args).toStrictEqual(["k.png"]);
    expect(result.body.toString("utf8")).toBe("abcdefgh");
    expect(result.size).toBe(8);
    expect(result.contentType).toBe("image/png");
    expect(result.range).toBeUndefined();
  });

  it("43B: get with start=2,end=4 returns three bytes and echoes the range", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      download: () => downloaded("abcdefgh", "image/png"),
    });

    const result = await store.get(objectRef("k.png"), { start: 2, end: 4 });

    expect(result.body.toString("utf8")).toBe("cde");
    expect(result.body.byteLength).toBe(3);
    expect(result.size).toBe(8);
    expect(result.range).toStrictEqual({ start: 2, end: 4 });
  });

  it("43B: get clamps an end past the last byte and echoes the served range", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      download: () => downloaded("abcdefgh", "image/png"),
    });

    const result = await store.get(objectRef("k.png"), { start: 6, end: 99 });

    expect(result.body.toString("utf8")).toBe("gh");
    expect(result.range).toStrictEqual({ start: 6, end: 7 });
  });

  it("43B: get labels an unlabelled object with a generic type", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      download: () => downloaded("abc"),
    });

    const result = await store.get(objectRef("k.bin"));

    expect(result.contentType).toBe("application/octet-stream");
  });

  it("43B: get fails with backend_failed when the download errors", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      download: () => ({ data: null, error: { message: "Object not found" } }),
    });

    await expect(store.get(objectRef("k.png"))).rejects.toMatchObject({
      code: "backend_failed",
    });
  });
});

describe("43B Supabase object store: head", () => {
  const listing = {
    list: () => ({
      data: [
        { name: "other.png", metadata: { size: 1, mimetype: "image/png" } },
        { name: "c.png", metadata: { size: 42, mimetype: "image/webp" } },
        { name: "sub", metadata: null },
      ],
      error: null,
    }),
  };

  it("43B: head lists the parent directory and reports size and type", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, listing);

    const result = await store.head(objectRef("a/b/c.png"));

    expect(recorded.map((call) => call.method)).toEqual(["from", "list"]);
    expect(recorded[1]?.args).toStrictEqual(["a/b"]);
    expect(result).toStrictEqual({ size: 42, contentType: "image/webp" });
  });

  it("43B: head lists the bucket root for a key without a directory", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, listing);

    await store.head(objectRef("c.png"));

    expect(recorded[1]?.args).toStrictEqual([""]);
  });

  it("43B: head returns null when the listing has no such entry", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, listing);

    expect(await store.head(objectRef("a/b/missing.png"))).toBeNull();
  });

  it("43B: head returns null for an entry without metadata", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, listing);

    expect(await store.head(objectRef("a/b/sub"))).toBeNull();
  });

  it("43B: head fails with backend_failed when the listing errors", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      list: () => ({ data: null, error: { message: "permission denied" } }),
    });

    await expect(store.head(objectRef("a.png"))).rejects.toMatchObject({
      code: "backend_failed",
    });
  });
});

describe("43B Supabase object store: delete and copy", () => {
  it("43B: delete groups the keys per bucket", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded);

    await store.delete([
      objectRef("a.png"),
      objectRef("b.png"),
      objectRef("c.png", "other-bucket"),
      objectRef("a.png"),
    ]);

    expect(recorded.map((call) => call.method)).toEqual([
      "from",
      "remove",
      "from",
      "remove",
    ]);
    expect(recorded[0]?.args).toStrictEqual([BUCKET]);
    expect(recorded[1]?.args).toStrictEqual([["a.png", "b.png", "a.png"]]);
    expect(recorded[2]?.args).toStrictEqual(["other-bucket"]);
    expect(recorded[3]?.args).toStrictEqual([["c.png"]]);
  });

  it("43B: delete with nothing to remove issues no request", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded);

    await store.delete([]);

    expect(recorded).toStrictEqual([]);
  });

  it("43B: copy copies within one bucket", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded);

    await store.copy(objectRef("a.png"), objectRef("b.png"));

    expect(recorded.map((call) => call.method)).toEqual(["from", "copy"]);
    expect(recorded[1]?.args).toStrictEqual(["a.png", "b.png"]);
  });

  it("43B: copy refuses a cross-bucket request with invalid_key", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded);

    const failure = store.copy(objectRef("a.png"), objectRef("b.png", "elsewhere"));

    await expect(failure).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(failure).rejects.toMatchObject({ code: "invalid_key" });
    expect(recorded.map((call) => call.method)).toEqual([]);
  });

  it("43B: copy fails with backend_failed when the backend errors", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      copy: () => ({ data: null, error: { message: "source missing" } }),
    });

    await expect(
      store.copy(objectRef("a.png"), objectRef("b.png")),
    ).rejects.toMatchObject({ code: "backend_failed" });
  });
});

describe("43B Supabase object store: signedReadUrl", () => {
  it("43B: signedReadUrl sends no options when there is nothing to say", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded);

    const url = await store.signedReadUrl(objectRef("a.png"), {
      ttlSeconds: 3600,
    });

    expect(recorded.map((call) => call.method)).toEqual([
      "from",
      "createSignedUrl",
    ]);
    expect(recorded[1]?.args).toStrictEqual(["a.png", 3600, undefined]);
    expect(url).toBe("https://example.invalid/object");
  });

  it("43B: signedReadUrl forwards the transform and the download name", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded);
    const transform = { width: 320, resize: "contain" } as const;

    await store.signedReadUrl(objectRef("a.png"), {
      ttlSeconds: 60,
      transform,
      download: "名字.png",
    });

    expect(recorded[1]?.args).toStrictEqual([
      "a.png",
      60,
      { transform, download: "名字.png" },
    ]);
  });

  it("43B: signedReadUrl sends only the download name when there is no transform", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded);

    await store.signedReadUrl(objectRef("a.png"), {
      ttlSeconds: 60,
      download: "report.pdf",
    });

    expect(recorded[1]?.args).toStrictEqual([
      "a.png",
      60,
      { download: "report.pdf" },
    ]);
  });

  it("43B: signedReadUrl fails with backend_failed when the backend errors", async () => {
    const recorded: Recorded[] = [];
    const { store } = storeWith(recorded, {
      createSignedUrl: () => ({
        data: null,
        error: { message: "permission denied" },
      }),
    });

    await expect(
      store.signedReadUrl(objectRef("a.png"), { ttlSeconds: 60 }),
    ).rejects.toMatchObject({ code: "backend_failed" });
  });
});

/**
 * 43B: the factory sits at the end of this file on purpose - it only decides
 * WHICH backend, and the backend it picks is the one tested above.
 */
describe("43B createObjectStore factory", () => {
  const envFrom = (source: NodeJS.ProcessEnv = {}) =>
    loadServerEnv({ version: "0.0.0-test" }, { NODE_ENV: "development", ...source });

  it("43B: an unset provider selects Supabase and takes the client lazily", async () => {
    const recorded: Recorded[] = [];
    const bucketApi = recordingBucket(recorded);
    let clientCalls = 0;

    const store = createObjectStore(envFrom(), {
      supabaseClient: () => {
        clientCalls += 1;
        return clientFor(bucketApi, recorded);
      },
    });

    expect(clientCalls).toBe(0);

    await store.put(objectRef("a.png"), Buffer.from("x"), {
      contentType: "text/plain",
    });

    expect(clientCalls).toBe(1);
    expect(recorded.map((call) => call.method)).toEqual(["from", "upload"]);
  });

  it("43B: provider supabase selects the same backend as unset", async () => {
    const recorded: Recorded[] = [];
    let clientCalls = 0;

    const store = createObjectStore(envFrom({ HAHART_STORAGE_PROVIDER: "supabase" }), {
      supabaseClient: () => {
        clientCalls += 1;
        return clientFor(recordingBucket(recorded), recorded);
      },
    });

    await store.delete([]);

    expect(clientCalls).toBe(1);
  });

  // 43E: the placeholder used to throw "not implemented". The file volume now
  // exists, so the same switch must yield a working store - proven by writing
  // and reading an object in a temporary directory.
  it("43E: provider fs builds a file-volume store that can put and get", async () => {
    const rootDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "object-store-factory-"),
    );
    try {
      const store = createObjectStore(
        envFrom({
          HAHART_STORAGE_PROVIDER: "fs",
          HAHART_OBJECT_ROOT: rootDir,
          HAHART_OBJECT_URL_SECRET: "0123456789abcdef0123456789abcdef",
          HAHART_OBJECT_PUBLIC_BASE: "https://files.example.test",
        }),
        {
          supabaseClient: () => {
            throw new Error("the client must not be touched for fs");
          },
        },
      );

      await store.put(objectRef("a.png"), Buffer.from("hello"), {
        contentType: "text/plain",
      });

      const read = await store.get(objectRef("a.png"));

      expect(read.contentType).toBe("text/plain");
      expect(read.size).toBe(5);
      expect(read.body.toString("utf8")).toBe("hello");
    } finally {
      await fsp.rm(rootDir, { recursive: true, force: true });
    }
  });
});
