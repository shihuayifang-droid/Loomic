// Ticket 42A: password primitive behaviour pinned end to end.
//
// argon2 costs ~tens of ms per hash, so this file deliberately keeps the number
// of real hashes small (two hashes of the same password to prove salting, one
// extra to prove a wrong password fails).
import { describe, expect, it } from "vitest";

import {
  PASSWORD_HASH_OPTIONS,
  hashPassword,
  validatePasswordPolicy,
  verifyPassword,
} from "./password.js";

describe("hashPassword / verifyPassword", () => {
  it("accepts the correct password", async () => {
    const stored = await hashPassword("correct horse battery");
    await expect(verifyPassword(stored, "correct horse battery")).resolves.toBe(
      true,
    );
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery");
    await expect(verifyPassword(stored, "wrong horse battery")).resolves.toBe(
      false,
    );
  });

  it("produces a different hash for the same password each time (salted)", async () => {
    const first = await hashPassword("same password twice");
    const second = await hashPassword("same password twice");
    expect(first).not.toBe(second);
    await expect(verifyPassword(second, "same password twice")).resolves.toBe(
      true,
    );
  });

  it("emits an argon2id PHC string", async () => {
    const stored = await hashPassword("prefix check");
    expect(stored.startsWith("$argon2id$")).toBe(true);
  });

  it("uses the OWASP argon2id parameters", () => {
    // @node-rs/argon2 ships Algorithm as an ambient const enum, unreadable as a
    // value under isolatedModules; Algorithm.Argon2id === 2.
    expect(PASSWORD_HASH_OPTIONS.algorithm).toBe(2);
    expect(PASSWORD_HASH_OPTIONS.memoryCost).toBe(19456);
    expect(PASSWORD_HASH_OPTIONS.timeCost).toBe(2);
    expect(PASSWORD_HASH_OPTIONS.parallelism).toBe(1);
  });

  it("returns false for malformed hash strings instead of throwing", async () => {
    await expect(verifyPassword("not-a-hash", "whatever")).resolves.toBe(false);
    await expect(verifyPassword("", "whatever")).resolves.toBe(false);
    await expect(
      verifyPassword("$argon2id$v=19$m=1,t=1,p=1$abc", "whatever"),
    ).resolves.toBe(false);
  });
});

describe("validatePasswordPolicy", () => {
  it("rejects 7 code points as too_short", () => {
    expect(validatePasswordPolicy("abcdefg")).toEqual({
      ok: false,
      reason: "too_short",
    });
  });

  it("rejects 129 code points as too_long", () => {
    expect(validatePasswordPolicy("a".repeat(129))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("accepts exactly 8 code points", () => {
    expect(validatePasswordPolicy("abcdefgh")).toEqual({ ok: true });
    expect(validatePasswordPolicy("a".repeat(128))).toEqual({ ok: true });
  });

  it("counts code points, so 8 CJK chars / 8 emoji are accepted", () => {
    // 8 code points, 8 UTF-16 units:
    expect(validatePasswordPolicy("密码密码密码密码")).toEqual({ ok: true });
    // 8 code points, 16 UTF-16 units — must still be accepted:
    expect(validatePasswordPolicy("😀😀😀😀😀😀😀😀")).toEqual({ ok: true });
    // 7 code points, 14 UTF-16 units — must be rejected:
    expect(validatePasswordPolicy("😀😀😀😀😀😀😀")).toEqual({
      ok: false,
      reason: "too_short",
    });
  });
});
