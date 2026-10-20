import {
  applicationErrorResponseSchema,
  teamMemberAddRequestSchema,
  teamMemberAddResponseSchema,
  teamMemberListResponseSchema,
  teamMemberRemoveResponseSchema,
  teamMemberRoleRequestSchema,
  teamMemberRoleResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  TeamAdminError,
  type TeamAdminService,
} from "../features/team/team-admin.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

const FORBIDDEN_MESSAGE = "Only team admins can manage team members.";
const UNAVAILABLE_MESSAGE = "Unable to verify team membership.";

/** Member ids are auth user ids (uuid). Anything else is a malformed path (T-06). */
const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendInvalidUserId(reply: FastifyReply) {
  return reply.code(400).send(
    applicationErrorResponseSchema.parse({
      error: { code: "invalid_request", message: "userId must be a uuid." },
    }),
  );
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof TeamAdminError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }

  return reply.code(503).send(
    applicationErrorResponseSchema.parse({
      error: { code: "application_error", message: UNAVAILABLE_MESSAGE },
    }),
  );
}

/**
 * AD-08 §3 member administration.
 *
 * This is the "server refuses too" half of 「前端与服务端各拒一次」 — the gate
 * (workorder 4) only proves the caller is *a* member; these routes additionally
 * require admin/owner, and the database function checks the actor a third time.
 */
export async function registerAdminTeamRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    teamAdminService: TeamAdminService;
    teamMembership: TeamMembershipService;
  },
) {
  async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedUser | null> {
    const user = await options.auth.authenticate(request);

    if (!user) {
      reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
      return null;
    }

    let membership;
    try {
      membership = await options.teamMembership.get(user.id);
    } catch {
      reply.code(503).send(
        applicationErrorResponseSchema.parse({
          error: { code: "application_error", message: UNAVAILABLE_MESSAGE },
        }),
      );
      return null;
    }

    if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
      reply.code(403).send(
        applicationErrorResponseSchema.parse({
          error: { code: "forbidden", message: FORBIDDEN_MESSAGE },
        }),
      );
      return null;
    }

    return user;
  }

  app.get("/api/admin/team/members", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return reply;

    try {
      const members = await options.teamAdminService.listMembers(user.id);
      return reply
        .code(200)
        .send(teamMemberListResponseSchema.parse({ members }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/admin/team/members", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return reply;

    const parsed = teamMemberAddRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "email and role (member | admin) are required.",
          },
        }),
      );
    }

    try {
      const result = await options.teamAdminService.addMember(user.id, parsed.data);
      return reply
        .code(result.added ? 201 : 200)
        .send(teamMemberAddResponseSchema.parse(result));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { userId: string } }>(
    "/api/admin/team/members/:userId",
    async (request, reply) => {
      const user = await requireAdmin(request, reply);
      if (!user) return reply;

      if (!USER_ID_PATTERN.test(request.params.userId)) {
        return sendInvalidUserId(reply);
      }

      const parsed = teamMemberRoleRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "invalid_request",
              message: "role (member | admin) is required.",
            },
          }),
        );
      }

      try {
        const result = await options.teamAdminService.setRole(
          user.id,
          request.params.userId,
          parsed.data.role,
        );
        return reply
          .code(200)
          .send(teamMemberRoleResponseSchema.parse(result));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.delete<{ Params: { userId: string } }>(
    "/api/admin/team/members/:userId",
    async (request, reply) => {
      const user = await requireAdmin(request, reply);
      if (!user) return reply;

      if (!USER_ID_PATTERN.test(request.params.userId)) {
        return sendInvalidUserId(reply);
      }

      try {
        const result = await options.teamAdminService.removeMember(
          user.id,
          request.params.userId,
        );
        return reply
          .code(200)
          .send(teamMemberRemoveResponseSchema.parse(result));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}
