// HAHART auth primitive (ticket 42A): access-token signing/verification and
// opaque refresh tokens.
//
// Access tokens are HS256 JWTs, short lived, carrying the user (`sub`), the
// session (`sid`), a credential version (`ver`) and the email. Refresh tokens
// are NOT JWTs: they are 32 random bytes, handed to the client as base64url and
// stored only as their sha256 hex digest, so a leaked database cannot mint
// sessions.
//
// Pure module: no database, no routes, no env reads (the secret is injected by
// the caller through `AccessTokenConfig`).
import { createHash, randomBytes } from "node:crypto";

import { SignJWT, jwtVerify } from "jose";

export type AccessTokenConfig = {
  secret: Uint8Array;
  issuer: string;
  audience: string;
  ttlSeconds: number;
};

export type AccessTokenClaims = {
  sub: string;
  sid: string;
  ver: number;
  email: string;
};

export type AccessTokenResult =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: "invalid" | "expired" };

/** 15 minutes, per the project decision recorded for ticket 42A. */
export const DEFAULT_ACCESS_TTL_SECONDS = 900;

/** Refresh tokens are 32 random bytes -> 43 base64url characters. */
export const REFRESH_TOKEN_BYTES = 32;
export const REFRESH_TOKEN_LENGTH = 43;

const ACCESS_TOKEN_ALGORITHM = "HS256";
const MIN_SECRET_BYTES = 32;

function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Turns the configured secret string into signing key bytes.
 *
 * Below 32 bytes of UTF-8 the HS256 key would be weaker than the hash itself,
 * so that is a hard configuration error rather than a silent fallback.
 */
export function accessTokenSecretFrom(raw: string): Uint8Array {
  const bytes = new TextEncoder().encode(raw);
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new Error("HAHART_AUTH_JWT_SECRET must be at least 32 bytes");
  }
  return bytes;
}

/**
 * Signs a short-lived access token. `now` is injectable so tests can produce
 * deterministic `iat` / `exp` values.
 */
export async function signAccessToken(
  cfg: AccessTokenConfig,
  claims: AccessTokenClaims,
  now?: Date,
): Promise<string> {
  const issuedAt = epochSeconds(now ?? new Date());
  return new SignJWT({
    sid: claims.sid,
    ver: claims.ver,
    email: claims.email,
  })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM })
    .setSubject(claims.sub)
    .setIssuer(cfg.issuer)
    .setAudience(cfg.audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + cfg.ttlSeconds)
    .sign(cfg.secret);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Verifies an access token. Never throws: every failure collapses into
 * `ok: false` with a machine-readable reason, so callers can map it to a
 * 401 without a try/catch at each call site.
 *
 * Only HS256 is accepted (an `alg: none` or HS512 token signed with the same
 * secret is rejected), and issuer / audience / expiry are enforced by `jose`.
 */
export async function verifyAccessToken(
  cfg: AccessTokenConfig,
  token: string,
  now?: Date,
): Promise<AccessTokenResult> {
  const nowDate = now ?? new Date();
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, cfg.secret, {
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      issuer: cfg.issuer,
      audience: cfg.audience,
      currentDate: nowDate,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ERR_JWT_EXPIRED") {
      return { ok: false, reason: "expired" };
    }
    return { ok: false, reason: "invalid" };
  }

  const { sub, sid, ver, email } = payload;
  if (
    typeof sub !== "string" ||
    sub.length === 0 ||
    typeof sid !== "string" ||
    sid.length === 0 ||
    typeof email !== "string" ||
    email.length === 0 ||
    !isNonNegativeInteger(ver)
  ) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, claims: { sub, sid, ver, email } };
}

/**
 * Creates a fresh opaque refresh token plus the digest we are allowed to store.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

/** sha256 hex digest of a refresh token — the only form that gets persisted. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
