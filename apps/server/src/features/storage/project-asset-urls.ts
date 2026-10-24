// X-52: the ONE way a project asset URL is produced.
//
// WHY THIS EXISTS
// Read access used to be "if you know the public URL, you can read the object".
// X-52 turns that around: the caller must be allowed to see the object's
// `asset_objects` row (its RLS decides), and the URL handed out is a short-lived
// signature. So there is exactly one thing that mints a URL — this module — and
// it has no fallback: if signing fails, the caller gets an error, never a public
// URL. A silent fallback would quietly undo the whole point of the ticket.
//
// It takes either a user-scoped client (reads are authorised by that user's JWT)
// or the worker's admin client, so the executors can sign the object they just
// recorded without inventing a second code path.
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
// OP-05 / 43C: the signature is minted through the ONE object-storage seam. This
// module stays the single place that hands out an asset URL, but the bytes — and
// the failure wording — now come from the `ObjectStore` adapter, so a future
// backend swap does not have to touch the fifteen call sites that trust it.
import { ObjectStoreError } from "./object-store.js";
import type { ObjectStore } from "./object-store.js";
import { createSupabaseObjectStore } from "./supabase-object-store.js";
import type { SupabaseStorageLike } from "./supabase-object-store.js";

/**
 * Whether Supabase's display projection may be routed through storage's on-the-fly
 * image renderer (`/storage/v1/render/image/sign/...`).
 *
 * That route is a Supabase feature an individual project may not have enabled. On
 * a project without it EVERY such URL answers
 * `403 {"error":"FeatureNotEnabled","message":"feature not enabled for this tenant"}`
 * — verified against this deployment for the same object that `/object/sign/`
 * serves with a 200. The client treats the failure as recoverable (it retries the
 * undownscaled original), but the retry is not guaranteed to run on every path: an
 * image pushed in by `canvas.sync` was observed staying a grey placeholder box while
 * the same object loaded fine on the next full page load.
 *
 * So the renderer is opt-OUT rather than assumed: default on (unchanged behaviour
 * where the feature exists), and a deployment whose project lacks it sets
 * `LOOMIC_CANVAS_DISPLAY_TRANSFORM=0` to make the plain object URL the primary one.
 * Downscaling is an optimisation; it must never be the only way to see a picture.
 */
export function storageRenderTransformEnabled(): boolean {
  const raw = process.env.LOOMIC_CANVAS_DISPLAY_TRANSFORM?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * Ask the image renderer for WebP, on a signed display URL.
 *
 * The old public-URL path appended `&format=webp` by string concatenation, which
 * only works because a public URL always has a query-free tail. A signed URL
 * always carries `?token=...`, so the parameter is set through `URL` instead of
 * being concatenated — and a URL that cannot be parsed is returned untouched
 * rather than mangled.
 *
 * Why the format is pinned in the URL instead of left to content negotiation:
 * Supabase's transformer will return WebP on its own if the request's Accept
 * header asks for it — but its responses carry NO `Vary: Accept`. Any cache in
 * the path (the browser's included) therefore keys purely on the URL and hands
 * every later requester whichever format happened to be fetched first. Naming the
 * format in the URL makes the cache key describe the bytes, so the saving cannot
 * silently evaporate depending on who warmed the cache.
 */
export function withWebpFormat(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("format", "webp");
    return parsed.toString();
  } catch {
    return url;
  }
}

/** The bucket every project asset lives in. */
export const PROJECT_ASSET_BUCKET = "project-assets";

/** One hour: long enough for a page session, short enough to be revocable. */
export const PROJECT_ASSET_URL_TTL_SECONDS = 3600;

export type ProjectAssetUrlErrorCode = "sign_failed";

export class ProjectAssetUrlError extends Error {
  readonly code: ProjectAssetUrlErrorCode;

  constructor(code: ProjectAssetUrlErrorCode, message: string) {
    super(message);
    this.name = "ProjectAssetUrlError";
    this.code = code;
  }
}

/**
 * On-the-fly image transform, as the storage API accepts it on a signed URL.
 * Absent means "sign the object as stored".
 */
export type ProjectAssetTransform = {
  width?: number;
  height?: number;
  resize?: "cover" | "contain" | "fill";
};

/**
 * The slice of a Supabase client this module needs. Structural on purpose: both
 * the user client and the admin client satisfy it, and tests can pass a stub.
 */
export type ProjectAssetSigningClient = {
  storage: {
    from(bucket: string): {
      createSignedUrl(
        path: string,
        expiresIn: number,
        options?: {
          transform?: ProjectAssetTransform;
          download?: string | boolean;
        },
      ): PromiseLike<{
        data: { signedUrl: string } | null;
        error: { message: string } | null;
      }>;
    };
  };
};

/**
 * Everything this module accepts as the thing that signs.
 *
 * T-133 slice 9 step 1: the seam is being widened from "a Supabase-shaped client"
 * to "a Supabase-shaped client OR an `ObjectStore`". Both spellings are live at
 * the same time on purpose — the fifteen call sites still hand in a client, and
 * the slices that follow move them over one service at a time. This is a
 * TRANSITIONAL shape: slice 10 deletes the legacy member below (and the
 * `createSupabaseObjectStore` hop that serves it), and only then does
 * `ObjectStore` become the one answer. Until that deletion, both branches must
 * stay behaviourally identical, which is why they share the TTL and the option
 * building rather than each growing their own copy.
 */
export type ProjectAssetSigningSource =
  | UserSupabaseClient
  | AdminSupabaseClient
  | ProjectAssetSigningClient
  | ObjectStore;

/**
 * Which of the two shapes above was handed in.
 *
 * Structural, because the whole point of the union is that the two shapes share
 * no nominal tag: a Supabase client carries a `storage` namespace, an
 * `ObjectStore` has the seam's own methods, and `signedReadUrl` is the one method
 * that only the seam has. (The dependency audit reads raw source text, so this
 * comment deliberately does not spell out the SDK's bucket-lookup call: a mention
 * would be counted as a call site.)
 * Written defensively (`?.` plus a `typeof` test) because the call sites are typed
 * loosely enough to pass `undefined`/`null` through in practice: a missing client
 * must be treated as "not a store" and fail the way it always did, rather than
 * throwing a new TypeError out of the guard itself.
 */
export function isObjectStoreSource(value: unknown): value is ObjectStore {
  return (
    typeof (value as ObjectStore | null | undefined)?.signedReadUrl === "function"
  );
}

export type SignProjectAssetOptions = {
  ttlSeconds?: number;
  transform?: ProjectAssetTransform;
  bucket?: string;
  /**
   * ED-05: the name a download should carry. The storage service turns this into
   * `Content-Disposition: attachment; filename*=UTF-8''…`, which is the only way
   * the name a person gave the file survives an ASCII object key.
   */
  download?: string;
};

/**
 * Sign one object path. Throws `ProjectAssetUrlError` when the storage API
 * refuses — a refusal usually means the caller may not read the object, and that
 * is an answer, not a failure to paper over.
 */
export async function signProjectAssetUrl(
  client: ProjectAssetSigningSource,
  objectPath: string,
  options: SignProjectAssetOptions = {},
): Promise<string> {
  const bucket = options.bucket ?? PROJECT_ASSET_BUCKET;
  const ttl = options.ttlSeconds ?? PROJECT_ASSET_URL_TTL_SECONDS;

  // T-133 slice 9 step 1, the two branches: a caller that already speaks the
  // seam signs directly; a caller that still holds a Supabase client keeps the
  // adapter hop it has had since 43C. Both end in the same `signedReadUrl` call
  // with the same ref, TTL and optional parts, so this is a widening of what is
  // accepted, not a new way for a URL to be produced. Slice 10 removes the
  // adapter hop.
  //
  // The cast in the else arm is only about the type: the adapter reaches nothing
  // but the signed URL call, which is the one method every structural stub of
  // this module has always had to provide. Making the type name the rest of the
  // SDK surface would widen the requirement on the callers' clients for no
  // runtime difference.
  const store = isObjectStoreSource(client)
    ? client
    : createSupabaseObjectStore(client as unknown as SupabaseStorageLike);

  try {
    // Only send the optional parts when the caller asked for them: a plain
    // signature must keep reaching the backend with no options at all.
    return await store.signedReadUrl(
      { bucket, key: objectPath },
      {
        ttlSeconds: ttl,
        ...(options.transform ? { transform: options.transform } : {}),
        ...(options.download ? { download: options.download } : {}),
      },
    );
  } catch (err) {
    // The adapter words a signing refusal exactly as this module always has, so
    // reusing its text keeps the log line byte-for-byte what it was — and it
    // still carries neither the object path nor a URL, because a signed URL is a
    // bearer token. Anything that is not a store failure is not ours to reword.
    if (err instanceof ObjectStoreError) {
      throw new ProjectAssetUrlError("sign_failed", err.message);
    }
    throw err;
  }
}

/**
 * Sign many paths, returning `path -> url`.
 *
 * A path that could not be signed is simply ABSENT from the map. Callers must
 * treat that as "no URL for this object" and omit it — never as "use the public
 * one". One bad object must not deny the rest of a list.
 */
export async function signProjectAssetUrls(
  client: ProjectAssetSigningSource,
  objectPaths: readonly string[],
  options: SignProjectAssetOptions = {},
): Promise<Map<string, string>> {
  const signed = new Map<string, string>();
  const unique = [...new Set(objectPaths)].filter((path) => path.length > 0);

  // T-133 slice 9 step 1: an `ObjectStore` caller that asked for nothing but
  // plain URLs gets the seam's own batch call, one round trip for the whole set.
  // The gate is on the options because `signedReadUrls` carries only a TTL: with
  // a transform or a download name there is no batch spelling of the request, so
  // those fall through to the per-path loop below and reach `signedReadUrl` —
  // the one place that decides how a single signature is made, whichever shape
  // was handed in.
  if (
    isObjectStoreSource(client) &&
    !options.transform &&
    !options.download &&
    unique.length > 0
  ) {
    const bucket = options.bucket ?? PROJECT_ASSET_BUCKET;
    const ttl = options.ttlSeconds ?? PROJECT_ASSET_URL_TTL_SECONDS;

    try {
      const answered = await client.signedReadUrls(bucket, unique, {
        ttlSeconds: ttl,
      });
      // Same answer as the loop below: a key the backend did not sign is simply
      // ABSENT, and the order is the order the caller asked in.
      for (const path of unique) {
        const url = answered.get(path);
        if (url) signed.set(path, url);
      }
      return signed;
    } catch {
      // This function has never thrown: one unusable key must not deny the rest,
      // and a batch the backend rejected wholesale is the same answer as a batch
      // that came back empty.
      return signed;
    }
  }

  const results = await Promise.all(
    unique.map(async (path) => {
      try {
        return [path, await signProjectAssetUrl(client, path, options)] as const;
      } catch {
        return null;
      }
    }),
  );

  for (const result of results) {
    if (result) signed.set(result[0], result[1]);
  }

  return signed;
}
