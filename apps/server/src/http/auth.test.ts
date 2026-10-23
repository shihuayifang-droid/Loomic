/**
 * Route tests for the self-hosted auth endpoints (ticket 42D).
 *
 * A bare PGlite gets only `apps/server/db/canonical/0001_auth.sql`; the real
 * repository SQL runs through `createPGliteTransactionPool`. Only
 * `registerAuthRoutes` is mounted on a minimal Fastify instance.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSelfRequestAuthenticator } from "../auth/self-authenticator.js";
import { DEFAULT_ACCESS_TTL_SECONDS, accessTokenSecretFrom } from "../auth/tokens.js";
import {
  findUserByEmail,
  findUserById,
  isSessionActive,
  setUserStatus,
} from "../db/auth-repository.js";
import { createPGliteTransactionPool } from "../test-support/db/pglite-db.js";
import { registerAuthRoutes } from "./auth.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_SQL_FILE = join(HERE, "..", "..", "db", "canonical", "0001_auth.sql");

const TOKEN_CONFIG = {
  secret: accessTokenSecretFrom("test-secret-test-secret-test-secret-0123456789"),
  issuer: "hahart",
  audience: "hahart-api",
  ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
};

const PASSWORD = "correct horse battery";

let db: PGlite;
let pool: ReturnType<typeof createPGliteTransactionPool>;
let app: FastifyInstance;
let counter = 0;

function uniqueEmail(): string {
  counter += 1;
  return `Person${counter}@Example.Test`;
}

async function post(url: string, payload: unknown) {
  return app.inject({ method: "POST", url, payload: payload as object });
}

async function signUp(email = uniqueEmail(), password = PASSWORD) {
  return post("/api/auth/sign-up", { email, password });
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(AUTH_SQL_FILE, "utf8"));
  pool = createPGliteTransactionPool(db);
  app = Fastify();
  await registerAuthRoutes(app, { pool: () => pool, token: TOKEN_CONFIG });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("POST /api/auth/sign-up", () => {
  it("creates an active account and returns a session", async () => {
    const email = uniqueEmail();
    const response = await signUp(email);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(body.user.email).toBe(email.toLowerCase());

    const stored = await findUserByEmail(pool, email);
    expect(stored?.status).toBe("active");
  });

  it("answers 409 email_taken for the same email in a different case", async () => {
    const email = uniqueEmail();
    expect((await signUp(email)).statusCode).toBe(201);

    const again = await signUp(email.toUpperCase());
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("email_taken");
  });

  it("answers 400 weak_password for a 7 character password", async () => {
    const response = await signUp(uniqueEmail(), "1234567");

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("weak_password");
  });
});

describe("POST /api/auth/sign-in", () => {
  it("returns a session for the right password", async () => {
    const email = uniqueEmail();
    await signUp(email);

    const response = await post("/api/auth/sign-in", { email, password: PASSWORD });

    expect(response.statusCode).toBe(200);
    expect(typeof response.json().accessToken).toBe("string");
    expect(typeof response.json().refreshToken).toBe("string");
  });

  it("answers 401 invalid_credentials for a wrong password", async () => {
    const email = uniqueEmail();
    await signUp(email);

    const response = await post("/api/auth/sign-in", { email, password: "not the password" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_credentials");
  });

  it("gives an unknown email the very same code and message as a wrong password", async () => {
    const email = uniqueEmail();
    await signUp(email);

    const wrong = await post("/api/auth/sign-in", { email, password: "not the password" });
    const unknown = await post("/api/auth/sign-in", {
      email: uniqueEmail(),
      password: PASSWORD,
    });

    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe("invalid_credentials");
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
  });

  it("throttles after 5 failures, even when the 6th password is right", async () => {
    const email = uniqueEmail();
    await signUp(email);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await post("/api/auth/sign-in", { email, password: "not the password" });
      expect(failed.statusCode).toBe(401);
    }

    const blocked = await post("/api/auth/sign-in", { email, password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("too_many_attempts");
  });

  it("answers 403 account_disabled for a disabled user", async () => {
    const email = uniqueEmail();
    const registered = await signUp(email);
    await setUserStatus(pool, registered.json().user.id, "disabled");

    const response = await post("/api/auth/sign-in", { email, password: PASSWORD });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("account_disabled");
  });

  it("issues an access token the 42C authenticator recognises", async () => {
    const email = uniqueEmail();
    const registered = await signUp(email);
    const login = await post("/api/auth/sign-in", { email, password: PASSWORD });

    const authenticator = createSelfRequestAuthenticator({
      token: TOKEN_CONFIG,
      findUserById: (id) => findUserById(pool, id),
      isSessionActive: (sid, at) => isSessionActive(pool, sid, at),
    });
    const user = await authenticator.authenticate({
      headers: { authorization: `Bearer ${login.json().accessToken}` },
    } as never);

    expect(user?.id).toBe(registered.json().user.id);
  });
});

describe("POST /api/auth/refresh", () => {
  it("rotates the token, and replaying the old one revokes the whole family", async () => {
    const email = uniqueEmail();
    await signUp(email);
    const login = await post("/api/auth/sign-in", { email, password: PASSWORD });
    const oldRefresh: string = login.json().refreshToken;

    const rotated = await post("/api/auth/refresh", { refreshToken: oldRefresh });
    expect(rotated.statusCode).toBe(200);
    const newRefresh: string = rotated.json().refreshToken;
    expect(newRefresh).not.toBe(oldRefresh);

    const replay = await post("/api/auth/refresh", { refreshToken: oldRefresh });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("invalid_refresh");

    const afterReplay = await post("/api/auth/refresh", { refreshToken: newRefresh });
    expect(afterReplay.statusCode).toBe(401);
    expect(afterReplay.json().error.code).toBe("invalid_refresh");
  });
});

describe("POST /api/auth/sign-out", () => {
  it("revokes the session behind the refresh token", async () => {
    const email = uniqueEmail();
    await signUp(email);
    const login = await post("/api/auth/sign-in", { email, password: PASSWORD });
    const refreshToken: string = login.json().refreshToken;

    const out = await post("/api/auth/sign-out", { refreshToken });
    expect(out.statusCode).toBe(204);

    const refreshed = await post("/api/auth/refresh", { refreshToken });
    expect(refreshed.statusCode).toBe(401);
    expect(refreshed.json().error.code).toBe("invalid_refresh");
  });

  it("answers 204 for a token that does not exist", async () => {
    const out = await post("/api/auth/sign-out", { refreshToken: "no-such-token" });

    expect(out.statusCode).toBe(204);
  });
});

describe("response hygiene", () => {
  it("never carries password or passwordHash keys", async () => {
    const email = uniqueEmail();
    const up = await signUp(email);
    const login = await post("/api/auth/sign-in", { email, password: PASSWORD });
    const refreshed = await post("/api/auth/refresh", {
      refreshToken: login.json().refreshToken,
    });
    const weak = await signUp(uniqueEmail(), "short");

    for (const response of [up, login, refreshed, weak]) {
      expect(response.body).not.toContain("passwordHash");
      expect(response.body).not.toContain('"password"');
    }
  });
});
