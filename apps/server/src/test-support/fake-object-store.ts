// OP-05 / 43B: an in-memory `ObjectStore` for tests.
//
// Why a shared double and not one stub per test: the migration tickets after
// this one move call sites onto the interface and have to assert WHICH objects
// were touched. A double that behaves like the real backend (same error codes,
// same range rule, same URL shape) plus a `calls` log lets those tests describe
// behaviour instead of poking at a cache.
//
// It lives under `test-support` on purpose: production code must never import
// it, and its own test file sits next to it.
import { ObjectStoreError } from "../features/storage/object-store.js";
import type {
  ObjectHead,
  ObjectPutOptions,
  ObjectRange,
  ObjectReadResult,
  ObjectRef,
  ObjectStore,
  SignedReadUrlOptions,
} from "../features/storage/object-store.js";
import type { ProjectAssetTransform } from "../features/storage/project-asset-urls.js";

/** One recorded call, enough for a later ticket to assert what a call site did. */
export type FakeObjectStoreCall =
  | { method: "put"; ref: ObjectRef; options: ObjectPutOptions; size: number }
  | { method: "get"; ref: ObjectRef; range?: ObjectRange }
  | { method: "head"; ref: ObjectRef }
  | { method: "delete"; refs: readonly ObjectRef[] }
  | { method: "copy"; from: ObjectRef; to: ObjectRef }
  | {
      method: "signedReadUrl";
      ref: ObjectRef;
      options: SignedReadUrlOptions & { transform?: ProjectAssetTransform };
    }
  | {
      method: "signedReadUrls";
      bucket: string;
      keys: readonly string[];
      options: { ttlSeconds: number };
    };

export type FakeObjectStore = ObjectStore & {
  /** Every call, in order. Mutated by the double, read by the test. */
  readonly calls: readonly FakeObjectStoreCall[];
  /** Whether an object is stored, without recording a call. */
  has(ref: ObjectRef): boolean;
  /** Drop every object and the call log, so one double can serve several cases. */
  reset(): void;
};

const UNKNOWN_CONTENT_TYPE = "application/octet-stream";

/**
 * The same range rule as the Supabase backend (see `sliceBody` there): both ends
 * inclusive, past-the-end start is `not_found`, a long end is clamped and echoed.
 */
function sliceBody(
  body: Buffer,
  range: ObjectRange | undefined,
  key: string,
): { body: Buffer; range?: { start: number; end: number } } {
  if (!range) {
    return { body };
  }

  const { start, end } = range;
  if (!Number.isInteger(start) || start < 0) {
    throw new ObjectStoreError(
      "invalid_key",
      `Invalid range start ${start} for object "${key}".`,
    );
  }
  if (end !== undefined && (!Number.isInteger(end) || end < start)) {
    throw new ObjectStoreError(
      "invalid_key",
      `Invalid range end ${end} for object "${key}".`,
    );
  }

  const size = body.byteLength;
  if (start >= size) {
    throw new ObjectStoreError(
      "not_found",
      `Range start ${start} is past the end of object "${key}" (${size} bytes).`,
    );
  }

  const last = Math.min(end ?? size - 1, size - 1);
  return { body: body.subarray(start, last + 1), range: { start, end: last } };
}

export function createFakeObjectStore(): FakeObjectStore {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const calls: FakeObjectStoreCall[] = [];

  const mapKey = (ref: ObjectRef) => `${ref.bucket}/${ref.key}`;
  const stored = (ref: ObjectRef) => objects.get(mapKey(ref));

  return {
    calls,

    has(ref: ObjectRef): boolean {
      return objects.has(mapKey(ref));
    },

    reset(): void {
      objects.clear();
      calls.length = 0;
    },

    async put(ref: ObjectRef, body: Buffer, options: ObjectPutOptions) {
      calls.push({ method: "put", ref, options, size: body.byteLength });

      if (!options.upsert && objects.has(mapKey(ref))) {
        throw new ObjectStoreError(
          "exists",
          `Object "${ref.key}" already exists.`,
        );
      }

      // Copy the bytes: a caller that reuses its buffer must not be able to
      // change what is stored afterwards.
      objects.set(mapKey(ref), {
        body: Buffer.from(body),
        contentType: options.contentType,
      });
    },

    async get(
      ref: ObjectRef,
      range?: ObjectRange,
    ): Promise<ObjectReadResult> {
      calls.push({ method: "get", ref, ...(range ? { range } : {}) });

      const entry = stored(ref);
      if (!entry) {
        throw new ObjectStoreError(
          "not_found",
          `Object "${ref.key}" does not exist.`,
        );
      }

      const sliced = sliceBody(entry.body, range, ref.key);
      return {
        body: sliced.body,
        size: entry.body.byteLength,
        contentType: entry.contentType || UNKNOWN_CONTENT_TYPE,
        ...(sliced.range ? { range: sliced.range } : {}),
      };
    },

    async head(ref: ObjectRef): Promise<ObjectHead | null> {
      calls.push({ method: "head", ref });

      const entry = stored(ref);
      if (!entry) {
        return null;
      }

      return {
        size: entry.body.byteLength,
        contentType: entry.contentType || UNKNOWN_CONTENT_TYPE,
      };
    },

    async delete(refs: readonly ObjectRef[]) {
      calls.push({ method: "delete", refs });

      // Idempotent by construction: deleting what is not there is not an error.
      for (const ref of refs) {
        objects.delete(mapKey(ref));
      }
    },

    async copy(from: ObjectRef, to: ObjectRef) {
      calls.push({ method: "copy", from, to });

      if (from.bucket !== to.bucket) {
        throw new ObjectStoreError(
          "invalid_key",
          `Cross-bucket copy is not supported (${from.bucket} -> ${to.bucket}).`,
        );
      }

      const entry = stored(from);
      if (!entry) {
        throw new ObjectStoreError(
          "not_found",
          `Object "${from.key}" does not exist.`,
        );
      }

      objects.set(mapKey(to), {
        body: Buffer.from(entry.body),
        contentType: entry.contentType,
      });
    },

    async signedReadUrl(
      ref: ObjectRef,
      options: SignedReadUrlOptions,
    ): Promise<string> {
      calls.push({ method: "signedReadUrl", ref, options });

      const query = [`ttl=${options.ttlSeconds}`];
      if (options.download) {
        query.push(`download=${encodeURIComponent(options.download)}`);
      }

      return `fake://${ref.bucket}/${ref.key}?${query.join("&")}`;
    },

    async signedReadUrls(
      bucket: string,
      keys: readonly string[],
      urlOptions: { ttlSeconds: number },
    ): Promise<Map<string, string>> {
      // One recorded call for the whole set, mirroring the real backend's one
      // round trip; the keys travel verbatim so a test can assert them.
      calls.push({ method: "signedReadUrls", bucket, keys, options: urlOptions });

      const signed = new Map<string, string>();
      for (const key of keys) {
        signed.set(key, `fake://${bucket}/${key}?ttl=${urlOptions.ttlSeconds}`);
      }
      return signed;
    },
  };
}
