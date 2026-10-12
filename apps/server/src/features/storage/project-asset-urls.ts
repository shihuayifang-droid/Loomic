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
        options?: { transform?: ProjectAssetTransform },
      ): PromiseLike<{
        data: { signedUrl: string } | null;
        error: { message: string } | null;
      }>;
    };
  };
};

export type SignProjectAssetOptions = {
  ttlSeconds?: number;
  transform?: ProjectAssetTransform;
  bucket?: string;
};

/**
 * Sign one object path. Throws `ProjectAssetUrlError` when the storage API
 * refuses — a refusal usually means the caller may not read the object, and that
 * is an answer, not a failure to paper over.
 */
export async function signProjectAssetUrl(
  client: UserSupabaseClient | AdminSupabaseClient | ProjectAssetSigningClient,
  objectPath: string,
  options: SignProjectAssetOptions = {},
): Promise<string> {
  const bucket = options.bucket ?? PROJECT_ASSET_BUCKET;
  const ttl = options.ttlSeconds ?? PROJECT_ASSET_URL_TTL_SECONDS;

  const { data, error } = await (
    client as ProjectAssetSigningClient
  ).storage
    .from(bucket)
    .createSignedUrl(
      objectPath,
      ttl,
      options.transform ? { transform: options.transform } : undefined,
    );

  if (error || !data?.signedUrl) {
    // Deliberately no URL and no object path in the message: this string ends up
    // in logs, and a signed URL is a bearer token.
    throw new ProjectAssetUrlError(
      "sign_failed",
      `Could not sign the stored object (${error?.message ?? "no signed url returned"}).`,
    );
  }

  return data.signedUrl;
}

/**
 * Sign many paths, returning `path -> url`.
 *
 * A path that could not be signed is simply ABSENT from the map. Callers must
 * treat that as "no URL for this object" and omit it — never as "use the public
 * one". One bad object must not deny the rest of a list.
 */
export async function signProjectAssetUrls(
  client: UserSupabaseClient | AdminSupabaseClient | ProjectAssetSigningClient,
  objectPaths: readonly string[],
  options: SignProjectAssetOptions = {},
): Promise<Map<string, string>> {
  const signed = new Map<string, string>();
  const unique = [...new Set(objectPaths)].filter((path) => path.length > 0);

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
