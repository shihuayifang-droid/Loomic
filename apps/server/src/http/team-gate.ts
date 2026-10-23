import { applicationErrorResponseSchema } from "@loomic/shared";
import type { FastifyInstance } from "fastify";

import type { TeamMembershipService } from "../features/team/team-membership.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const NOT_TEAM_MEMBER_MESSAGE = "Not a member of the HaHart team workspace.";
const MEMBERSHIP_UNAVAILABLE_MESSAGE = "Unable to verify team membership.";

/**
 * Paths a non-member may still reach, matched on the pathname with the query
 * string removed and compared **exactly** — never by prefix, because treating
 * `/api/viewer` as a prefix would also open `/api/viewer/profile`.
 */
const EXEMPT_PATHS = new Set([
  "/api/viewer",
  "/api/health",
  "/api/fonts",
  "/api/models",
  "/api/dev/client-errors",
  "/api/payments/webhook",
  "/api/ws",
  // Workorder 42D: self-hosted authentication, reached before there is a token.
  "/api/auth/sign-up",
  "/api/auth/sign-in",
  "/api/auth/refresh",
  "/api/auth/sign-out",
]);

/**
 * AD-08 / PJ-11 member gate.
 *
 * Runs before every `/api/` route. A caller with no (or an invalid) token is
 * deliberately let through so the route can answer 401; only a *valid* token
 * that is not in the team workspace is rejected with 403.
 *
 * A membership lookup failure is **not** allowed to pass: it answers 503.
 * Fail-open here would mean a Supabase blip lets any authenticated user reach
 * every business endpoint, and fail-as-403 would masquerade as a permissions
 * problem.
 */
export function registerTeamGate(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    teamMembership: TeamMembershipService;
  },
): void {
  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0] ?? request.url;

    if (!pathname.startsWith("/api/")) {
      return;
    }

    if (EXEMPT_PATHS.has(pathname)) {
      return;
    }

    const user = await options.auth.authenticate(request);

    if (!user) {
      // Unauthenticated: leave the 401 to the route that owns the contract.
      return;
    }

    let membership;
    try {
      membership = await options.teamMembership.get(user.id);
    } catch {
      return reply.code(503).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "application_error",
            message: MEMBERSHIP_UNAVAILABLE_MESSAGE,
          },
        }),
      );
    }

    if (membership === null) {
      return reply.code(403).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "not_team_member",
            message: NOT_TEAM_MEMBER_MESSAGE,
          },
        }),
      );
    }

    return;
  });
}
