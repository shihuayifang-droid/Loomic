/**
 * Database tests for the auth repository (ticket 42B).
 *
 * A bare `new PGlite()` (real PostgreSQL parser, in-memory) gets only
 * `apps/server/db/canonical/0001_auth.sql`, deliberately NOT the Supabase
 * baseline: the canonical schema has to stand on its own on an empty database.
 * The repository's real SQL then runs through the real `withTransaction`
 * contract via `createPGliteTransactionPool`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clearLoginFailures,
  countRecentLoginFailures,
  createSession,
  createUser,
  findUserByEmail,
  findUserById,
  isSessionActive,
  recordLoginFailure,
  revokeSession,
  rotateSession,
  setPassword,
  setUserStatus,
} from "../../db/auth-repository.js";
import { createPGliteTransactionPool } from "./pglite-db.js";

/** `src/test-support/db` -> repo root is five levels up. */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const AUTH_SQL_FILE = join(
  REPO_ROOT,
  "apps",
  "server",
  "db",
  "canonical",
  "0001_auth.sql",
);

const ACCESS_TTL_MS = 15 * 60 * 1000;
const THROTTLE_WINDOW_MS = ACCESS_TTL_MS;

let db: PGlite;
let pool: ReturnType<typeof createPGliteTransactionPool>;
let emailCounter = 0;
let hashCounter = 0;

function uniqueEmail(): string {
  emailCounter += 1;
  return `user${emailCounter}@example.test`;
}

function uniqueHash(): string {
  hashCounter += 1;
  return `refresh-hash-${hashCounter}`;
}

function inOneHour(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

async function makeUser(
  email = uniqueEmail(),
  passwordHash = `scrypt-hash-${email}`,
): Promise<string> {
  const created = await createUser(pool, { email, passwordHash });
  if (!("id" in created)) {
    throw new Error(`createUser reported a conflict for a fresh email ${email}`);
  }

  return created.id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(AUTH_SQL_FILE, "utf8"));
  pool = createPGliteTransactionPool(db);
});

afterAll(async () => {
  await db.close();
});

describe("canonical migration 0001", () => {
  it("does not reference any Supabase auth object", () => {
    const sql = readFileSync(AUTH_SQL_FILE, "utf8");
    // `hahart_auth.` has an underscore before "auth", so it is not matched.
    expect(sql).not.toMatch(/(^|[^_])auth\./);
  });
});

describe("createUser / findUserByEmail / findUserById", () => {
  it("creates a pending user with token version 0 and stores the credential", async () => {
    const email = uniqueEmail();
    const passwordHash = `scrypt-hash-${email}`;

    const created = await createUser(pool, {
      email,
      displayName: "Ada Lovelace",
      passwordHash,
    });
    if (!("id" in created)) throw new Error("createUser reported a conflict");
    expect(typeof created.id).toBe("string");

    const byId = await findUserById(pool, created.id);
    expect(byId).not.toBeNull();
    expect(byId?.status).toBe("pending");
    expect(byId?.tokenVersion).toBe(0);
    expect(byId?.mustChangePassword).toBe(false);
    expect(byId?.displayName).toBe("Ada Lovelace");
    expect(byId?.email).toBe(email);

    // The hash lives in `credentials`, reachable through the user read.
    expect(byId?.passwordHash).toBe(passwordHash);

    const stored = await db.query<{ password_hash: string }>(
      "select c.password_hash from hahart_auth.credentials as c where c.user_id = $1::uuid",
      [created.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.password_hash).toBe(passwordHash);
  });

  it("reports conflict for the same email with a different case", async () => {
    const email = uniqueEmail();
    const first = await createUser(pool, { email, passwordHash: "hash-a" });
    expect("id" in first).toBe(true);

    const second = await createUser(pool, {
      email: email.toUpperCase(),
      passwordHash: "hash-b",
    });
    expect(second).toEqual({ conflict: true });

    const third = await createUser(pool, {
      email,
      passwordHash: "hash-c",
    });
    expect(third).toEqual({ conflict: true });
  });

  it("finds a user case-insensitively by email", async () => {
    const email = uniqueEmail();
    const created = await createUser(pool, { email, passwordHash: "hash-x" });
    if (!("id" in created)) throw new Error("createUser reported a conflict");

    const mixed = await findUserByEmail(pool, email.toUpperCase());
    expect(mixed?.id).toBe(created.id);
    expect(mixed?.email).toBe(email);

    const lower = await findUserByEmail(pool, email);
    expect(lower?.id).toBe(created.id);
  });

  it("returns null for an unknown email and an unknown id", async () => {
    expect(await findUserByEmail(pool, "nobody@example.test")).toBeNull();
    expect(
      await findUserById(pool, "00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });

  it("updates the status and reads it back", async () => {
    const id = await makeUser();
    await setUserStatus(pool, id, "active");
    expect((await findUserById(pool, id))?.status).toBe("active");

    await setUserStatus(pool, id, "disabled");
    expect((await findUserById(pool, id))?.status).toBe("disabled");
  });
});

describe("setPassword", () => {
  it("bumps token version, honours mustChange and revokes every live session", async () => {
    const id = await makeUser();
    await setUserStatus(pool, id, "active");

    const first = await createSession(pool, {
      userId: id,
      refreshHash: uniqueHash(),
      expiresAt: inOneHour(),
    });
    const second = await createSession(pool, {
      userId: id,
      refreshHash: uniqueHash(),
      expiresAt: inOneHour(),
    });

    const now = new Date();
    expect(await isSessionActive(pool, first.id, now)).toBe(true);
    expect(await isSessionActive(pool, second.id, now)).toBe(true);

    await setPassword(pool, id, "new-scrypt-hash", { mustChange: true });

    const user = await findUserById(pool, id);
    expect(user?.tokenVersion).toBe(1);
    expect(user?.mustChangePassword).toBe(true);
    expect(user?.passwordHash).toBe("new-scrypt-hash");

    expect(await isSessionActive(pool, first.id, now)).toBe(false);
    expect(await isSessionActive(pool, second.id, now)).toBe(false);

    await setPassword(pool, id, "newer-scrypt-hash", { mustChange: false });
    const again = await findUserById(pool, id);
    expect(again?.tokenVersion).toBe(2);
    expect(again?.mustChangePassword).toBe(false);
    expect(again?.passwordHash).toBe("newer-scrypt-hash");
  });
});

describe("createSession / revokeSession / isSessionActive", () => {
  it("keeps a session active until it is revoked or expires", async () => {
    const id = await makeUser();
    const session = await createSession(pool, {
      userId: id,
      refreshHash: uniqueHash(),
      expiresAt: inOneHour(),
    });

    expect(typeof session.familyId).toBe("string");
    const now = new Date();
    expect(await isSessionActive(pool, session.id, now)).toBe(true);

    const expiredProbe = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(await isSessionActive(pool, session.id, expiredProbe)).toBe(false);

    await revokeSession(pool, session.id);
    expect(await isSessionActive(pool, session.id, now)).toBe(false);

    expect(
      await isSessionActive(
        pool,
        "00000000-0000-4000-8000-000000000000",
        now,
      ),
    ).toBe(false);
  });
});

describe("rotateSession", () => {
  it("rotates a token inside its family", async () => {
    const id = await makeUser();
    const firstHash = uniqueHash();
    const first = await createSession(pool, {
      userId: id,
      refreshHash: firstHash,
      expiresAt: inOneHour(),
    });

    const now = new Date();
    const rotated = await rotateSession(pool, {
      refreshHash: firstHash,
      newRefreshHash: uniqueHash(),
      newExpiresAt: inOneHour(),
      now,
    });

    expect(rotated.status).toBe("rotated");
    if (rotated.status !== "rotated") throw new Error("expected a rotation");
    expect(rotated.session.userId).toBe(id);
    expect(rotated.session.familyId).toBe(first.familyId);
    expect(rotated.session.id).not.toBe(first.id);

    expect(await isSessionActive(pool, first.id, now)).toBe(false);
    expect(await isSessionActive(pool, rotated.session.id, now)).toBe(true);

    // The successor is readable again by its own refresh hash.
    const second = await rotateSession(pool, {
      refreshHash: await refreshHashOf(rotated.session.id),
      newRefreshHash: uniqueHash(),
      newExpiresAt: inOneHour(),
      now,
    });
    expect(second.status).toBe("rotated");
  });

  it("treats a replayed token as reuse and revokes the whole family", async () => {
    const id = await makeUser();
    const firstHash = uniqueHash();
    await createSession(pool, {
      userId: id,
      refreshHash: firstHash,
      expiresAt: inOneHour(),
    });

    const now = new Date();
    const rotated = await rotateSession(pool, {
      refreshHash: firstHash,
      newRefreshHash: uniqueHash(),
      newExpiresAt: inOneHour(),
      now,
    });
    if (rotated.status !== "rotated") throw new Error("expected a rotation");

    const replay = await rotateSession(pool, {
      refreshHash: firstHash,
      newRefreshHash: uniqueHash(),
      newExpiresAt: inOneHour(),
      now: new Date(),
    });
    expect(replay).toEqual({ status: "reused", userId: id });

    // The successor minted by the legitimate rotation is gone too.
    expect(await isSessionActive(pool, rotated.session.id, new Date())).toBe(
      false,
    );
  });

  it("rejects an expired token and an unknown token", async () => {
    const id = await makeUser();
    const expiredHash = uniqueHash();
    await createSession(pool, {
      userId: id,
      refreshHash: expiredHash,
      expiresAt: new Date(Date.now() - 60 * 1000),
    });

    const expired = await rotateSession(pool, {
      refreshHash: expiredHash,
      newRefreshHash: uniqueHash(),
      newExpiresAt: inOneHour(),
      now: new Date(),
    });
    expect(expired).toEqual({ status: "invalid" });

    const unknown = await rotateSession(pool, {
      refreshHash: "no-such-token",
      newRefreshHash: uniqueHash(),
      newExpiresAt: inOneHour(),
      now: new Date(),
    });
    expect(unknown).toEqual({ status: "invalid" });
  });
});

describe("login failure throttle", () => {
  it("counts only failures inside the window and clears them", async () => {
    const key = `198.51.100.7|${uniqueEmail()}`;
    const start = new Date();

    for (let index = 0; index < 5; index += 1) {
      await recordLoginFailure(pool, key, new Date(start.getTime() + index));
    }

    const since = new Date(start.getTime() - THROTTLE_WINDOW_MS);
    expect(await countRecentLoginFailures(pool, key, since)).toBe(5);

    // One failure well outside the 15-minute window must not be counted.
    await recordLoginFailure(
      pool,
      key,
      new Date(start.getTime() - THROTTLE_WINDOW_MS - 60 * 1000),
    );
    expect(await countRecentLoginFailures(pool, key, since)).toBe(5);

    // A wider window does see it.
    expect(
      await countRecentLoginFailures(
        pool,
        key,
        new Date(start.getTime() - THROTTLE_WINDOW_MS - 120 * 1000),
      ),
    ).toBe(6);

    await clearLoginFailures(pool, key);
    expect(await countRecentLoginFailures(pool, key, since)).toBe(0);
  });

  it("keeps separate throttle keys apart", async () => {
    const first = `198.51.100.8|${uniqueEmail()}`;
    const second = `198.51.100.9|${uniqueEmail()}`;
    const now = new Date();

    await recordLoginFailure(pool, first, now);
    await recordLoginFailure(pool, first, now);
    await recordLoginFailure(pool, second, now);

    const since = new Date(now.getTime() - THROTTLE_WINDOW_MS);
    expect(await countRecentLoginFailures(pool, first, since)).toBe(2);
    expect(await countRecentLoginFailures(pool, second, since)).toBe(1);
    expect(
      await countRecentLoginFailures(pool, "198.51.100.10|nobody", since),
    ).toBe(0);
  });
});

/** Reads the refresh hash of a stored session, for a second rotation. */
async function refreshHashOf(sessionId: string): Promise<string> {
  const result = await db.query<{ refresh_hash: string }>(
    "select refresh_hash from hahart_auth.sessions where id = $1::uuid",
    [sessionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("session row is missing");
  return row.refresh_hash;
}
