// Every code PaymentServiceError can carry must be one the wire schema accepts.
//
// applicationErrorResponseSchema.parse() runs INSIDE the route's error path
// (see http/payments.ts sendPaymentError). An unlisted code therefore makes the
// parse throw while already handling a failure, and the client receives Fastify's
// generic 500 instead of the intended reply — the real cause replaced by noise.
// That is what happened here: four of the six codes below were missing from
// applicationErrorCodeSchema while PaymentServiceError had been carrying them
// (T-49 / S-004), so e.g. the intended 404 for a missing subscription went out
// as a generic 500.
//
// Kept as a literal list rather than derived from the type, because a type cannot
// be enumerated at runtime — and a check that silently covers nothing is worse
// than no check. The exhaustiveness assertion below is what keeps the list equal
// to the union the constructor accepts.
import { applicationErrorCodeSchema } from "@loomic/shared";
import { describe, expect, it } from "vitest";

import { PaymentServiceError } from "./payment-service.js";

/**
 * Compares the two types themselves — no value assignment in between, so no
 * literal narrowing can hide a mismatch. The `[A] extends [B]` tuples keep the
 * conditional type from distributing over the members of a union.
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const PAYMENT_SERVICE_CODES = [
  "payment_not_configured",
  "variant_not_found",
  "checkout_failed",
  "subscription_not_found",
  "subscription_update_failed",
  "webhook_processing_failed",
] as const;

describe("PaymentServiceError wire contract", () => {
  it.each(PAYMENT_SERVICE_CODES)(
    "%s is accepted by applicationErrorCodeSchema",
    (code) => {
      expect(() => applicationErrorCodeSchema.parse(code)).not.toThrow();
    },
  );

  it("the list above still covers the constructor's accepted codes", () => {
    // `Equal` compares the two types themselves, without going through a value
    // assignment, so no literal narrowing can hide a mismatch: add or drop a
    // member on one side only and the `exhaustive` line below stops compiling
    // with TS2322. The check is that compilation, not the expect after it.
    const exhaustive: Equal<PaymentServiceError["code"], (typeof PAYMENT_SERVICE_CODES)[number]> = true;
    expect(exhaustive).toBe(true);

    const error = new PaymentServiceError(
      "subscription_not_found",
      "No active subscription.",
      404,
    );

    expect(error.code).toBe("subscription_not_found");
    expect(error.statusCode).toBe(404);
  });
});
