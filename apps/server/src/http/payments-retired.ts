import type { FastifyInstance } from "fastify";

/**
 * BL-40 / D-27: the Lemon Squeezy subscription payment link is retired. The
 * routes below stay registered — a client that still calls them (the web
 * upgrade entry, an already-delivered webhook) must get an explicit, stable
 * answer instead of a bare 404, and `payment_events` history stays read-only.
 *
 * The webhook path is additionally exempt in the team gate, so an unauthenticated
 * delivery from the payment provider reaches this 410 rather than a 401.
 */
export const RETIRED_PAYMENT_PATHS = [
  ["POST", "/api/payments/webhook"],
  ["POST", "/api/payments/checkout"],
  ["GET", "/api/payments/subscription"],
  ["POST", "/api/payments/cancel"],
  ["POST", "/api/payments/change-plan"],
] as const;

/**
 * Sent as a plain object: `feature_retired` is deliberately not part of the
 * shared application error-code enum, so this response does not go through
 * `applicationErrorResponseSchema.parse`.
 */
const RETIRED_PAYMENT_RESPONSE = {
  error: {
    code: "feature_retired",
    message: "Subscription payments have been retired (BL-40).",
  },
};

/**
 * Registers every retired payment route. Neither the request headers, the
 * viewer nor the body are read: the answer is the same 410 for everyone.
 * Takes nothing but the app, which is what makes "no credit grant can happen
 * here" checkable rather than asserted in prose.
 */
export async function registerRetiredPaymentRoutes(
  app: FastifyInstance,
): Promise<void> {
  for (const [method, url] of RETIRED_PAYMENT_PATHS) {
    app.route({
      method,
      url,
      handler: async (_request, reply) =>
        reply.code(410).send(RETIRED_PAYMENT_RESPONSE),
    });
  }
}
