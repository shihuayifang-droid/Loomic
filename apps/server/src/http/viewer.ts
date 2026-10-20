// @credits-system — Viewer endpoint: auto-claims daily credits, returns balance and plan info
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  PLAN_CONFIGS,
  applicationErrorResponseSchema,
  profileUpdateRequestSchema,
  profileUpdateResponseSchema,
  unauthenticatedErrorResponseSchema,
  viewerResponseSchema,
  type SubscriptionPlan,
} from "@loomic/shared";

import {
  BootstrapError,
  type ViewerService,
} from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type {
  ProfileWriteRepository,
  ProfileWriteRow,
} from "../db/profile-write-repository.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { sendValidationError } from "./validation-error.js";

export async function registerViewerRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService?: CreditService;
    /**
     * ADR-0001 / workorder 21D: the only writer of `profiles.display_name`.
     *
     * Optional so a caller CAN build the app without one; there is deliberately
     * no fallback behind it. A missing repository is handled exactly like a
     * failing one — the route answers the same 500 and writes nothing.
     *
     * There is no user-scoped Supabase factory in this signature any more (the
     * parameter was removed by workorder 21D). That is the structural half of
     * "the profile write never goes back to PostgREST": the route cannot reach
     * a PostgREST client even by mistake.
     */
    profileWriteRepository?: ProfileWriteRepository;
    viewerService: ViewerService;
  },
) {
  app.get("/api/viewer", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);

      if (!user) {
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "Missing or invalid bearer token.",
            },
          }),
        );
      }

      const viewer = await options.viewerService.ensureViewer(user);

      // @credits-system: Auto-claim daily credits on login + attach credits info
      let credits: Record<string, unknown> | undefined;
      if (options.creditService) {
        try {
          // Auto-claim daily credits for free users on each viewer request
          // (idempotent — claim_daily_credits is a no-op if already claimed today)
          const balance = await options.creditService.getBalance(
            viewer.workspace.id,
          );
          if (balance.plan === "free" && !balance.dailyClaimed) {
            await options.creditService.claimDailyCredits(viewer.workspace.id);
          }

          // Re-fetch balance after potential claim
          const updatedBalance = await options.creditService.getBalance(
            viewer.workspace.id,
          );
          const config = PLAN_CONFIGS[updatedBalance.plan as SubscriptionPlan];
          credits = {
            balance: updatedBalance.balance,
            plan: updatedBalance.plan,
            dailyClaimed: updatedBalance.dailyClaimed,
            limits: {
              maxConcurrentJobs: config.maxConcurrentJobs,
              maxResolution: config.maxResolution,
              monthlyCredits: config.monthlyCredits,
              dailyCredits: config.dailyCredits,
            },
          };
        } catch {
          // Credits fetch failure is non-fatal — viewer still works
        }
      }

      return reply
        .code(200)
        .send(viewerResponseSchema.parse({ ...viewer, credits }));
    } catch (error) {
      return sendApplicationError(
        error,
        reply,
        "bootstrap_failed",
        "Unable to prepare viewer workspace.",
      );
    }
  });

  app.patch("/api/viewer/profile", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);

      if (!user) {
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "Missing or invalid bearer token.",
            },
          }),
        );
      }

      const payload = profileUpdateRequestSchema.parse(request.body);

      // ADR-0001 / workorder 21D: the display-name write moved from the
      // user-scoped PostgREST client to the pure `pg` repository. What did NOT
      // move is the projection: authentication first, the request schema second,
      // and every failure of the write — zero rows, a broken row shape, a SQL or
      // connection error, or no repository at all — is the SAME fixed 500 the
      // PostgREST path answered when it returned no data. No 404/403, and no
      // SQL, host or "does this profile exist" information reaches the client.
      const repository = options.profileWriteRepository;
      if (!repository) {
        return reply.code(500).send(profileUpdateFailed());
      }

      let profile: ProfileWriteRow;
      try {
        profile = await repository.updateDisplayName({
          actorId: user.id,
          displayName: payload.displayName,
        });
      } catch {
        return reply.code(500).send(profileUpdateFailed());
      }

      return reply.code(200).send(
        profileUpdateResponseSchema.parse({
          profile: {
            id: profile.id,
            // The row's email is nullable (historic data), so project the
            // authenticated identity's email instead of "" — an empty string
            // fails the response schema and 400s a committed write (T-37).
            email: profile.email ?? user.email,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl ?? null,
          },
        }),
      );
    } catch (error) {
      if (isZodError(error)) {
        return sendValidationError(reply, error.issues);
      }

      return sendApplicationError(
        error,
        reply,
        "application_error",
        "Internal server error.",
      );
    }
  });
}

/**
 * The one failure body the profile PATCH can answer. It is a function rather
 * than a constant so every caller gets its own parsed object, and it is the ONLY
 * place the code and wording live: the zero-row refusal, a repository that threw
 * and a repository that was never injected must be indistinguishable from the
 * outside.
 */
function profileUpdateFailed() {
  return applicationErrorResponseSchema.parse({
    error: {
      code: "profile_update_failed",
      message: "Unable to update profile.",
    },
  });
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

function sendApplicationError(
  error: unknown,
  reply: FastifyReply,
  fallbackCode: "application_error" | "bootstrap_failed",
  fallbackMessage: string,
) {
  if (error instanceof BootstrapError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: error.code,
          message: error.message,
        },
      }),
    );
  }

  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: fallbackCode,
        message: fallbackMessage,
      },
    }),
  );
}
