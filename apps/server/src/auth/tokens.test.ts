// Ticket 42A: access-token and refresh-token primitives.
//
// The migration plan requires the six negative token classes to be rejected
// individually (tampered signature, wrong issuer, wrong audience, expired,
// alg:none, non-HS256) plus a claim-shape check. Each gets its own case below so
// a regression names exactly which class regressed. Test secrets are synthetic
// ("x".repeat(32)) — never a real key.
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ACCESS_TTL_SECONDS,
  REFRESH_TOKEN_LENGTH,
  accessTokenSecretFrom,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
  type AccessTokenConfig,
} from "./tokens.js";

const SECRET_RAW = "x".repeat(32);
const OTHER_SECRET_RAW = "y".repeat(32);

const CLAIMS: AccessTokenClaims = {
  sub: "user-1",
  sid: "session-1",
  ver: 3,
  email: "user@example.com",
};

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeConfig(overrides: Partial<AccessTokenConfig> = {}): AccessTokenConfig {
  return {
    secret: accessTokenSecretFrom(SECRET_RAW),
    issuer: "hahart",
    audience: "hahart-api",
    ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
    ...overrides,
  };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("accessTokenSecretFrom", () => {
  it("throws for a secret shorter than 32 bytes", () => {
    expect(() => accessTokenSecretFrom("short")).toThrow(
      "HAHART_AUTH_JWT_SECRET must be at least 32 bytes",
    );
    expect(() => accessTokenSecretFrom("x".repeat(31))).toThrow(
      "HAHART_AUTH_JWT_SECRET must be at least 32 bytes",
    );
  });

  it("accepts exactly 32 bytes and returns UTF-8 bytes", () => {
    const secret = accessTokenSecretFrom(SECRET_RAW);
    expect(secret).toBeInstanceOf(Uint8Array);
    expect(secret.byteLength).toBe(32);
    // Multi-byte characters count as their UTF-8 byte length.
    expect(accessTokenSecretFrom("密".repeat(11)).byteLength).toBe(33);
    expect(() => accessTokenSecretFrom("密".repeat(10))).toThrow();
  });
});

describe("signAccessToken / verifyAccessToken", () => {
  it("round-trips the claims", async () => {
    const cfg = makeConfig();
    const token = await signAccessToken(cfg, CLAIMS, NOW);
    const result = await verifyAccessToken(cfg, token, NOW);
    expect(result).toEqual({ ok: true, claims: CLAIMS });
    // Default TTL is 15 minutes.
    expect(DEFAULT_ACCESS_TTL_SECONDS).toBe(900);
  });

  it("rejects a token verified with a different secret (tampered signature)", async () => {
    const token = await signAccessToken(makeConfig(), CLAIMS, NOW);
    const other = makeConfig({ secret: accessTokenSecretFrom(OTHER_SECRET_RAW) });
    await expect(verifyAccessToken(other, token, NOW)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a token whose body was edited", async () => {
    const token = await signAccessToken(makeConfig(), CLAIMS, NOW);
    const [header, , signature] = token.split(".");
    const tampered = `${header}.${base64url({ ...CLAIMS, sub: "user-2" })}.${signature}`;
    await expect(verifyAccessToken(makeConfig(), tampered, NOW)).resolves.toEqual(
      { ok: false, reason: "invalid" },
    );
  });

  it("rejects a wrong issuer", async () => {
    const token = await signAccessToken(makeConfig(), CLAIMS, NOW);
    await expect(
      verifyAccessToken(makeConfig({ issuer: "evil" }), token, NOW),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a wrong audience", async () => {
    const token = await signAccessToken(makeConfig(), CLAIMS, NOW);
    await expect(
      verifyAccessToken(makeConfig({ audience: "other-api" }), token, NOW),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("reports expired once now passes the ttl", async () => {
    const cfg = makeConfig();
    const token = await signAccessToken(cfg, CLAIMS, NOW);
    const justInside = new Date(NOW.getTime() + (DEFAULT_ACCESS_TTL_SECONDS - 5) * 1000);
    const justOutside = new Date(NOW.getTime() + (DEFAULT_ACCESS_TTL_SECONDS + 5) * 1000);
    await expect(verifyAccessToken(cfg, token, justInside)).resolves.toEqual({
      ok: true,
      claims: CLAIMS,
    });
    await expect(verifyAccessToken(cfg, token, justOutside)).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects an alg:none token", async () => {
    const cfg = makeConfig();
    const exp = Math.floor(NOW.getTime() / 1000) + DEFAULT_ACCESS_TTL_SECONDS;
    const header = base64url({ alg: "none", typ: "JWT" });
    const payload = base64url({
      sub: CLAIMS.sub,
      sid: CLAIMS.sid,
      ver: CLAIMS.ver,
      email: CLAIMS.email,
      iss: cfg.issuer,
      aud: cfg.audience,
      iat: Math.floor(NOW.getTime() / 1000),
      exp,
    });
    await expect(
      verifyAccessToken(cfg, `${header}.${payload}.`, NOW),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an HS512 token signed with the same secret", async () => {
    const cfg = makeConfig();
    const iat = Math.floor(NOW.getTime() / 1000);
    const token = await new SignJWT({
      sid: CLAIMS.sid,
      ver: CLAIMS.ver,
      email: CLAIMS.email,
    })
      .setProtectedHeader({ alg: "HS512" })
      .setSubject(CLAIMS.sub)
      .setIssuer(cfg.issuer)
      .setAudience(cfg.audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + DEFAULT_ACCESS_TTL_SECONDS)
      .sign(cfg.secret);
    await expect(verifyAccessToken(cfg, token, NOW)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a token with a missing sid", async () => {
    const cfg = makeConfig();
    const iat = Math.floor(NOW.getTime() / 1000);
    const token = await new SignJWT({ ver: 1, email: CLAIMS.email })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(CLAIMS.sub)
      .setIssuer(cfg.issuer)
      .setAudience(cfg.audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + DEFAULT_ACCESS_TTL_SECONDS)
      .sign(cfg.secret);
    await expect(verifyAccessToken(cfg, token, NOW)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a non-integer ver", async () => {
    const cfg = makeConfig();
    const iat = Math.floor(NOW.getTime() / 1000);
    const token = await new SignJWT({
      sid: CLAIMS.sid,
      ver: "3",
      email: CLAIMS.email,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(CLAIMS.sub)
      .setIssuer(cfg.issuer)
      .setAudience(cfg.audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + DEFAULT_ACCESS_TTL_SECONDS)
      .sign(cfg.secret);
    await expect(verifyAccessToken(cfg, token, NOW)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("never throws on garbage input", async () => {
    await expect(verifyAccessToken(makeConfig(), "", NOW)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    await expect(
      verifyAccessToken(makeConfig(), "a.b.c", NOW),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });
});

describe("refresh tokens", () => {
  it("generates distinct 43-char base64url tokens with matching hashes", () => {
    const first = generateRefreshToken();
    const second = generateRefreshToken();
    expect(first.token).not.toBe(second.token);
    expect(first.token).toHaveLength(REFRESH_TOKEN_LENGTH);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.hash).toBe(hashRefreshToken(first.token));
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.hash).toBe(hashRefreshToken(second.token));
    expect(first.hash).not.toBe(second.hash);
  });

  it("hashes deterministically", () => {
    expect(hashRefreshToken("abc")).toBe(hashRefreshToken("abc"));
    expect(hashRefreshToken("abc")).not.toBe(hashRefreshToken("abd"));
  });
});
