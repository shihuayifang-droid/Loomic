// OP-16 / 工单45DH — payment callback signature verification.
//
// The callback route itself does not exist yet (see deploy/PAYMENT.md: the
// address `https://hahart.design/api/payments/callback` is only a registered
// convention for now, and `GET`/`POST /api/payments/*` still answers 410 from
// `src/http/payments-retired.ts`). This module is the pure verification half,
// so the future route, a replay guard and the tests can share one
// implementation instead of each rolling their own HMAC.
//
// Algorithm (the same three lines are repeated in deploy/PAYMENT.md):
//
//   canonical = `${timestamp}\n${rawBody}`
//   signature = hex( HMAC-SHA256( key = HAHART_PAY_SIGN_KEY,
//                                message = canonical ) )
//
// Two details that are easy to get wrong and are therefore spelled out:
//
//   * `rawBody` is the request body **exactly as it arrived**. Re-serialising
//     the JSON changes whitespace and key order, which changes the bytes and
//     breaks every signature.
//   * `timestamp` is unix **seconds**, and the same string goes into the HMAC
//     and into the freshness check, so a signature cannot be replayed with a
//     fresher timestamp.
//
// Only `node:crypto` is used (ADR-0001: no home-made cryptographic primitives,
// and no new dependency for a hash we already have).
import { createHmac, timingSafeEqual } from "node:crypto";

/** Environment variable holding the shared callback secret. */
export const PAY_SIGN_KEY_ENV = "HAHART_PAY_SIGN_KEY";

/** Default freshness window for the timestamp header, in seconds. */
export const DEFAULT_CALLBACK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * Why a callback was rejected. Each value is a separate decision, not a
 * message: `missing_field` means the platform did not send something,
 * `bad_timestamp` means what it sent is not a unix-seconds number,
 * `expired_timestamp` means it is too old (or too far in the future) to trust,
 * and `bad_signature` means the bytes do not match the secret.
 */
export type CallbackSignatureFailureReason =
  | "missing_field"
  | "bad_timestamp"
  | "expired_timestamp"
  | "bad_signature";

export type VerifyCallbackSignatureResult =
  | { ok: true }
  | { ok: false; reason: CallbackSignatureFailureReason };

export type VerifyCallbackSignatureInput = {
  /** Raw request body, exactly as received (not re-serialised JSON). */
  body?: string | undefined;
  /** Signature header, hex-encoded HMAC-SHA256 of the canonical string. */
  signature?: string | undefined;
  /** Timestamp header, unix seconds. The ASCII string, not a Date. */
  timestamp?: string | undefined;
  /** Shared secret, normally from {@link paySignKeyFromEnv}. */
  secret?: string | undefined;
  /** Allowed distance from now, in seconds. Defaults to 300. */
  toleranceSeconds?: number | undefined;
  /** Current time in unix seconds. Defaults to the wall clock. */
  nowSeconds?: number | undefined;
};

function computeHexSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${body}`, "utf8")
    .digest("hex");
}

/**
 * Read the shared secret from the environment.
 *
 * An unset variable and a whitespace-only one both mean "not configured", so
 * the caller can treat this as a single `undefined` case instead of checking
 * for two. The value itself is never logged or echoed anywhere.
 */
export function paySignKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[PAY_SIGN_KEY_ENV];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Verify one callback delivery.
 *
 * Pure: no clock of its own (the current time is an input, defaulted for
 * callers that do not care), no I/O, no logging, and **never throws** — a
 * verification function that throws is a verification function whose failure
 * mode is a 500 instead of a 401.
 */
export function verifyCallbackSignature(
  input: VerifyCallbackSignatureInput,
): VerifyCallbackSignatureResult {
  const body = input.body;
  const signature = input.signature;
  const timestamp = input.timestamp;
  const secret = input.secret;

  // Presence is judged on the trimmed value, but the HMAC below uses the
  // untrimmed body: leading/trailing bytes are part of what was signed.
  if (
    body === undefined ||
    body.trim() === "" ||
    signature === undefined ||
    signature.trim() === "" ||
    timestamp === undefined ||
    timestamp.trim() === "" ||
    secret === undefined ||
    secret.trim() === ""
  ) {
    return { ok: false, reason: "missing_field" };
  }

  const timestampValue = timestamp.trim();
  if (!/^\d{1,15}$/.test(timestampValue)) {
    return { ok: false, reason: "bad_timestamp" };
  }
  const timestampSeconds = Number(timestampValue);

  const tolerance =
    input.toleranceSeconds !== undefined &&
    Number.isFinite(input.toleranceSeconds) &&
    input.toleranceSeconds >= 0
      ? input.toleranceSeconds
      : DEFAULT_CALLBACK_TIMESTAMP_TOLERANCE_SECONDS;
  const now =
    input.nowSeconds !== undefined && Number.isFinite(input.nowSeconds)
      ? input.nowSeconds
      : Math.floor(Date.now() / 1000);

  // Symmetric on purpose: a timestamp far in the future is as untrustworthy as
  // an old one, and a clock-skewed platform is a bug worth surfacing.
  if (Math.abs(now - timestampSeconds) > tolerance) {
    return { ok: false, reason: "expired_timestamp" };
  }

  try {
    const expected = Buffer.from(
      computeHexSignature(secret, timestampValue, body),
      "utf8",
    );
    const received = Buffer.from(signature.trim().toLowerCase(), "utf8");
    // `timingSafeEqual` throws when the byte lengths differ, so the length is
    // checked first. The length of a signature is not a secret.
    if (
      received.byteLength !== expected.byteLength ||
      !timingSafeEqual(received, expected)
    ) {
      return { ok: false, reason: "bad_signature" };
    }
  } catch {
    // Unreachable with the guard above, but "reject" is the right answer if a
    // future runtime throws here — never a 500.
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true };
}
