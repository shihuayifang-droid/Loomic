// OP-05 / workorder 45C: a storage client, backed by an `ObjectStore`.
//
// Why an adapter instead of changing every service
// The business services (projects, uploads, canvases, chat, brand kits, the
// agent runtime and the job executors) all ask for a client first
// (`createUserClient(token)` / `getAdminClient()`) and hand it to
// `createSupabaseObjectStore(client)` or `signProjectAssetUrl(s)(client, ...)`.
// With `HAHART_STORAGE_PROVIDER=fs` that client would still be the hosted one,
// which does not exist on a self-hosted installation. Rather than touch two dozen
// call sites, `app.ts` and `worker.ts` hand those factories THIS object when the
// volume is the chosen backend: it satisfies `SupabaseStorageLike` structurally,
// and every bucket method delegates to the `ObjectStore` (the private file
// volume), so the services end up on the volume without knowing it.
//
// It is a bridge, not a destination: once the services take an `ObjectStore`
// directly (T-133) this file and its two wiring branches are deleted.
//
// Access control
// There is no storage-level row security on the volume. Who may read or write an
// object is decided entirely by the repository ACL checks each call site runs
// BEFORE it reaches storage (the 45C ticket records that audit). A signed link
// from this adapter is a bearer token for exactly the key it was signed for.
//
// What is NOT supported
// `list` (the hosted listing the Supabase wrapper uses to emulate `head`) is
// refused with an error: a directory listing is not part of the `ObjectStore`
// contract. Code that needs object metadata must call `ObjectStore.head`
// directly; today only the `/objects` route does, and it holds the real store.
import { ObjectStoreError } from "./object-store.js";
import type { ObjectStore } from "./object-store.js";
import type {
  SupabaseBucketApi,
  SupabaseStorageLike,
} from "./supabase-object-store.js";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An independent ArrayBuffer holding a copy of `body` (a Buffer may be a view into a pool). */
function copyToArrayBuffer(body: Buffer): ArrayBuffer {
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy.buffer;
}

function bucketApi(store: ObjectStore, bucket: string): SupabaseBucketApi {
  return {
    async upload(key, body, options) {
      try {
        await store.put({ bucket, key }, body, {
          contentType: options?.contentType ?? DEFAULT_CONTENT_TYPE,
          ...(options?.upsert !== undefined ? { upsert: options.upsert } : {}),
        });
        return { data: { path: key }, error: null };
      } catch (error) {
        if (error instanceof ObjectStoreError && error.code === "exists") {
          return {
            data: null,
            error: {
              message: "The resource already exists",
              statusCode: "409",
            },
          };
        }
        return { data: null, error: { message: messageOf(error) } };
      }
    },

    async download(key) {
      try {
        const result = await store.get({ bucket, key });
        const body = copyToArrayBuffer(result.body);
        return {
          data: {
            type: result.contentType,
            arrayBuffer: async () => body.slice(0),
          },
          error: null,
        };
      } catch (error) {
        return { data: null, error: { message: messageOf(error) } };
      }
    },

    async remove(keys) {
      try {
        await store.delete(keys.map((key) => ({ bucket, key })));
        return { data: [], error: null };
      } catch (error) {
        return { data: null, error: { message: messageOf(error) } };
      }
    },

    async copy(fromKey, toKey) {
      try {
        await store.copy({ bucket, key: fromKey }, { bucket, key: toKey });
        return { data: { path: toKey }, error: null };
      } catch (error) {
        return { data: null, error: { message: messageOf(error) } };
      }
    },

    async createSignedUrl(key, expiresInSeconds, options) {
      try {
        const signedUrl = await store.signedReadUrl(
          { bucket, key },
          {
            ttlSeconds: expiresInSeconds,
            ...(options?.transform ? { transform: options.transform } : {}),
            ...(typeof options?.download === "string" && options.download
              ? { download: options.download }
              : {}),
          },
        );
        return { data: { signedUrl }, error: null };
      } catch (error) {
        return { data: null, error: { message: messageOf(error) } };
      }
    },

    async createSignedUrls(keys, expiresInSeconds) {
      try {
        const signed = await store.signedReadUrls(bucket, keys, {
          ttlSeconds: expiresInSeconds,
        });
        return {
          data: keys.map((key) => ({
            path: key,
            signedUrl: signed.get(key) ?? null,
          })),
          error: null,
        };
      } catch (error) {
        return { data: null, error: { message: messageOf(error) } };
      }
    },

    async list() {
      return {
        data: null,
        error: { message: "list is not supported by the object store adapter" },
      };
    },
  };
}

/**
 * Wrap an `ObjectStore` in the structural client shape the storage helpers take.
 * Nothing is read or written here; each bucket method reaches the store only
 * when called.
 */
export function createObjectStoreStorageClient(
  store: ObjectStore,
): SupabaseStorageLike {
  return {
    storage: {
      from(bucket: string) {
        return bucketApi(store, bucket);
      },
    },
  };
}
