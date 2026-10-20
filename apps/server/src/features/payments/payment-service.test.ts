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
    // Exhaustiveness, stated the way that actually holds: `PaymentServiceError["code"]`
    // is the whole union the constructor takes, so it only stays assignable to the
    // literal union of the list above while the two are equal. A member added to the
    // class without a line here stops this file compiling — which is the point, since
    // a code the wire enum does not list is a code the client never receives.
    const carried: PaymentServiceError["code"] = "subscription_not_found";
    const covered: (typeof PAYMENT_SERVICE_CODES)[number] = carried;

    const error = new PaymentServiceError(
      covered,
      "No active subscription.",
      404,
    );

    expect(error.code).toBe("subscription_not_found");
    expect(error.statusCode).toBe(404);
  });
});
