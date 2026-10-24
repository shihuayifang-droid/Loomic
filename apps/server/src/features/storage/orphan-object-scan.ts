// OP-11 / OP-05 (workorder 45L): orphan object inspection.
//
// Report-only. The volume is walked, every object older than `minAgeMs` is
// looked up in the database in batches, and the ones nobody references are
// counted. This module has no way to remove anything: deciding what to do with
// an orphan needs a human-approved rule (T-138), so the only output is a report.
import { promises as fsp } from "node:fs";
import path from "node:path";

export type OrphanScanReport = {
  scanned: number;
  referenced: number;
  orphans: number;
  tooNew: number;
  /** At most 10 orphans, in `bucket/key` form. */
  sampleKeys: string[];
};

export type ListedObject = { bucket: string; key: string; mtimeMs: number };

export type OrphanScanDeps = {
  listObjects(): AsyncIterable<ListedObject>;
  /** Returns the subset of `refs` that the database references, as `bucket/key`. */
  isReferenced(refs: Array<{ bucket: string; key: string }>): Promise<Set<string>>;
  now(): number;
  minAgeMs: number;
  batchSize?: number;
};

const DEFAULT_BATCH_SIZE = 500;
const MAX_SAMPLE_KEYS = 10;
const META_SUFFIX = ".meta.json";

export async function scanOrphanObjects(
  deps: OrphanScanDeps,
): Promise<OrphanScanReport> {
  const batchSize =
    deps.batchSize !== undefined && deps.batchSize > 0
      ? Math.floor(deps.batchSize)
      : DEFAULT_BATCH_SIZE;
  const cutoff = deps.now() - deps.minAgeMs;

  const report: OrphanScanReport = {
    scanned: 0,
    referenced: 0,
    orphans: 0,
    tooNew: 0,
    sampleKeys: [],
  };

  let batch: Array<{ bucket: string; key: string }> = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    const found = await deps.isReferenced(current);
    for (const ref of current) {
      const id = `${ref.bucket}/${ref.key}`;
      if (found.has(id)) {
        report.referenced += 1;
      } else {
        report.orphans += 1;
        if (report.sampleKeys.length < MAX_SAMPLE_KEYS) {
          report.sampleKeys.push(id);
        }
      }
    }
  };

  for await (const object of deps.listObjects()) {
    report.scanned += 1;
    if (object.mtimeMs > cutoff) {
      report.tooNew += 1;
      continue;
    }
    batch.push({ bucket: object.bucket, key: object.key });
    if (batch.length >= batchSize) {
      await flush();
    }
  }
  await flush();

  return report;
}

/**
 * Walk `<rootDir>/<bucket>/**`. Dot-files (including the `.tmp` leftovers of an
 * interrupted write) and the `.meta.json` sidecar of each object are skipped:
 * neither one is an object a row can reference.
 */
export function createFsObjectLister(
  rootDir: string,
): () => AsyncIterable<ListedObject> {
  return async function* listObjects(): AsyncGenerator<ListedObject> {
    const buckets = await readDirOrEmpty(rootDir);
    for (const bucketEntry of buckets) {
      if (!bucketEntry.isDirectory() || bucketEntry.name.startsWith(".")) continue;
      const bucket = bucketEntry.name;
      yield* walk(path.join(rootDir, bucket), [], bucket);
    }
  };
}

async function* walk(
  dir: string,
  prefix: string[],
  bucket: string,
): AsyncGenerator<ListedObject> {
  const entries = await readDirOrEmpty(dir);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, [...prefix, entry.name], bucket);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(META_SUFFIX)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = (await fsp.stat(full)).mtimeMs;
    } catch {
      // Vanished between readdir and stat: not an object any more.
      continue;
    }
    yield { bucket, key: [...prefix, entry.name].join("/"), mtimeMs };
  }
}

async function readDirOrEmpty(dir: string) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}
