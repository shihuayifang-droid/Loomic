// 43B: the in-memory double has to behave like the real backend, otherwise the
// migration tickets that assert against it would be testing the double instead
// of the contract. Every case here mirrors a rule of the Supabase backend.
import { describe, expect, it } from "vitest";

import { ObjectStoreError } from "../features/storage/object-store.js";
import { createFakeObjectStore } from "./fake-object-store.js";

const BUCKET = "project-assets";
const ref = (key: string, bucket = BUCKET) => ({ bucket, key });

describe("43B fake object store", () => {
  it("43B: put then get returns the bytes and the label", async () => {
    const store = createFakeObjectStore();
    const body = Buffer.from("png-bytes", "utf8");

    await store.put(ref("a/b.png"), body, { contentType: "image/png" });
    const result = await store.get(ref("a/b.png"));

    expect(result.body.toString("utf8")).toBe("png-bytes");
    expect(result.size).toBe(9);
    expect(result.contentType).toBe("image/png");
    expect(result.range).toBeUndefined();
  });

  it("43B: the double keeps a copy, not the caller's buffer", async () => {
    const store = createFakeObjectStore();
    const body = Buffer.from("abc", "utf8");

    await store.put(ref("a.bin"), body, { contentType: "text/plain" });
    body.write("zzz");

    expect((await store.get(ref("a.bin"))).body.toString("utf8")).toBe("abc");
  });

  it("43B: a repeated put without upsert fails with exists", async () => {
    const store = createFakeObjectStore();
    await store.put(ref("a.bin"), Buffer.from("one"), { contentType: "text/plain" });

    const failure = store.put(ref("a.bin"), Buffer.from("two"), {
      contentType: "text/plain",
    });

    await expect(failure).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(failure).rejects.toMatchObject({ code: "exists" });
    expect((await store.get(ref("a.bin"))).body.toString("utf8")).toBe("one");
  });

  it("43B: a repeated put with upsert replaces the object", async () => {
    const store = createFakeObjectStore();
    await store.put(ref("a.bin"), Buffer.from("one"), { contentType: "text/plain" });
    await store.put(ref("a.bin"), Buffer.from("two"), {
      contentType: "text/plain",
      upsert: true,
    });

    expect((await store.get(ref("a.bin"))).body.toString("utf8")).toBe("two");
  });

  it("43B: get of a missing object fails with not_found", async () => {
    const store = createFakeObjectStore();

    await expect(store.get(ref("missing.bin"))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("43B: get with a range slices the same way as the Supabase backend", async () => {
    const store = createFakeObjectStore();
    await store.put(ref("a.bin"), Buffer.from("abcdefgh"), {
      contentType: "text/plain",
    });

    const result = await store.get(ref("a.bin"), { start: 2, end: 4 });

    expect(result.body.toString("utf8")).toBe("cde");
    expect(result.size).toBe(8);
    expect(result.range).toStrictEqual({ start: 2, end: 4 });
  });

  it("43B: get clamps a range end past the last byte", async () => {
    const store = createFakeObjectStore();
    await store.put(ref("a.bin"), Buffer.from("abcdefgh"), {
      contentType: "text/plain",
    });

    const result = await store.get(ref("a.bin"), { start: 6, end: 99 });

    expect(result.body.toString("utf8")).toBe("gh");
    expect(result.range).toStrictEqual({ start: 6, end: 7 });
  });

  it("43B: get refuses a range that starts past the end", async () => {
    const store = createFakeObjectStore();
    await store.put(ref("a.bin"), Buffer.from("abc"), {
      contentType: "text/plain",
    });

    await expect(
      store.get(ref("a.bin"), { start: 3 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("43B: head reports the size and the label, and null when absent", async () => {
    const store = createFakeObjectStore();
    await store.put(ref("a.bin"), Buffer.from("abc"), {
      contentType: "image/webp",
    });

    expect(await store.head(ref("a.bin"))).toStrictEqual({
      size: 3,
      contentType: "image/webp",
    });
    expect(await store.head(ref("missing.bin"))).toBeNull();
  });

  it("43B: delete is idempotent", async () => {
    const store = createFakeObjectStore();
    await store.put(ref("a.bin"), Buffer.from("abc"), { contentType: "text/plain" });

    await store.delete([ref("a.bin"), ref("never-there.bin")]);
    await expect(
      store.delete([ref("a.bin"), ref("never-there.bin")]),
    ).resolves.toBeUndefined();

    expect(store.has(ref("a.bin"))).toBe(false);
  });

  it("43B: copy duplicates the object within one bucket", async () => {
    const store = createFakeObjectStore();
    await store.put(ref("a.bin"), Buffer.from("abc"), { contentType: "text/plain" });

    await store.copy(ref("a.bin"), ref("copy.bin"));

    expect((await store.get(ref("copy.bin"))).body.toString("utf8")).toBe("abc");
    expect((await store.head(ref("a.bin")))?.size).toBe(3);
  });

  it("43B: copy of a missing object fails with not_found", async () => {
    const store = createFakeObjectStore();

    await expect(
      store.copy(ref("missing.bin"), ref("copy.bin")),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("43B: copy across buckets fails with invalid_key", async () => {
    const store = createFakeObjectStore();
    await store.put(ref("a.bin"), Buffer.from("abc"), { contentType: "text/plain" });

    await expect(
      store.copy(ref("a.bin"), ref("copy.bin", "elsewhere")),
    ).rejects.toMatchObject({ code: "invalid_key" });
  });

  it("43B: signedReadUrl returns a fake URL carrying the ttl", async () => {
    const store = createFakeObjectStore();

    const url = await store.signedReadUrl(ref("a/b.png"), { ttlSeconds: 60 });

    expect(url).toBe("fake://project-assets/a/b.png?ttl=60");
  });

  it("43B: signedReadUrl adds the download name when one is asked for", async () => {
    const store = createFakeObjectStore();

    const url = await store.signedReadUrl(ref("a.png"), {
      ttlSeconds: 60,
      download: "名字.png",
    });

    expect(url).toBe(
      `fake://project-assets/a.png?ttl=60&download=${encodeURIComponent("名字.png")}`,
    );
  });

  it("43B: every call is recorded in order and reset clears the log", async () => {
    const store = createFakeObjectStore();

    await store.put(ref("a.bin"), Buffer.from("abc"), { contentType: "text/plain" });
    await store.head(ref("a.bin"));
    await store.get(ref("a.bin"), { start: 1 });

    expect(store.calls.map((call) => call.method)).toStrictEqual([
      "put",
      "head",
      "get",
    ]);
    expect(store.calls[0]).toMatchObject({ method: "put", size: 3 });

    store.reset();

    expect(store.calls).toStrictEqual([]);
    expect(store.has(ref("a.bin"))).toBe(false);
  });
});

// 43I: the batch signing path of the double: one recorded call for the whole
// set, a URL per key in the order asked, so a migrated call site can assert it
// signed everything in ONE call rather than one call per key.
describe("43I fake object store signedReadUrls", () => {
  it("returns a URL per key and records one batch call", async () => {
    const store = createFakeObjectStore();
    const keys = ["a/b.png", "c.pdf"];

    const urls = await store.signedReadUrls(BUCKET, keys, { ttlSeconds: 60 });

    expect([...urls.entries()]).toStrictEqual([
      ["a/b.png", "fake://project-assets/a/b.png?ttl=60"],
      ["c.pdf", "fake://project-assets/c.pdf?ttl=60"],
    ]);
    expect(store.calls).toStrictEqual([
      {
        method: "signedReadUrls",
        bucket: BUCKET,
        keys,
        options: { ttlSeconds: 60 },
      },
    ]);
  });
});
