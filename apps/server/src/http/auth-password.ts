// HAHART password administration (ticket 42E / ADR-0001).
//
//   POST /api/admin/auth/reset-password  admin/owner mints a one-time temporary
//                                        password for a member (no mail service
//                                        in phase one)
//   POST /api/auth/change-password       the signed-in user replaces their own
//                                        password with the temporary one
//
// Both writes go through `setPassword` (42B): the hash is replaced and, in the
// same transaction, `token_version` moves forward and every live session is
// revoked. Nothing in here ever logs or returns a password hash or a token; the
// temporary password is handed back exactly once, in the reset response.
//
// Only registered when HAHART_AUTH_PROVIDER=self (see app.ts).
import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { hashPassword, validatePasswordPolicy, verifyPassword } from "../auth/password.js";
import {
  findUserByEmail,
  findUserById,
  setPassword,
  type AuthUser,
} from "../db/auth-repository.js";
import type { TransactionPool } from "../db/transaction.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

/** Same wording as the admin member-administration routes (AD-08 §3). */
const FORBIDDEN_MESSAGE = "Only team admins can manage team members.";
const UNAVAILABLE_MESSAGE = "Unable to verify team membership.";
const UNAUTHORIZED_MESSAGE = "Missing or invalid bearer token.";
const INVALID_CREDENTIALS_MESSAGE = "Incorrect email or password.";
const INVALID_REQUEST_MESSAGE = "Request body is invalid.";
const WEAK_PASSWORD_MESSAGE = "Password must be between 8 and 128 characters.";
const SAME_PASSWORD_MESSAGE = "新密码不能与当前密码相同";
const NO_SUCH_ACCOUNT_MESSAGE = "该邮箱没有账号";

/** Caps the input fed to argon2 so a huge body cannot be used to burn CPU. */
const PASSWORD_INPUT_MAX = 1024;

type PasswordErrorCode =
  | "invalid_request"
  | "weak_password"
  | "invalid_credentials"
  | "forbidden";

const resetPasswordBodySchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(254).email(),
});

const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_INPUT_MAX),
  newPassword: z.string().min(1).max(PASSWORD_INPUT_MAX),
});

/**
 * 12 random bytes encode to exactly 16 base64url characters (no padding), which
 * satisfies the 42A policy of 8..128 code points without any retry loop.
 */
export function generateTemporaryPassword(): string {
  return randomBytes(12).toString("base64url");
}

export type AuthPasswordRoutesOptions = {
  auth: RequestAuthenticator;
  teamMembership: Pick<TeamMembershipService, "get">;
  pool: () => TransactionPool;
  /** Overridable for deterministic tests; defaults to `generateTemporaryPassword`. */
  generateTemporaryPassword?: () => string;
};

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: PasswordErrorCode,
  message: string,
) {
  return reply.code(statusCode).send(
    applicationErrorResponseSchema.parse({ error: { code, message } }),
  );
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: { code: "unauthorized", message: UNAUTHORIZED_MESSAGE },
    }),
  );
}

export async function registerAuthPasswordRoutes(
  app: FastifyInstance,
  options: AuthPasswordRoutesOptions,
): Promise<void> {
  const makeTemporaryPassword =
    options.generateTemporaryPassword ?? generateTemporaryPassword;

  async function requireUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedUser | null> {
    const user = await options.auth.authenticate(request);

    if (!user) {
      reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: { code: "unauthorized", message: UNAUTHORIZED_MESSAGE },
        }),
      );
      return null;
    }

    return user;
  }

  async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedUser | null> {
    const user = await requireUser(request, reply);
    if (!user) return null;

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

  app.post("/api/admin/auth/reset-password", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return reply;

    const parsed = resetPasswordBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", INVALID_REQUEST_MESSAGE);
    }

    const pool = options.pool();
    const target = await findUserByEmail(pool, parsed.data.email);
    if (!target) {
      return sendError(reply, 404, "invalid_request", NO_SUCH_ACCOUNT_MESSAGE);
    }

    const temporaryPassword = makeTemporaryPassword();
    await setPassword(pool, target.id, await hashPassword(temporaryPassword), {
      mustChange: true,
    });

    // Structured, and deliberately free of the password itself.
    request.log.info(
      { adminId: admin.id, targetUserId: target.id },
      "auth.password_reset",
    );

    return reply.code(200).send({ email: target.email, temporaryPassword });
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;

    const parsed = changePasswordBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", INVALID_REQUEST_MESSAGE);
    }
    const { currentPassword, newPassword } = parsed.data;

    const pool = options.pool();
    const stored: AuthUser | null = await findUserById(pool, user.id);
    if (!stored || stored.passwordHash === null) {
      return sendUnauthorized(reply);
    }

    if (!(await verifyPassword(stored.passwordHash, currentPassword))) {
      return sendError(reply, 401, "invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
    }

    if (!validatePasswordPolicy(newPassword).ok) {
      return sendError(reply, 400, "weak_password", WEAK_PASSWORD_MESSAGE);
    }

    if (newPassword === currentPassword) {
      return sendError(reply, 400, "weak_password", SAME_PASSWORD_MESSAGE);
    }

    // Also revokes every session, including the one behind this request.
    await setPassword(pool, user.id, await hashPassword(newPassword), {
      mustChange: false,
    });

    return reply.code(204).send();
  });
}
