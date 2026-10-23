// OP-05 / 43D: the private file-volume `ObjectStore`.
//
// Layout: the bytes of an object live at `<root>/<bucket>/<key>`; next to it,
// `<key>.meta.json` records `{ contentType, size }`. Nothing here talks to a
// network service: the volume is a plain directory on the server's disk.
//
// Writes are atomic: content goes to a `<path>.<random>.tmp` file, is flushed
// to disk, and only then renamed into place, so a reader never sees half an
// object and a crash leaves at worst a `.tmp` file next to the target.
//
// Every method validates bucket and key first. The key is a path on disk, so
// anything that could leave `<root>/<bucket>/` (`..`, absolute paths, back
// slashes, NUL) is rejected as `invalid_key` before a single file is touched.
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { ObjectStoreError } from "./object-store.js";
import type {
  ObjectHead,
  ObjectPutOptions,
  ObjectRange,
  ObjectReadResult,
  ObjectRef,
  ObjectStore,
  SignedReadUrlOptions,
} from "./object-store.js";
import { signObjectUrl } from "./object-url-signature.js";

export type FsObjectStoreOptions = {
  rootDir: string;
  secret: Uint8Array;
  publicBase: string;
  now?: () => Date;
};

const UNKNOWN_CONTENT_TYPE = "application/octet-stream";
const META_SUFFIX = ".meta.json";
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

function describe(ref: ObjectRef): string {
  return `${ref.bucket}/${ref.key}`;
}

function invalid(ref: ObjectRef, why: string): ObjectStoreError {
  return new ObjectStoreError(
    "invalid_key",
    `Invalid object address "${describe(ref)}": ${why}.`,
  );
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

/** Wrap an unexpected I/O failure without leaking the disk path. */
function backendFailed(ref: ObjectRef, error: unknown): ObjectStoreError {
  if (error instanceof ObjectStoreError) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
  return new ObjectStoreError(
    "backend_failed",
    `File volume operation failed for "${describe(ref)}" (${code}).`,
  );
}

export function createFsObjectStore(options: FsObjectStoreOptions): ObjectStore {
  const rootDir = path.resolve(options.rootDir);
  const now = options.now ?? (() => new Date());

  /** Validate bucket + key and return the absolute object path. */
  function resolveRef(ref: ObjectRef): string {
    if (!BUCKET_PATTERN.test(ref.bucket)) {
      throw invalid(ref, "bad bucket");
    }
    if (!ref.key || ref.key.startsWith("/")) {
      throw invalid(ref, "bad key");
    }
    if (ref.key.includes("\\") || ref.key.includes("\0")) {
      throw invalid(ref, "bad character in key");
    }
    for (const segment of ref.key.split("/")) {
      if (
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !SEGMENT_PATTERN.test(segment) ||
        segment.endsWith(META_SUFFIX)
      ) {
        throw invalid(ref, "bad key segment");
      }
    }

    const bucketDir = path.resolve(rootDir, ref.bucket);
    const target = path.resolve(bucketDir, ...ref.key.split("/"));
    if (!target.startsWith(bucketDir + path.sep)) {
      throw invalid(ref, "escapes the bucket");
    }
    return target;
  }

  /** Write `data` to `target` atomically: tmp file, fsync, rename. */
  async function writeAtomic(target: string, data: Buffer): Promise<void> {
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = await fsp.open(tmp, "wx");
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(tmp, target);
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Write the object without replacing an existing one. `link` fails with
   * EEXIST atomically if the target is there, so two concurrent non-upsert
   * puts cannot both win. Where hard links are unavailable we fall back to
   * check-then-rename, which can lose that race (last writer wins) - an
   * acceptable trade for a single-writer server volume.
   */
  async function writeExclusive(
    ref: ObjectRef,
    target: string,
    data: Buffer,
  ): Promise<void> {
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = await fsp.open(tmp, "wx");
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await fsp.link(tmp, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          throw new ObjectStoreError(
            "exists",
            `Object "${ref.key}" already exists.`,
          );
        }
        if (code !== "EPERM" && code !== "ENOSYS" && code !== "ENOTSUP") {
          throw error;
        }
        if (await fsp.stat(target).then(() => true, () => false)) {
          throw new ObjectStoreError(
            "exists",
            `Object "${ref.key}" already exists.`,
          );
        }
        await fsp.rename(tmp, target);
        return;
      }
      await fsp.rm(tmp, { force: true });
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function readMeta(target: string): Promise<string> {
    try {
      const raw = await fsp.readFile(target + META_SUFFIX, "utf8");
      const parsed = JSON.parse(raw) as { contentType?: unknown };
      return typeof parsed.contentType === "string" && parsed.contentType
        ? parsed.contentType
        : UNKNOWN_CONTENT_TYPE;
    } catch {
      return UNKNOWN_CONTENT_TYPE;
    }
  }

  async function putResolved(
    ref: ObjectRef,
    target: string,
    body: Buffer,
    putOptions: ObjectPutOptions,
  ): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (putOptions.upsert) {
        await writeAtomic(target, body);
      } else {
        await writeExclusive(ref, target, body);
      }
      await writeAtomic(
        target + META_SUFFIX,
        Buffer.from(
          JSON.stringify({
            contentType: putOptions.contentType,
            size: body.byteLength,
          }),
          "utf8",
        ),
      );
    } catch (error) {
      throw backendFailed(ref, error);
    }
  }

  async function readWhole(
    ref: ObjectRef,
    range?: ObjectRange,
  ): Promise<ObjectReadResult> {
    const target = resolveRef(ref);

    let size: number;
    try {
      const stat = await fsp.stat(target);
      if (!stat.isFile()) {
        throw new ObjectStoreError(
          "not_found",
          `Object "${ref.key}" does not exist.`,
        );
      }
      size = stat.size;
    } catch (error) {
      if (isMissing(error)) {
        throw new ObjectStoreError(
          "not_found",
          `Object "${ref.key}" does not exist.`,
        );
      }
      throw backendFailed(ref, error);
    }

    let start = 0;
    let last = size - 1;
    if (range) {
      if (!Number.isInteger(range.start) || range.start < 0) {
        throw invalid(ref, `bad range start ${range.start}`);
      }
      if (
        range.end !== undefined &&
        (!Number.isInteger(range.end) || range.end < range.start)
      ) {
        throw invalid(ref, `bad range end ${range.end}`);
      }
      if (range.start >= size) {
        throw new ObjectStoreError("invalid_key", "range not satisfiable");
      }
      start = range.start;
      last = Math.min(range.end ?? size - 1, size - 1);
    }

    const length = range ? last - start + 1 : size;
    const body = Buffer.alloc(length);
    try {
      const handle = await fsp.open(target, "r");
      try {
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(
            body,
            filled,
            length - filled,
            start + filled,
          );
          if (bytesRead === 0) {
            break;
          }
          filled += bytesRead;
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isMissing(error)) {
        throw new ObjectStoreError(
          "not_found",
          `Object "${ref.key}" does not exist.`,
        );
      }
      throw backendFailed(ref, error);
    }

    return {
      body,
      size,
      contentType: await readMeta(target),
      ...(range ? { range: { start, end: last } } : {}),
    };
  }

  return {
    async put(ref: ObjectRef, body: Buffer, putOptions: ObjectPutOptions) {
      const target = resolveRef(ref);
      await putResolved(ref, target, body, putOptions);
    },

    async get(ref: ObjectRef, range?: ObjectRange) {
      return readWhole(ref, range);
    },

    async head(ref: ObjectRef): Promise<ObjectHead | null> {
      const target = resolveRef(ref);
      try {
        const stat = await fsp.stat(target);
        if (!stat.isFile()) {
          return null;
        }
        return { size: stat.size, contentType: await readMeta(target) };
      } catch (error) {
        if (isMissing(error)) {
          return null;
        }
        throw backendFailed(ref, error);
      }
    },

    async delete(refs: readonly ObjectRef[]) {
      // Validate every address before deleting anything.
      const targets = refs.map((ref) => ({ ref, target: resolveRef(ref) }));
      for (const { ref, target } of targets) {
        for (const file of [target, target + META_SUFFIX]) {
          try {
            await fsp.unlink(file);
          } catch (error) {
            if (!isMissing(error)) {
              throw backendFailed(ref, error);
            }
          }
        }
      }
    },

    async copy(from: ObjectRef, to: ObjectRef) {
      const toTarget = resolveRef(to);
      const source = await readWhole(from);
      await putResolved(to, toTarget, source.body, {
        contentType: source.contentType,
        upsert: true,
      });
    },

    async signedReadUrl(
      ref: ObjectRef,
      urlOptions: SignedReadUrlOptions,
    ): Promise<string> {
      resolveRef(ref);
      // `transform` is ignored on purpose: the volume serves the original.
      return signObjectUrl({
        secret: options.secret,
        publicBase: options.publicBase,
        bucket: ref.bucket,
        key: ref.key,
        expiresAt: Math.floor(now().getTime() / 1000) + urlOptions.ttlSeconds,
        ...(urlOptions.download ? { download: urlOptions.download } : {}),
      });
    },
  };
}
