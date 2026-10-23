import { describe, expect, it } from "vitest";

import {
  objectUrlSecretFrom,
  signObjectUrl,
  verifyObjectUrl,
} from "./object-url-signature.js";

const secret = objectUrlSecretFrom("0123456789abcdef0123456789abcdef");
const otherSecret = objectUrlSecretFrom("fedcba9876543210fedcba9876543210");
const NOW = 1_000_000;

function parse(url: string) {
  const parsed = new URL(url);
  return {
    pathname: parsed.pathname,
    exp: parsed.searchParams.get("exp") ?? undefined,
    disp: parsed.searchParams.get("disp") ?? undefined,
    sig: parsed.searchParams.get("sig") ?? undefined,
  };
}

function sign(download?: string, key = "ws/proj/a b.png") {
  return signObjectUrl({
    secret,
    publicBase: "https://files.example.test/",
    bucket: "assets",
    key,
    expiresAt: NOW + 60,
    ...(download ? { download } : {}),
  });
}

describe("object-url-signature", () => {
  it("builds the documented URL shape with encoded path segments", () => {
    const url = sign(undefined, "ws/proj/a b.png");
    expect(url.startsWith("https://files.example.test/objects/assets/ws/proj/a%20b.png?")).toBe(true);
    const q = parse(url);
    expect(q.exp).toBe(String(NOW + 60));
    expect(q.disp).toBeUndefined();
    expect(q.sig).toBeTruthy();
  });

  it("round-trips without a download name", () => {
    const q = parse(sign());
    expect(
      verifyObjectUrl({ secret, bucket: "assets", key: "ws/proj/a b.png", ...q, now: NOW }),
    ).toEqual({ ok: true });
  });

  it.each(["report final.pdf", "中文 文件名.png"])(
    "round-trips and echoes the download name %s",
    (name) => {
      const q = parse(sign(name));
      expect(
        verifyObjectUrl({ secret, bucket: "assets", key: "ws/proj/a b.png", ...q, now: NOW }),
      ).toEqual({ ok: true, download: name });
    },
  );

  it("rejects a changed key, bucket, exp or disp", () => {
    const q = parse(sign("name.png"));
    const base = { secret, bucket: "assets", key: "ws/proj/a b.png", ...q, now: NOW };
    expect(verifyObjectUrl({ ...base, key: "ws/proj/other.png" })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyObjectUrl({ ...base, bucket: "other" })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyObjectUrl({ ...base, exp: String(NOW + 9999) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(
      verifyObjectUrl({ ...base, disp: Buffer.from("evil.png").toString("base64url") }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports an expired link", () => {
    const q = parse(sign());
    expect(
      verifyObjectUrl({ secret, bucket: "assets", key: "ws/proj/a b.png", ...q, now: NOW + 60 }),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      verifyObjectUrl({ secret, bucket: "assets", key: "ws/proj/a b.png", ...q, exp: "abc", now: NOW }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("reports missing parameters", () => {
    const q = parse(sign());
    const base = { secret, bucket: "assets", key: "ws/proj/a b.png", ...q, now: NOW };
    expect(verifyObjectUrl({ ...base, sig: undefined })).toEqual({ ok: false, reason: "missing" });
    expect(verifyObjectUrl({ ...base, exp: undefined })).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a different secret", () => {
    const q = parse(sign());
    expect(
      verifyObjectUrl({ secret: otherSecret, bucket: "assets", key: "ws/proj/a b.png", ...q, now: NOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("does not throw on a signature of a different length", () => {
    const q = parse(sign());
    for (const sig of ["x", "", "a".repeat(200)]) {
      const result = verifyObjectUrl({
        secret,
        bucket: "assets",
        key: "ws/proj/a b.png",
        ...q,
        sig,
        now: NOW,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a secret shorter than 32 bytes", () => {
    expect(() => objectUrlSecretFrom("short")).toThrow(
      "HAHART_OBJECT_URL_SECRET must be at least 32 bytes",
    );
  });
});
