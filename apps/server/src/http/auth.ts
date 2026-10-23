// HAHART self-hosted authentication routes (ticket 42D / ADR-0001).
//
//   POST /api/auth/sign-up    register (active account; "pending approval" is
//                             expressed by team membership, not by user status)
//   POST /api/auth/sign-in    email + password -> access token + refresh token
//   POST /api/auth/refresh    rotate a refresh token (replay revokes the family)
//   POST /api/auth/sign-out   revoke the session behind a refresh token
//
// Only registered when HAHART_AUTH_PROVIDER=self (see app.ts). Refresh tokens
// travel in the JSON body for now; the client storage decision follows in 42F.
//
// Nothing in here ever logs or returns a password, a password hash or a token
// other than the freshly minted pair handed back to the caller.
import { applicationErrorResponseSchema } from "@loomic/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  clearLoginFailures,
  countRecentLoginFailures,
  createSession,
  createUser,
  findUserByEmail,
  findUserById,
  recordLoginFailure,
  revokeSession,
  rotateSession,
  setUserStatus,
  type AuthUser,
} from "../db/auth-repository.js";
import {
  type TransactionPool,
  withPrivilegedTransaction,
} from "../db/transaction.js";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "../auth/password.js";
import {
  type AccessTokenConfig,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "../auth/tokens.js";

const DEFAULT_REFRESH_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Login throttle: 5 failures per (ip, email) inside a 15 minute window. */
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** Caps the input fed to argon2 so a huge body cannot be used to burn CPU. */
const PASSWORD_INPUT_MAX = 1024;
const REFRESH_TOKEN_INPUT_MAX = 256;

const WEAK_PASSWORD_MESSAGE = "Password must be between 8 and 128 characters.";
const EMAIL_TAKEN_MESSAGE = "This email is already registered.";
const INVALID_CREDENTIALS_MESSAGE = "Incorrect email or password.";
const TOO_MANY_ATTEMPTS_MESSAGE =
  "Too many failed attempts. Try again in 15 minutes.";
const INVALID_REFRESH_MESSAGE = "Refresh token is invalid or expired.";
const ACCOUNT_DISABLED_MESSAGE = "This account is not active.";
const INVALID_REQUEST_MESSAGE = "Request body is invalid.";

const emailSchema = z.string().trim().toLowerCase().min(3).max(254).email();

const signUpBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_INPUT_MAX),
  displayName: z.string().trim().min(1).max(100).optional(),
});

const signInBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_INPUT_MAX),
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(1).max(REFRESH_TOKEN_INPUT_MAX),
});

type AuthErrorCode =
  | "invalid_request"
  | "weak_password"
  | "email_taken"
  | "invalid_credentials"
  | "too_many_attempts"
  | "invalid_refresh"
  | "account_disabled";

export type AuthRoutesOptions = {
  pool: () => TransactionPool;
  token: AccessTokenConfig;
  /** Default 30. */
  refreshTtlDays?: number;
  now?: () => Date;
};

type SessionResponse = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    mustChangePassword: boolean;
  };
};

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: AuthErrorCode,
  message: string,
) {
  return reply.code(statusCode).send(
    applicationErrorResponseSchema.parse({ error: { code, message } }),
  );
}

/**
 * A real argon2id hash of a throwaway string, computed once. Verifying against
 * it when the email is unknown makes "no such user" cost the same as "wrong
 * password", so response time does not reveal which emails are registered.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("hahart-timing-equaliser-not-a-credential");
  return dummyHashPromise;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const refreshTtlMs =
    (options.refreshTtlDays ?? DEFAULT_REFRESH_TTL_DAYS) * DAY_MS;

  async function issueSession(
    user: Pick<AuthUser, "id" | "email" | "displayName" | "tokenVersion" | "mustChangePassword">,
    reply: FastifyReply,
    statusCode: number,
    existing?: { sessionId: string; refreshToken: string; refreshExpiresAt: Date },
  ) {
    const at = now();
    let sessionId: string;
    let refreshToken: string;
    let refreshExpiresAt: Date;

    if (existing) {
      sessionId = existing.sessionId;
      refreshToken = existing.refreshToken;
      refreshExpiresAt = existing.refreshExpiresAt;
    } else {
      const refresh = generateRefreshToken();
      refreshExpiresAt = new Date(at.getTime() + refreshTtlMs);
      const created = await createSession(options.pool(), {
        userId: user.id,
        refreshHash: refresh.hash,
        expiresAt: refreshExpiresAt,
      });
      sessionId = created.id;
      refreshToken = refresh.token;
    }

    const accessToken = await signAccessToken(
      options.token,
      {
        sub: user.id,
        sid: sessionId,
        ver: user.tokenVersion,
        email: user.email,
      },
      at,
    );

    const body: SessionResponse = {
      accessToken,
      accessTokenExpiresAt: new Date(
        at.getTime() + options.token.ttlSeconds * 1000,
      ).toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        mustChangePassword: user.mustChangePassword,
      },
    };
    return reply.code(statusCode).send(body);
  }

  app.post("/api/auth/sign-up", async (request, reply) => {
    const parsed = signUpBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", INVALID_REQUEST_MESSAGE);
    }
    const { email, password, displayName } = parsed.data;

    if (!validatePasswordPolicy(password).ok) {
      return sendError(reply, 400, "weak_password", WEAK_PASSWORD_MESSAGE);
    }

    const pool = options.pool();
    const passwordHash = await hashPassword(password);
    const created = await createUser(pool, {
      email,
      displayName: displayName ?? null,
      passwordHash,
    });
    if ("conflict" in created) {
      return sendError(reply, 409, "email_taken", EMAIL_TAKEN_MESSAGE);
    }

    // The repository creates users as `pending`; registration here is open and
    // "waiting for approval" is expressed by not being in the team workspace.
    await setUserStatus(pool, created.id, "active");

    const user = await findUserById(pool, created.id);
    if (!user) {
      throw new Error("user vanished right after sign-up");
    }
    return issueSession(user, reply, 201);
  });

  app.post("/api/auth/sign-in", async (request, reply) => {
    const parsed = signInBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", INVALID_REQUEST_MESSAGE);
    }
    const { email, password } = parsed.data;

    const pool = options.pool();
    const key = `${request.ip}|${email}`;
    const at = now();

    // Throttle check comes BEFORE any password work.
    const recent = await countRecentLoginFailures(
      pool,
      key,
      new Date(at.getTime() - LOGIN_FAILURE_WINDOW_MS),
    );
    if (recent >= LOGIN_FAILURE_LIMIT) {
      return sendError(reply, 429, "too_many_attempts", TOO_MANY_ATTEMPTS_MESSAGE);
    }

    const user = await findUserByEmail(pool, email);
    const hash = user?.passwordHash ?? null;
    // Unknown user (or user without a credential) still pays for one verify.
    const passwordOk = await verifyPassword(hash ?? (await getDummyHash()), password);

    if (!user || hash === null || !passwordOk) {
      await recordLoginFailure(pool, key, at);
      return sendError(
        reply,
        401,
        "invalid_credentials",
        INVALID_CREDENTIALS_MESSAGE,
      );
    }

    if (user.status !== "active") {
      return sendError(reply, 403, "account_disabled", ACCOUNT_DISABLED_MESSAGE);
    }

    await clearLoginFailures(pool, key);
    return issueSession(user, reply, 200);
  });

  app.post("/api/auth/refresh", async (request, reply) => {
    const parsed = refreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", INVALID_REQUEST_MESSAGE);
    }

    const pool = options.pool();
    const at = now();
    const next = generateRefreshToken();
    const newExpiresAt = new Date(at.getTime() + refreshTtlMs);

    const rotated = await rotateSession(pool, {
      refreshHash: hashRefreshToken(parsed.data.refreshToken),
      newRefreshHash: next.hash,
      newExpiresAt,
      now: at,
    });

    // `reused` and `invalid` look identical to the client on purpose.
    if (rotated.status !== "rotated") {
      return sendError(reply, 401, "invalid_refresh", INVALID_REFRESH_MESSAGE);
    }

    const user = await findUserById(pool, rotated.session.userId);
    if (!user || user.status !== "active") {
      // Account vanished or was suspended: do not leave the new session usable.
      await revokeSession(pool, rotated.session.id);
      return sendError(reply, 401, "invalid_refresh", INVALID_REFRESH_MESSAGE);
    }

    return issueSession(user, reply, 200, {
      sessionId: rotated.session.id,
      refreshToken: next.token,
      refreshExpiresAt: newExpiresAt,
    });
  });

  app.post("/api/auth/sign-out", async (request, reply) => {
    const parsed = refreshBodySchema.safeParse(request.body);
    // Whatever the body, the answer is 204: sign-out never tells a caller
    // whether a token existed.
    if (parsed.success) {
      const pool = options.pool();
      const sessionId = await findSessionIdByRefreshHash(
        pool,
        hashRefreshToken(parsed.data.refreshToken),
      );
      if (sessionId) {
        await revokeSession(pool, sessionId);
      }
    }
    return reply.code(204).send();
  });
}

/**
 * 42B exposes no lookup by refresh hash (rotation does it internally), and
 * sign-out has to resolve a token to its session id, so the one read lives
 * here. Bind parameter only; the hash is the sha256 digest, never the token.
 */
async function findSessionIdByRefreshHash(
  pool: TransactionPool,
  refreshHash: string,
): Promise<string | null> {
  return withPrivilegedTransaction(pool, null, async (client) => {
    const result = await client.query(
      "select id from hahart_auth.sessions where refresh_hash = $1 limit 1",
      [refreshHash],
    );
    const row = result.rows[0] as { id?: unknown } | undefined;
    return typeof row?.id === "string" ? row.id : null;
  });
}
