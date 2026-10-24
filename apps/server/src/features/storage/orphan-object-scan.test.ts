import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFsObjectLister,
  scanOrphanObjects,
  type ListedObject,
} from "./orphan-object-scan.js";

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

async function* gen(items: ListedObject[]): AsyncGenerator<ListedObject> {
  for (const item of items) yield item;
}

describe("scanOrphanObjects", () => {
  it("counts referenced, orphans and too-new objects", async () => {
    const old = NOW - 2 * DAY;
    const items: ListedObject[] = [
      { bucket: "b", key: "ref.png", mtimeMs: old },
      { bucket: "b", key: "orphan1.png", mtimeMs: old },
      { bucket: "b", key: "orphan2.png", mtimeMs: old },
      { bucket: "b", key: "fresh.png", mtimeMs: NOW - 1000 },
    ];
    const seen: string[][] = [];
    const report = await scanOrphanObjects({
      listObjects: () => gen(items),
      isReferenced: async (refs) => {
        seen.push(refs.map((r) => `${r.bucket}/${r.key}`));
        return new Set(["b/ref.png"]);
      },
      now: () => NOW,
      minAgeMs: DAY,
    });
    expect(report).toEqual({
      scanned: 4,
      referenced: 1,
      orphans: 2,
      tooNew: 1,
      sampleKeys: ["b/orphan1.png", "b/orphan2.png"],
    });
    // The too-new object is never looked up.
    expect(seen).toEqual([["b/ref.png", "b/orphan1.png", "b/orphan2.png"]]);
  });

  it("queries in batches and caps sampleKeys at 10", async () => {
    const items: ListedObject[] = Array.from({ length: 25 }, (_, i) => ({
      bucket: "b",
      key: `k${i}`,
      mtimeMs: 0,
    }));
    let calls = 0;
    const report = await scanOrphanObjects({
      listObjects: () => gen(items),
      isReferenced: async () => {
        calls += 1;
        return new Set<string>();
      },
      now: () => NOW,
      minAgeMs: DAY,
      batchSize: 10,
    });
    expect(calls).toBe(3);
    expect(report.orphans).toBe(25);
    expect(report.sampleKeys).toHaveLength(10);
  });

  it("makes no lookup when nothing is old enough", async () => {
    let calls = 0;
    const report = await scanOrphanObjects({
      listObjects: () => gen([{ bucket: "b", key: "x", mtimeMs: NOW }]),
      isReferenced: async () => {
        calls += 1;
        return new Set<string>();
      },
      now: () => NOW,
      minAgeMs: DAY,
    });
    expect(calls).toBe(0);
    expect(report).toEqual({
      scanned: 1,
      referenced: 0,
      orphans: 0,
      tooNew: 1,
      sampleKeys: [],
    });
  });
});

describe("createFsObjectLister", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("walks buckets and subdirectories, skipping dot-files and sidecars", async () => {
    root = mkdtempSync(path.join(tmpdir(), "orphan-scan-"));
    mkdirSync(path.join(root, "project-assets", "a", "b"), { recursive: true });
    mkdirSync(path.join(root, "canvases"), { recursive: true });
    writeFileSync(path.join(root, "project-assets", "top.png"), "x");
    writeFileSync(path.join(root, "project-assets", "a", "b", "deep.png"), "x");
    writeFileSync(path.join(root, "project-assets", "a", "b", "deep.png.meta.json"), "{}");
    writeFileSync(path.join(root, "project-assets", ".hidden.tmp"), "x");
    writeFileSync(path.join(root, "canvases", "c.json"), "x");
    const when = new Date(NOW);
    utimesSync(path.join(root, "canvases", "c.json"), when, when);

    const found: ListedObject[] = [];
    for await (const o of createFsObjectLister(root)()) found.push(o);

    expect(found.map((o) => `${o.bucket}/${o.key}`).sort()).toEqual([
      "canvases/c.json",
      "project-assets/a/b/deep.png",
      "project-assets/top.png",
    ]);
    const canvas = found.find((o) => o.key === "c.json");
    expect(canvas?.mtimeMs).toBe(NOW);
  });

  it("yields nothing for a missing root", async () => {
    const found: ListedObject[] = [];
    for await (const o of createFsObjectLister(path.join(tmpdir(), "no-such-45l"))()) {
      found.push(o);
    }
    expect(found).toEqual([]);
  });
});
