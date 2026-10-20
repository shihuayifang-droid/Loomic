// ED-00j: the ONE way a server-side tool gets the image it works on.
//
// A tool must never be handed a URL. A URL is a choice the caller could make
// wrongly — a display variant, a thumbnail, someone else's object, an address on
// the open internet — and every one of those changes the bytes the tool sees
// while looking like a perfectly ordinary request. So a tool call carries an
// `artifact_id`, and this module is what turns that id into bytes it may read:
//
//   artifact_id -> read ACL (the asset_objects row) -> signature, no transform.
//
// The signature deliberately carries NO display transform and NO download
// disposition: a transform is expressed as query parameters on the signed URL,
// and a tool that silently got a downscaled variant would produce output that
// does not match the original pixels. There is no URL-shaped input on this API;
// the resolver owns the address, the caller owns only the id.
import type { AssetReadRow, AssetReadRepository } from "../../db/asset-read-repository.js";
import { signProjectAssetUrl } from "../storage/project-asset-urls.js";

/** Every way resolving an original can fail, and nothing else. */
export type OriginalSourceErrorCode = "not_found" | "lookup_failed" | "sign_failed";

/**
 * The single failure type of this module.
 *
 * The message never carries the URL or the object key: this string reaches logs,
 * and a signed URL is a bearer token, so echoing it would hand out the very
 * capability the read ACL just checked for.
 */
export class OriginalSourceError extends Error {
  readonly code: OriginalSourceErrorCode;

  constructor(code: OriginalSourceErrorCode, message: string) {
    super(message);
    this.name = "OriginalSourceError";
    this.code = code;
  }
}

/** What a tool gets to work with: bytes it may fetch, and what they are. */
export type OriginalSource = {
  url: string;
  mimeType: string | null;
  byteSize: number | null;
  bucket: string;
  objectPath: string;
};

export type ResolveOriginalSourceDeps = {
  assetReadRepository: Pick<AssetReadRepository, "findReadableAsset">;
  signingClient: Parameters<typeof signProjectAssetUrl>[0];
};

export type ResolveOriginalSourceInput = {
  /** Who is asking; the read ACL is evaluated as this actor. */
  actorId: string;
  /** The artifact the tool was asked to work on. An id, never a URL. */
  artifactId: string;
};

/**
 * ED-00j: the ONLY way a server-side tool gets its input image. Resolves the
 * artifact through the read ACL and signs the stored object with NO transform,
 * so a tool always works on the original pixels, never a display variant.
 */
export async function resolveOriginalSource(
  deps: ResolveOriginalSourceDeps,
  input: ResolveOriginalSourceInput,
): Promise<OriginalSource> {
  let row: AssetReadRow | null;
  try {
    row = await deps.assetReadRepository.findReadableAsset({
      actorId: input.actorId,
      assetId: input.artifactId,
    });
  } catch {
    // The repository failing is not the same answer as "there is no such
    // artifact": the caller must be able to tell a broken lookup from a denial,
    // because only one of them is worth retrying.
    throw new OriginalSourceError("lookup_failed", "Could not look up the requested artifact.");
  }

  if (!row) {
    throw new OriginalSourceError("not_found", "No readable artifact with that id.");
  }

  let url: string;
  try {
    // No `transform`, no `download`: the stored object, exactly as uploaded.
    url = await signProjectAssetUrl(deps.signingClient, row.object_path, {
      bucket: row.bucket,
    });
  } catch {
    throw new OriginalSourceError("sign_failed", "Could not sign the stored original.");
  }

  return {
    url,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    bucket: row.bucket,
    objectPath: row.object_path,
  };
}
