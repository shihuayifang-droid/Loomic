import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CALLBACK_TIMESTAMP_TOLERANCE_SECONDS,
  PAY_SIGN_KEY_ENV,
  paySignKeyFromEnv,
  verifyCallbackSignature,
  type VerifyCallbackSignatureInput,
} from "./callback-signature.js";

/**
 * 工单45DH / OP-16 —— 支付回调验签。
 *
 * The expected signatures here are computed with `node:crypto` directly, not
 * with the module under test, so a bug in the module cannot make its own test
 * pass. `TEST_SECRET` is a throwaway string that exists only in this file — it
 * is not, and must never become, a real key.
 */
const TEST_SECRET = "test-only-callback-secret-not-a-real-key";
const NOW = 1_700_000_000;
const BODY = '{"event":"order.paid","order_id":"ord_1","amount":100}';

function hexSignature(
  body: string,
  timestamp: string,
  secret: string = TEST_SECRET,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${body}`, "utf8")
    .digest("hex");
}

function validInput(
  overrides: Partial<VerifyCallbackSignatureInput> = {},
): VerifyCallbackSignatureInput {
  const timestamp = String(NOW);
  return {
    body: BODY,
    signature: hexSignature(BODY, timestamp),
    timestamp,
    secret: TEST_SECRET,
    nowSeconds: NOW,
    ...overrides,
  };
}

describe("verifyCallbackSignature", () => {
  it("accepts a body signed with the configured secret inside the window", () => {
    expect(verifyCallbackSignature(validInput())).toEqual({ ok: true });
  });

  it("rejects a signature that does not match", () => {
    // Correctly signed, but with a different secret.
    expect(
      verifyCallbackSignature(
        validInput({ signature: hexSignature(BODY, String(NOW), "other-key") }),
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });

    // A too-short signature is a mismatch, not a thrown exception.
    expect(verifyCallbackSignature(validInput({ signature: "deadbeef" }))).toEqual({
      ok: false,
      reason: "bad_signature",
    });

    // Uppercase hex is the same signature.
    expect(
      verifyCallbackSignature(
        validInput({ signature: hexSignature(BODY, String(NOW)).toUpperCase() }),
      ),
    ).toEqual({ ok: true });
  });

  it("rejects a timestamp outside the window", () => {
    const stale = String(
      NOW - DEFAULT_CALLBACK_TIMESTAMP_TOLERANCE_SECONDS - 1,
    );
    expect(
      verifyCallbackSignature(
        validInput({ timestamp: stale, signature: hexSignature(BODY, stale) }),
      ),
    ).toEqual({ ok: false, reason: "expired_timestamp" });

    const future = String(
      NOW + DEFAULT_CALLBACK_TIMESTAMP_TOLERANCE_SECONDS + 1,
    );
    expect(
      verifyCallbackSignature(
        validInput({ timestamp: future, signature: hexSignature(BODY, future) }),
      ),
    ).toEqual({ ok: false, reason: "expired_timestamp" });

    // A stale timestamp that is still correctly signed is still stale: the
    // window is checked before the HMAC.
    const signedLongAgo = "1000000000";
    expect(
      verifyCallbackSignature(
        validInput({
          timestamp: signedLongAgo,
          signature: hexSignature(BODY, signedLongAgo),
        }),
      ),
    ).toEqual({ ok: false, reason: "expired_timestamp" });
  });

  it("rejects a request with a missing field", () => {
    for (const field of ["body", "signature", "timestamp", "secret"] as const) {
      expect(
        verifyCallbackSignature(validInput({ [field]: undefined })),
      ).toEqual({ ok: false, reason: "missing_field" });
    }

    expect(verifyCallbackSignature(validInput({ signature: "   " }))).toEqual({
      ok: false,
      reason: "missing_field",
    });
    expect(verifyCallbackSignature({})).toEqual({
      ok: false,
      reason: "missing_field",
    });
  });

  it("rejects a body that changed after it was signed", () => {
    const signedBody = BODY;
    const tamperedBody = BODY.replace('"amount":100', '"amount":10000');
    expect(tamperedBody).not.toBe(signedBody);
    expect(
      verifyCallbackSignature(
        validInput({
          body: tamperedBody,
          signature: hexSignature(signedBody, String(NOW)),
        }),
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a timestamp that is not unix seconds", () => {
    for (const timestamp of ["not-a-number", "17e8", "-1", "2026-10-26T00:00:00Z"]) {
      expect(
        verifyCallbackSignature(
          validInput({ timestamp, signature: hexSignature(BODY, timestamp) }),
        ),
      ).toEqual({ ok: false, reason: "bad_timestamp" });
    }
  });

  it("treats the window boundary as still fresh and honours a custom window", () => {
    const atBoundary = String(
      NOW - DEFAULT_CALLBACK_TIMESTAMP_TOLERANCE_SECONDS,
    );
    expect(
      verifyCallbackSignature(
        validInput({
          timestamp: atBoundary,
          signature: hexSignature(BODY, atBoundary),
        }),
      ),
    ).toEqual({ ok: true });

    expect(
      verifyCallbackSignature(
        validInput({ toleranceSeconds: 10, nowSeconds: NOW + 11 }),
      ),
    ).toEqual({ ok: false, reason: "expired_timestamp" });

    expect(
      verifyCallbackSignature(
        validInput({ toleranceSeconds: 10, nowSeconds: NOW + 10 }),
      ),
    ).toEqual({ ok: true });
  });
});

describe("paySignKeyFromEnv", () => {
  it("reads HAHART_PAY_SIGN_KEY and treats blank as absent", () => {
    expect(paySignKeyFromEnv({ [PAY_SIGN_KEY_ENV]: "abc123" })).toBe("abc123");
    expect(paySignKeyFromEnv({ [PAY_SIGN_KEY_ENV]: "  abc123  " })).toBe(
      "abc123",
    );
    expect(paySignKeyFromEnv({ [PAY_SIGN_KEY_ENV]: "   " })).toBeUndefined();
    expect(paySignKeyFromEnv({})).toBeUndefined();
  });

  it("verifies with the secret read from the environment", () => {
    const secret = "env-only-secret-for-this-test";
    const timestamp = String(NOW);
    expect(
      verifyCallbackSignature({
        body: BODY,
        signature: hexSignature(BODY, timestamp, secret),
        timestamp,
        secret: paySignKeyFromEnv({ [PAY_SIGN_KEY_ENV]: secret }),
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: true });

    expect(
      verifyCallbackSignature({
        body: BODY,
        signature: hexSignature(BODY, timestamp, secret),
        timestamp,
        secret: paySignKeyFromEnv({}),
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: false, reason: "missing_field" });
  });
});
