// OP-05 / 43B: the one place that picks an `ObjectStore` backend.
//
// `HAHART_STORAGE_PROVIDER` selects it. `supabase` is the default and answers
// exactly what the call sites do today; `fs` is the private volume of OP-05
// (43D/43E), which `loadServerEnv` only lets through once its directory, link
// key and public base are configured.
//
// The Supabase client is taken LAZILY, through `deps.supabaseClient`: building
// the store must not construct a client, because at start-up nothing may have
// been configured yet and a store that is never used must cost nothing.
import type { ServerEnv } from "../../config/env.js";
import { createFsObjectStore } from "./fs-object-store.js";
import type { ObjectStore } from "./object-store.js";
import { objectUrlSecretFrom } from "./object-url-signature.js";
import { createSupabaseObjectStore } from "./supabase-object-store.js";
import type { SupabaseStorageLike } from "./supabase-object-store.js";

/**
 * An `ObjectStore` that only builds its real delegate on the first call. Kept as
 * a tiny class instead of a proxy so the laziness is visible in the source.
 */
class LazyObjectStore implements ObjectStore {
  private delegate: ObjectStore | null = null;

  constructor(private readonly loadClient: () => SupabaseStorageLike) {}

  private target(): ObjectStore {
    if (!this.delegate) {
      this.delegate = createSupabaseObjectStore(this.loadClient());
    }
    return this.delegate;
  }

  put(
    ref: Parameters<ObjectStore["put"]>[0],
    body: Parameters<ObjectStore["put"]>[1],
    options: Parameters<ObjectStore["put"]>[2],
  ): Promise<void> {
    return this.target().put(ref, body, options);
  }

  get(
    ref: Parameters<ObjectStore["get"]>[0],
    range?: Parameters<ObjectStore["get"]>[1],
  ): ReturnType<ObjectStore["get"]> {
    return this.target().get(ref, range);
  }

  head(ref: Parameters<ObjectStore["head"]>[0]): ReturnType<ObjectStore["head"]> {
    return this.target().head(ref);
  }

  delete(refs: Parameters<ObjectStore["delete"]>[0]): Promise<void> {
    return this.target().delete(refs);
  }

  copy(
    from: Parameters<ObjectStore["copy"]>[0],
    to: Parameters<ObjectStore["copy"]>[1],
  ): Promise<void> {
    return this.target().copy(from, to);
  }

  signedReadUrl(
    ref: Parameters<ObjectStore["signedReadUrl"]>[0],
    options: Parameters<ObjectStore["signedReadUrl"]>[1],
  ): ReturnType<ObjectStore["signedReadUrl"]> {
    return this.target().signedReadUrl(ref, options);
  }

  signedReadUrls(
    bucket: Parameters<ObjectStore["signedReadUrls"]>[0],
    keys: Parameters<ObjectStore["signedReadUrls"]>[1],
    options: Parameters<ObjectStore["signedReadUrls"]>[2],
  ): ReturnType<ObjectStore["signedReadUrls"]> {
    return this.target().signedReadUrls(bucket, keys, options);
  }
}

/**
 * Build the `ObjectStore` this configuration asks for.
 *
 * `fs` needs its three settings, and `loadServerEnv` has already refused to
 * produce an env without them; the non-null assertions below only restate that
 * contract. An unset value means `supabase`, so an installation that never set
 * the variable behaves as before.
 */
export function createObjectStore(
  env: ServerEnv,
  deps: { supabaseClient: () => SupabaseStorageLike },
): ObjectStore {
  const provider = env.storageProvider ?? "supabase";

  if (provider === "fs") {
    return createFsObjectStore({
      rootDir: env.objectRoot!,
      secret: objectUrlSecretFrom(env.objectUrlSecret!),
      publicBase: env.objectPublicBase!,
    });
  }

  return new LazyObjectStore(deps.supabaseClient);
}
