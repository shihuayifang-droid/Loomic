import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import {
  RETIRED_PAYMENT_PATHS,
  registerRetiredPaymentRoutes,
} from "./payments-retired.js";

/** Nobody is authenticated: the team gate lets an anonymous caller reach the route. */
const auth: RequestAuthenticator = {
  async authenticate() {
    return null;
  },
};

/** The Lemon Squeezy configuration that used to switch the payment link on. */
const LEMON_SQUEEZY_ENV = {
  lemonSqueezyApiKey: "ls-test-api-key",
  lemonSqueezyStoreId: "ls-test-store-id",
  lemonSqueezyWebhookSecret: "ls-test-webhook-secret",
};

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("retired subscription payment routes (BL-40)", () => {
  it("BL-40: the payment webhook answers 410 even with Lemon Squeezy configured", async () => {
    app = await buildApp({ auth, env: LEMON_SQUEEZY_ENV });

    const response = await app.inject({
      method: "POST",
      url: "/api/payments/webhook",
      headers: { "content-type": "application/json" },
      payload: { meta: { event_name: "subscription_payment_success" } },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe("feature_retired");
  });

  it("BL-40: every retired payment route answers 410", async () => {
    app = await buildApp({ auth, env: LEMON_SQUEEZY_ENV });

    for (const [method, url] of RETIRED_PAYMENT_PATHS) {
      const response = await app.inject(
        method === "POST"
          ? {
              method,
              url,
              headers: { "content-type": "application/json" },
              payload: {},
            }
          : { method, url },
      );

      expect(response.statusCode, `${method} ${url}`).toBe(410);
      expect(response.json().error.code, `${method} ${url}`).toBe(
        "feature_retired",
      );
    }
  });

  it("BL-40: no credit grant happens", async () => {
    // A double that records every credit write it is asked to perform. The
    // retired routes are handed nothing but the app, so a webhook delivery
    // cannot reach it — and this double proves nothing else wired it up.
    const creditCalls: string[] = [];
    const creditService = new Proxy(
      {},
      {
        get(_target, property) {
          return (..._args: unknown[]) => {
            creditCalls.push(String(property));
            throw new Error(`retired payment link reached credit ${String(property)}`);
          };
        },
      },
    ) as unknown as CreditService;

    app = await buildApp({
      auth,
      creditService,
      env: LEMON_SQUEEZY_ENV,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/payments/webhook",
      headers: { "content-type": "application/json" },
      payload: { meta: { event_name: "subscription_payment_success" } },
    });

    expect(response.statusCode).toBe(410);
    expect(creditCalls).toEqual([]);
    // The registration takes the app and nothing else: there is no credit
    // service, no Lemon Squeezy client and no admin client for it to reach.
    expect(registerRetiredPaymentRoutes.length).toBe(1);
  });
});
