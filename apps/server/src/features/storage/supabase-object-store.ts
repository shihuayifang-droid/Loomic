// OP-05 / 43B: the Supabase backend of `ObjectStore`.
//
// This is a WRAPPER, not a new behaviour: every method maps one-to-one onto the
// storage SDK call the call sites make today, so a caller moved onto the
// interface keeps the bytes, the errors and the options it had before. The
// migration tickets after this one only move call sites; nothing here changes
// until the file-volume backend lands.
//
// The structural client type below is a deliberate subset of what supabase-js
// offers, so the real client satisfies it, and a test can hand in a recording
// stub. Two consequences worth knowing:
//  - `get` slices in memory: the SDK hands back a whole object, so a range
//    request costs the full download and is served from the buffer. The real
//    volume backend will read the range off disk instead; callers already see
//    the `ObjectStore` contract, which is why the cost can change underneath.
//  - `head` is emulated with a parent-directory listing: the SDK has no metadata
//    call of its own, and a listing carries `metadata.size` / `metadata.mimetype`.
import type { ProjectAssetTransform } from "./project-asset-urls.js";
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

/** What the backend labels an object it did not label itself. */
const UNKNOWN_CONTENT_TYPE = "application/octet-stream";

/** Error shape of the storage SDK: a message, plus a status when it has one. */
export type SupabaseStorageError = {
  message: string;
  statusCode?: string | number;
};

type SupabaseResponse<T> = {
  data: T | null;
  error: SupabaseStorageError | null;
};

/**
 * A downloaded object, as the SDK returns it. Only what this module needs: the
 * bytes and the label. `type` is absent when the backend did not set one.
 */
export type SupabaseDownloadedObject = {
  readonly type?: string;
  arrayBuffer(): PromiseLike<ArrayBuffer>;
};

/** One entry of a directory listing. `metadata` is null for a pseudo-folder. */
export type SupabaseListItem = {
  name: string;
  metadata?: { size?: number; mimetype?: string } | null;
};

/** The bucket handle: the slice of a storage client this module uses. */
export type SupabaseBucketApi = {
  upload(
    key: string,
    body: Buffer,
    options?: { contentType?: string; upsert?: boolean },
  ): PromiseLike<SupabaseResponse<{ path: string }>>;
  download(key: string): PromiseLike<SupabaseResponse<SupabaseDownloadedObject>>;
  remove(keys: string[]): PromiseLike<SupabaseResponse<SupabaseListItem[]>>;
  copy(
    fromKey: string,
    toKey: string,
  ): PromiseLike<SupabaseResponse<{ path: string }>>;
  createSignedUrl(
    key: string,
    expiresInSeconds: number,
    options?: { transform?: ProjectAssetTransform; download?: string },
  ): PromiseLike<SupabaseResponse<{ signedUrl: string }>>;
  list(prefix: string): PromiseLike<SupabaseResponse<SupabaseListItem[]>>;
};

/**
 * The client shape this backend needs. Structural on purpose: the admin client,
 * a user client and a test stub all satisfy it, and nothing here imports the SDK.
 */
export type SupabaseStorageLike = {
  storage: {
    from(bucket: string): SupabaseBucketApi;
  };
};

/**
 * The ONE place this module reaches a storage client: every method below goes
 * through here, so the audit's storage count is exactly one for this file.
 *
 * The bucket lookup is written out plainly rather than spelled indirectly. The
 * repository's dependency audit reads source text, so it counts this line as one
 * PostgREST-shaped call even though the receiver is a storage client; that extra
 * count is intended and is pinned in the audit test, because the point of
 * funnelling every access through one place is that the counter can see it. An
 * indirect spelling the audit cannot read would hide the access instead of
 * converging it.
 */
function bucketHandle(
  client: SupabaseStorageLike,
  bucket: string,
): SupabaseBucketApi {
  return client.storage.from(bucket);
}

function backendFailure(
  error: SupabaseStorageError | null,
  action: string,
): ObjectStoreError {
  const detail = error?.message ?? "no error message";
  return new ObjectStoreError(
    "backend_failed",
    `Storage ${action} failed (${detail}).`,
    detail,
  );
}

/**
 * "The object is already there" reaches us in two spellings: a 409 status, or a
 * message saying so. Both are a normal answer (`exists`), not a backend fault.
 */
function isAlreadyExists(error: SupabaseStorageError): boolean {
  if (String(error.statusCode ?? "") === "409") {
    return true;
  }
  return /already exists/i.test(error.message);
}

/** Parent listing prefix and final segment of a key ("a/b/c.png" -> "a/b", "c.png"). */
function parentDirectory(key: string): { prefix: string; name: string } {
  const slash = key.lastIndexOf("/");
  if (slash < 0) {
    return { prefix: "", name: key };
  }
  return { prefix: key.slice(0, slash), name: key.slice(slash + 1) };
}

/**
 * Apply the shared range rule. Both this backend and the test double use it, so
 * a test written against the double describes the real one:
 *  - non-integers, a negative start or an end before the start: `invalid_key`;
 *  - a start at or past the end of the object: `not_found`;
 *  - an end past the last byte is clamped, and the CLAMPED range is echoed.
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

/**
 * Wrap a Supabase client as an `ObjectStore`. No client call happens here: the
 * wrapper is built eagerly, its methods reach the client only when used.
 */
export function createSupabaseObjectStore(
  client: SupabaseStorageLike,
): ObjectStore {
  return {
    async put(ref: ObjectRef, body: Buffer, options: ObjectPutOptions) {
      const handle = bucketHandle(client, ref.bucket);
      const upsert = options.upsert ?? false;
      const { error } = await handle.upload(ref.key, body, {
        contentType: options.contentType,
        upsert,
      });

      if (error) {
        if (isAlreadyExists(error)) {
          throw new ObjectStoreError(
            "exists",
            `Object "${ref.key}" already exists (${error.message}).`,
            error.message,
          );
        }
        throw backendFailure(error, "upload");
      }
    },

    async get(
      ref: ObjectRef,
      range?: ObjectRange,
    ): Promise<ObjectReadResult> {
      const handle = bucketHandle(client, ref.bucket);
      const { data, error } = await handle.download(ref.key);
      if (error || !data) {
        throw backendFailure(error, "download");
      }

      const body = Buffer.from(await data.arrayBuffer());
      const sliced = sliceBody(body, range, ref.key);
      const contentType =
        data.type && data.type.length > 0 ? data.type : UNKNOWN_CONTENT_TYPE;

      return {
        body: sliced.body,
        size: body.byteLength,
        contentType,
        ...(sliced.range ? { range: sliced.range } : {}),
      };
    },

    async head(ref: ObjectRef): Promise<ObjectHead | null> {
      const handle = bucketHandle(client, ref.bucket);
      const { prefix, name } = parentDirectory(ref.key);
      const { data, error } = await handle.list(prefix);
      if (error) {
        throw backendFailure(error, "list");
      }

      const entry = (data ?? []).find((item) => item.name === name);
      const metadata = entry?.metadata;
      if (!metadata) {
        return null;
      }

      return {
        size: metadata.size ?? 0,
        contentType: metadata.mimetype ?? UNKNOWN_CONTENT_TYPE,
      };
    },

    async delete(refs: readonly ObjectRef[]) {
      // One request per bucket: the SDK removes a list of keys at a time, and a
      // mixed-bucket call would otherwise need one round trip per object.
      const keysByBucket = new Map<string, string[]>();
      for (const ref of refs) {
        const keys = keysByBucket.get(ref.bucket) ?? [];
        keys.push(ref.key);
        keysByBucket.set(ref.bucket, keys);
      }

      for (const [bucket, keys] of keysByBucket) {
        const handle = bucketHandle(client, bucket);
        const { error } = await handle.remove(keys);
        if (error) {
          throw backendFailure(error, "remove");
        }
      }
    },

    async copy(from: ObjectRef, to: ObjectRef) {
      if (from.bucket !== to.bucket) {
        throw new ObjectStoreError(
          "invalid_key",
          `Cross-bucket copy is not supported (${from.bucket} -> ${to.bucket}).`,
        );
      }

      const handle = bucketHandle(client, from.bucket);
      const { error } = await handle.copy(from.key, to.key);
      if (error) {
        throw backendFailure(error, "copy");
      }
    },

    async signedReadUrl(
      ref: ObjectRef,
      options: SignedReadUrlOptions,
    ): Promise<string> {
      const handle = bucketHandle(client, ref.bucket);
      // Only send a third argument when there is something to say in it: a plain
      // signature must keep reaching the SDK with no options at all.
      const hasSignOptions = Boolean(options.transform || options.download);

      const { data, error } = await handle.createSignedUrl(
        ref.key,
        options.ttlSeconds,
        hasSignOptions
          ? {
              ...(options.transform ? { transform: options.transform } : {}),
              ...(options.download ? { download: options.download } : {}),
            }
          : undefined,
      );

      if (error || !data?.signedUrl) {
        // No URL and no object key in the message: a signed URL is a bearer
        // token, and this string ends up in logs.
        throw new ObjectStoreError(
          "backend_failed",
          `Could not sign the stored object (${
            error?.message ?? "no signed url returned"
          }).`,
        );
      }

      return data.signedUrl;
    },
  };
}
