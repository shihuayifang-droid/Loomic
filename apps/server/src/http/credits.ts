// @credits-system — Credit API routes: balance, transactions, daily claim, admin plan override
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  creditTransactionsResponseSchema,
  claimDailyResponseSchema,
  setPlanRequestSchema,
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
  ledgerEntryTypeOf,
  type CreditTransaction,
} from "@loomic/shared";

import { toCreditBalanceResponse } from "../features/credits/balance-response.js";
import {
  CreditServiceError,
  type CreditService,
} from "../features/credits/credit-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { PoolBalanceReadRepository } from "../db/pool-balance-read-repository.js";
import type { PoolGrantWriteRepository } from "../db/pool-grant-write-repository.js";
import type { PoolTransactionReadRepository } from "../db/pool-transaction-read-repository.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { sendValidationError } from "./validation-error.js";

export async function registerCreditRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService: CreditService;
    viewerService: ViewerService;
    // BL-45 / workorder 37Q: optional on purpose. Without it the balance is
    // exactly the payload it was before the pools existed; with it the three
    // pools ride along for a caller that has a team workspace.
    poolBalanceReadRepository?: PoolBalanceReadRepository;
    // BL-45 / workorder 37R: optional on purpose, and narrowed to the ONE method
    // this route needs. Without it a balance read grants nothing, exactly as
    // before 37R; with it the read places today's daily grant first.
    poolGrantWriteRepository?: Pick<
      PoolGrantWriteRepository,
      "grantDailyCredits"
    >;
    // BL-06 / workorder 38U: optional on purpose. Without it
    // `GET /api/credits/transactions` lists the caller's personal ledger exactly
    // as it did before the pools existed; with it, and only for a caller that has
    // a team workspace, the list is the member's lines out of THAT workspace —
    // which is where 37N / 37S write every pool charge and refund.
    poolTransactionReadRepository?: PoolTransactionReadRepository;
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

      // BL-45 / workorder 37R: today's daily grant is placed BEFORE the pools are
      // read, so the balance a member sees is the one that already includes it —
      // and `grant_daily_credits` (37O) is idempotent per day, so reading the
      // balance five times grants once. Only a member of a team workspace is
      // granted (33K: not admitted, nothing granted), which is the same
      // condition the pool read below uses. A failed grant is LOGGED AND
      // SKIPPED rather than rethrown: a balance without today's free credits is
      // still a balance, and the pool read below keeps its own fail-closed
      // behaviour (a missing pool is a 500, a missing grant is not).
      const poolGrantWriteRepository = options.poolGrantWriteRepository;
      if (poolGrantWriteRepository !== undefined && viewer.teamWorkspace) {
        try {
          await poolGrantWriteRepository.grantDailyCredits({
            userId: user.id,
            workspaceId: viewer.teamWorkspace.id,
          });
        } catch (error) {
          request.log.warn(
            { err: error },
            "daily credit grant failed; answering the balance without it",
          );
        }
      }

      // BL-45 / workorder 37Q: the three pools are bookkept per TEAM workspace
      // (37M / 37N), so a caller with no team workspace reads as `null` rather
      // than as a misleading all-zero pool. A failed read is not swallowed: it
      // falls into the catch below and answers the existing
      // `credit_query_failed` 500, because a balance with half its pools is
      // worse than no balance at all.
      const poolBalanceReadRepository = options.poolBalanceReadRepository;
      const pools =
        poolBalanceReadRepository === undefined
          ? undefined
          : viewer.teamWorkspace
            ? await poolBalanceReadRepository.readPoolBalances({
                workspaceId: viewer.teamWorkspace.id,
                userId: user.id,
              })
            : null;

      // Workorder 31D ruling 7: the payload is assembled by the one helper the
      // quote route also uses, so "余额与 GET /api/credits 同结构" cannot drift.
      return reply
        .code(200)
        .send(toCreditBalanceResponse(balance, pools));
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

      // BL-06 / workorder 38U: the pool charges and refunds of 37N / 37S are
      // bookkept per TEAM workspace, so with the switch on a member reading his
      // personal workspace saw neither. The list therefore comes from the team
      // workspace, for THIS member: `user.id` is the authenticated user, not a
      // value from the request.
      //
      // Three conditions, all required, otherwise the pre-38U read is used
      // untouched: the repository is injected (workorder 38I wires it only while
      // `LOOMIC_CREDIT_POOLS=on`) AND the caller has a team workspace. A caller
      // with no team workspace has no pool lines to see, so the old ledger is the
      // correct answer rather than an empty pool list.
      //
      // A failed read is NOT swallowed: it falls into the catch below and answers
      // the existing `credit_query_failed` 500, the same way `getTransactions`
      // does, because a list with half its lines missing is worse than no list.
      const poolTransactionReadRepository = options.poolTransactionReadRepository;
      const transactions: CreditTransaction[] =
        poolTransactionReadRepository !== undefined && viewer.teamWorkspace
          ? await poolTransactionReadRepository.listMemberPoolTransactions({
              workspaceId: viewer.teamWorkspace.id,
              userId: user.id,
              limit,
            })
          : await options.creditService.getTransactions(
              viewer.workspace.id,
              limit,
            );

      return reply.code(200).send(
        creditTransactionsResponseSchema.parse({
          transactions: transactions.map((t) => ({
            ...t,
            // BL-41 / workorder 39M: the description is what splits a cancel
            // refund from a failed one — the stored type is the same for both.
            entry_type: ledgerEntryTypeOf(
              t.transaction_type,
              t.amount,
              t.description,
            ),
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
