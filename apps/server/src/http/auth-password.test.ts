/**
 * Route tests for the password-administration endpoints (ticket 42E).
 *
 * A bare PGlite gets only `apps/server/db/canonical/0001_auth.sql`; the real
 * repository SQL runs through `createPGliteTransactionPool`. Both 42D sign-in
 * routes and the 42E password routes are mounted on a minimal Fastify instance
 * so the end-to-end "reset -> temporary password -> change" flow is exercised
 * against the same authenticator the app builds.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createSelfRequestAuthenticator } from "../auth/self-authenticator.js";
import { DEFAULT_ACCESS_TTL_SECONDS, accessTokenSecretFrom } from "../auth/tokens.js";
import { findUserById, isSessionActive } from "../db/auth-repository.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import { createPGliteTransactionPool } from "../test-support/db/pglite-db.js";
import { registerAuthRoutes } from "./auth.js";
import { registerAuthPasswordRoutes } from "./auth-password.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_SQL_FILE = join(HERE, "..", "..", "db", "canonical", "0001_auth.sql");

const TOKEN_CONFIG = {
  secret: accessTokenSecretFrom("test-secret-test-secret-test-secret-0123456789"),
  issuer: "hahart",
  audience: "hahart-api",
  ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
};

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const OWNER_ID = "00000000-0000-0000-0000-000000000001";

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a whole new battery";

type Role = "owner" | "admin" | "member";

const roles = new Map<string, Role>();
const logLines: string[] = [];

let db: PGlite;
let pool: ReturnType<typeof createPGliteTransactionPool>;
let app: FastifyInstance;
let authenticator: ReturnType<typeof createSelfRequestAuthenticator>;
let counter = 0;

const teamMembership: Pick<TeamMembershipService, "get"> = {
  async get(userId) {
    const role = roles.get(userId);
    if (!role) return null;
    return {
      workspace: { id: TEAM_ID, name: "HaHart 团队", type: "team", ownerUserId: OWNER_ID },
      role,
    };
  },
};

function uniqueEmail(): string {
  counter += 1;
  return `Person${counter}@Example.Test`;
}

async function post(url: string, payload: unknown, token?: string) {
  return app.inject({
    method: "POST",
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: payload as object,
  });
}

async function signUp(email: string, password = PASSWORD) {
  return post("/api/auth/sign-up", { email, password });
}

async function signIn(email: string, password: string) {
  return post("/api/auth/sign-in", { email, password });
}

/** Registers a fresh account, then optionally gives it a team role. */
async function makeUser(role?: Role) {
  const email = uniqueEmail();
  const created = await signUp(email);
  expect(created.statusCode).toBe(201);
  const body = created.json();
  if (role) roles.set(body.user.id, role);
  return {
    email,
    id: body.user.id as string,
    accessToken: body.accessToken as string,
    refreshToken: body.refreshToken as string,
  };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(AUTH_SQL_FILE, "utf8"));
  pool = createPGliteTransactionPool(db);
  authenticator = createSelfRequestAuthenticator({
    token: TOKEN_CONFIG,
    findUserById: (id) => findUserById(pool, id),
    isSessionActive: (sid, at) => isSessionActive(pool, sid, at),
  });
  app = Fastify({
    logger: {
      level: "info",
      stream: new Writable({
        write(chunk, _encoding, callback) {
          logLines.push(String(chunk));
          callback();
        },
      }),
    },
  });
  await registerAuthRoutes(app, { pool: () => pool, token: TOKEN_CONFIG });
  await registerAuthPasswordRoutes(app, {
    auth: authenticator,
    teamMembership,
    pool: () => pool,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

beforeEach(() => {
  logLines.length = 0;
});

describe("POST /api/admin/auth/reset-password", () => {
  it("answers 401 unauthorized without a token", async () => {
    const response = await post("/api/admin/auth/reset-password", {
      email: uniqueEmail(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });

  it("answers 403 forbidden for a plain member", async () => {
    const member = await makeUser("member");
    const target = await makeUser();

    const response = await post(
      "/api/admin/auth/reset-password",
      { email: target.email },
      member.accessToken,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("forbidden");
  });

  it("answers 403 forbidden for an authenticated user with no membership", async () => {
    const stranger = await makeUser();
    const target = await makeUser();

    const response = await post(
      "/api/admin/auth/reset-password",
      { email: target.email },
      stranger.accessToken,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("forbidden");
  });

  it("answers 404 for an email without an account", async () => {
    const admin = await makeUser("admin");

    const response = await post(
      "/api/admin/auth/reset-password",
      { email: "nobody@example.test" },
      admin.accessToken,
    );

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("invalid_request");
    expect(response.json().error.message).toBe("该邮箱没有账号");
  });

  it("returns exactly { email, temporaryPassword } with a 16 character base64url password", async () => {
    const admin = await makeUser("owner");
    const target = await makeUser();

    const response = await post(
      "/api/admin/auth/reset-password",
      { email: target.email },
      admin.accessToken,
    );

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["email", "temporaryPassword"]);
    expect(body.email).toBe(target.email.toLowerCase());
    expect(Array.from(body.temporaryPassword as string).length).toBe(16);
    expect(body.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("logs the actor and the target without the password", async () => {
    const admin = await makeUser("admin");
    const target = await makeUser();

    const response = await post(
      "/api/admin/auth/reset-password",
      { email: target.email },
      admin.accessToken,
    );
    const temporaryPassword: string = response.json().temporaryPassword;

    const resetLines = logLines.filter((line) => line.includes("auth.password_reset"));
    expect(resetLines.length).toBeGreaterThanOrEqual(1);
    const line = resetLines.join("\n");
    expect(line).toContain(admin.id);
    expect(line).toContain(target.id);
    expect(line).not.toContain(temporaryPassword);
  });

  it("revokes the target's live session and swaps the credentials", async () => {
    const admin = await makeUser("admin");
    const target = await makeUser();

    // The session issued by sign-up is what we are about to kill.
    const before = await authenticator.authenticate({
      headers: { authorization: `Bearer ${target.accessToken}` },
    } as never);
    expect(before?.id).toBe(target.id);

    const reset = await post(
      "/api/admin/auth/reset-password",
      { email: target.email },
      admin.accessToken,
    );
    expect(reset.statusCode).toBe(200);
    const temporaryPassword: string = reset.json().temporaryPassword;

    const after = await authenticator.authenticate({
      headers: { authorization: `Bearer ${target.accessToken}` },
    } as never);
    expect(after).toBeNull();

    const refreshed = await post("/api/auth/refresh", {
      refreshToken: target.refreshToken,
    });
    expect(refreshed.statusCode).toBe(401);

    const oldPassword = await signIn(target.email, PASSWORD);
    expect(oldPassword.statusCode).toBe(401);
    expect(oldPassword.json().error.code).toBe("invalid_credentials");

    const temporary = await signIn(target.email, temporaryPassword);
    expect(temporary.statusCode).toBe(200);
    expect(temporary.json().user.mustChangePassword).toBe(true);
  });
});

describe("POST /api/auth/change-password", () => {
  it("answers 401 unauthorized without a token", async () => {
    const response = await post("/api/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });

  it("answers 401 invalid_credentials for a wrong current password", async () => {
    const user = await makeUser();

    const response = await post(
      "/api/auth/change-password",
      { currentPassword: "not the password", newPassword: NEW_PASSWORD },
      user.accessToken,
    );

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_credentials");
  });

  it("answers 400 weak_password for a 7 character new password", async () => {
    const user = await makeUser();

    const response = await post(
      "/api/auth/change-password",
      { currentPassword: PASSWORD, newPassword: "1234567" },
      user.accessToken,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("weak_password");
  });

  it("answers 400 weak_password when the new password repeats the current one", async () => {
    const user = await makeUser();

    const response = await post(
      "/api/auth/change-password",
      { currentPassword: PASSWORD, newPassword: PASSWORD },
      user.accessToken,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("weak_password");
    expect(response.json().error.message).toBe("新密码不能与当前密码相同");
  });

  it("answers 204, kills the old token and clears mustChangePassword", async () => {
    const user = await makeUser();

    const response = await post(
      "/api/auth/change-password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      user.accessToken,
    );
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");

    const stale = await authenticator.authenticate({
      headers: { authorization: `Bearer ${user.accessToken}` },
    } as never);
    expect(stale).toBeNull();

    const oldPassword = await signIn(user.email, PASSWORD);
    expect(oldPassword.statusCode).toBe(401);

    const fresh = await signIn(user.email, NEW_PASSWORD);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().user.mustChangePassword).toBe(false);
  });

  it("consumes the temporary password issued by an administrator", async () => {
    const admin = await makeUser("admin");
    const target = await makeUser();

    const reset = await post(
      "/api/admin/auth/reset-password",
      { email: target.email },
      admin.accessToken,
    );
    const temporaryPassword: string = reset.json().temporaryPassword;

    const login = await signIn(target.email, temporaryPassword);
    expect(login.statusCode).toBe(200);
    expect(login.json().user.mustChangePassword).toBe(true);

    const changed = await post(
      "/api/auth/change-password",
      { currentPassword: temporaryPassword, newPassword: NEW_PASSWORD },
      login.json().accessToken as string,
    );
    expect(changed.statusCode).toBe(204);

    const fresh = await signIn(target.email, NEW_PASSWORD);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().user.mustChangePassword).toBe(false);
  });
});
