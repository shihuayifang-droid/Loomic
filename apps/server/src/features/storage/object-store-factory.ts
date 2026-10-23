// OP-05 / 43B: the one place that picks an `ObjectStore` backend.
//
// `HAHART_STORAGE_PROVIDER` selects it. `supabase` is the default and answers
// exactly what the call sites do today; the `fs` backend (the private volume of
// OP-05) is a later ticket, so asking for it fails loudly instead of silently
// falling back to Supabase - a quiet fallback would put bytes on a backend the
// operator did not choose.
//
// The Supabase client is taken LAZILY, through `deps.supabaseClient`: building
// the store must not construct a client, because at start-up nothing may have
// been configured yet and a store that is never used must cost nothing.
import type { ServerEnv } from "../../config/env.js";
import type { ObjectStore } from "./object-store.js";
import { createSupabaseObjectStore } from "./supabase-object-store.js";
import type { SupabaseStorageLike } from "./supabase-object-store.js";

/** Error text for the backend that does not exist yet (pinned by tests). */
export const FS_NOT_IMPLEMENTED_MESSAGE =
  "HAHART_STORAGE_PROVIDER=fs is not implemented yet";

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
}

/**
 * Build the `ObjectStore` this configuration asks for.
 *
 * Throws for `fs` until the volume backend exists. An unset value means
 * `supabase`, so an installation that never set the variable behaves as before.
 */
export function createObjectStore(
  env: ServerEnv,
  deps: { supabaseClient: () => SupabaseStorageLike },
): ObjectStore {
  const provider = env.storageProvider ?? "supabase";

  if (provider === "fs") {
    throw new Error(FS_NOT_IMPLEMENTED_MESSAGE);
  }

  return new LazyObjectStore(deps.supabaseClient);
}
