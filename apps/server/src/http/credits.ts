// @credits-system — Credit API routes: balance, transactions, daily claim, admin plan override
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  creditTransactionsResponseSchema,
  claimDailyResponseSchema,
  setPlanRequestSchema,
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
  ledgerEntryTypeOf,
} from "@loomic/shared";

import { toCreditBalanceResponse } from "../features/credits/balance-response.js";
import {
  CreditServiceError,
  type CreditService,
} from "../features/credits/credit-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { sendValidationError } from "./validation-error.js";

export async function registerCreditRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService: CreditService;
    viewerService: ViewerService;
  },
) {
  // GET /api/credits — balance info
  app.get("/api/credits", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const viewer = await options.viewerService.ensureViewer(user);
      const balance = await options.creditService.getBalance(
        viewer.workspace.id,
      );

      // Workorder 31D ruling 7: the payload is assembled by the one helper the
      // quote route also uses, so "余额与 GET /api/credits 同结构" cannot drift.
      return reply.code(200).send(toCreditBalanceResponse(balance));
    } catch (error) {
      return sendCreditError(error, reply, "credit_query_failed");
    }
  });

  // GET /api/credits/transactions — recent transactions
  app.get("/api/credits/transactions", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const viewer = await options.viewerService.ensureViewer(user);
      const query = request.query as { limit?: string };
      const limit = query.limit ? Math.min(parseInt(query.limit, 10), 100) : 20;

      const transactions = await options.creditService.getTransactions(
        viewer.workspace.id,
        limit,
      );

      return reply.code(200).send(
        creditTransactionsResponseSchema.parse({
          transactions: transactions.map((t) => ({
            ...t,
            entry_type: ledgerEntryTypeOf(t.transaction_type, t.amount),
          })),
        }),
      );
    } catch (error) {
      return sendCreditError(error, reply, "credit_query_failed");
    }
  });

  // POST /api/credits/claim-daily — claim daily free credits
  app.post("/api/credits/claim-daily", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const viewer = await options.viewerService.ensureViewer(user);
      const result = await options.creditService.claimDailyCredits(
        viewer.workspace.id,
      );

      if (!result.success) {
        return reply.code(200).send(
          claimDailyResponseSchema.parse({
            success: false,
            message: "Daily credits already claimed or not available for your plan.",
          }),
        );
      }

      return reply.code(200).send(
        claimDailyResponseSchema.parse({
          success: true,
          balance: result.balance,
        }),
      );
    } catch (error) {
      return sendCreditError(error, reply, "credit_claim_failed");
    }
  });

  // POST /api/credits/admin/set-plan — dev-only plan change
  app.post("/api/credits/admin/set-plan", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const body = setPlanRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);

      await options.creditService.updatePlan(viewer.workspace.id, body.plan);

      // Return refreshed balance info — same helper as GET /api/credits and the
      // quote route (workorder 31D ruling 7).
      const balance = await options.creditService.getBalance(
        viewer.workspace.id,
      );

      return reply.code(200).send(toCreditBalanceResponse(balance));
    } catch (error) {
      if (isZodError(error)) {
        return sendValidationError(reply, error.issues);
      }
      return sendCreditError(error, reply, "credit_plan_update_failed");
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────

function sendUnauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

type CreditErrorFallbackCode =
  | "credit_query_failed"
  | "credit_claim_failed"
  | "credit_deduct_failed"
  | "credit_refund_failed"
  | "credit_plan_update_failed";

function sendCreditError(
  error: unknown,
  reply: FastifyReply,
  fallbackCode: CreditErrorFallbackCode,
) {
  if (error instanceof CreditServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: fallbackCode,
        message: "An unexpected error occurred.",
      },
    }),
  );
}

function isZodError(
  error: unknown,
): error is { issues: unknown[]; name: string } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}
