// OP-05 / 43D: short-lived, signed read links for the private file volume.
//
// A link looks like
//   <publicBase>/objects/<bucket>/<key>?exp=<unix seconds>&disp=<base64url name>&sig=<HMAC>
// and the signature covers `bucket \n key \n exp \n disp`, so changing any of
// the four invalidates it. Only the standard library is used (ADR-0001: no
// home-made cryptographic primitives): HMAC-SHA256 and a constant-time compare.
//
// Pure functions, no I/O: the file-volume store signs, and the (later) route
// verifies, with the same secret.
import { createHmac, timingSafeEqual } from "node:crypto";

const MIN_SECRET_BYTES = 32;

export type SignObjectUrlInput = {
  secret: Uint8Array;
  publicBase: string;
  bucket: string;
  key: string;
  /** Expiry as unix seconds. */
  expiresAt: number;
  /** Name the download should carry; omitted for an inline link. */
  download?: string;
};

export type VerifyObjectUrlInput = {
  secret: Uint8Array;
  bucket: string;
  key: string;
  exp: string | undefined;
  disp: string | undefined;
  sig: string | undefined;
  /** Current time as unix seconds. */
  now: number;
};

export type VerifyObjectUrlResult =
  | { ok: true; download?: string }
  | { ok: false; reason: "missing" | "expired" | "bad_signature" };

/** Reject a secret too short to be a key; the message names the env var. */
export function objectUrlSecretFrom(raw: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(raw, "utf8"));
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new Error("HAHART_OBJECT_URL_SECRET must be at least 32 bytes");
  }
  return bytes;
}

function computeSignature(
  secret: Uint8Array,
  bucket: string,
  key: string,
  exp: string,
  disp: string,
): string {
  return createHmac("sha256", secret)
    .update(`${bucket}\n${key}\n${exp}\n${disp}`)
    .digest("base64url");
}

function encodePath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function signObjectUrl(input: SignObjectUrlInput): string {
  const exp = String(input.expiresAt);
  const disp = input.download
    ? Buffer.from(input.download, "utf8").toString("base64url")
    : "";
  const sig = computeSignature(
    input.secret,
    input.bucket,
    input.key,
    exp,
    disp,
  );

  const base = input.publicBase.replace(/\/+$/, "");
  const query = [`exp=${exp}`];
  if (disp) {
    query.push(`disp=${disp}`);
  }
  query.push(`sig=${sig}`);

  return `${base}/objects/${encodeURIComponent(input.bucket)}/${encodePath(
    input.key,
  )}?${query.join("&")}`;
}

export function verifyObjectUrl(
  input: VerifyObjectUrlInput,
): VerifyObjectUrlResult {
  const { exp, sig } = input;
  if (!exp || !sig) {
    return { ok: false, reason: "missing" };
  }

  if (!/^\d+$/.test(exp) || Number(exp) <= input.now) {
    return { ok: false, reason: "expired" };
  }

  const disp = input.disp ?? "";
  const expected = Buffer.from(
    computeSignature(input.secret, input.bucket, input.key, exp, disp),
    "utf8",
  );
  const received = Buffer.from(sig, "utf8");
  // timingSafeEqual throws on unequal lengths, so a wrong length is its own
  // (cheap, non-secret) mismatch.
  if (
    received.byteLength !== expected.byteLength ||
    !timingSafeEqual(received, expected)
  ) {
    return { ok: false, reason: "bad_signature" };
  }

  if (!disp) {
    return { ok: true };
  }

  try {
    const decoded = Buffer.from(disp, "base64url").toString("utf8");
    return { ok: true, download: decoded };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}
