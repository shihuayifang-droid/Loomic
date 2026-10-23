// HAHART auth primitive (ticket 42A): password hashing.
//
// This module is a pure primitive: no database, no routes, no env coupling. It
// only owns "how a password becomes a stored hash" and "what a password is
// allowed to look like". Wiring arrives in a later ticket.
import { hash, verify } from "@node-rs/argon2";

/**
 * `@node-rs/argon2` ships `Algorithm` as an ambient `const enum`, and this
 * package compiles with `isolatedModules`, so reading the member as a value is
 * a compile error (TS2748). The literal below is that member's value:
 * `Algorithm.Argon2id === 2`.
 */
export const ARGON2ID = 2;

/**
 * OWASP's minimum acceptable argon2id parameters
 * (m=19456 KiB, t=2, p=1). Pinned here so every caller hashes identically and
 * the stored hash can be re-verified by a future implementation.
 */
export const PASSWORD_HASH_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Password length bounds, counted in Unicode code points. */
export const PASSWORD_MIN_CODE_POINTS = 8;
export const PASSWORD_MAX_CODE_POINTS = 128;

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; reason: "too_short" | "too_long" };

/**
 * Hashes a plaintext password. The returned string is the full PHC-style
 * argon2id encoding (salt + parameters included), so it is safe to store as-is.
 */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, PASSWORD_HASH_OPTIONS);
}

/**
 * Verifies a plaintext password against a stored hash.
 *
 * A malformed / truncated / non-argon2 hash string makes the underlying
 * verifier throw; callers only ever care about "does it match", so this
 * normalises every such failure to `false` instead of propagating.
 */
export async function verifyPassword(
  passwordHash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

/**
 * Length-only policy check. Counted in code points rather than UTF-16 units so
 * an 8-emoji password is not silently treated as 16 "characters".
 */
export function validatePasswordPolicy(
  plain: string,
): PasswordPolicyResult {
  const length = Array.from(plain).length;
  if (length < PASSWORD_MIN_CODE_POINTS) {
    return { ok: false, reason: "too_short" };
  }
  if (length > PASSWORD_MAX_CODE_POINTS) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true };
}
