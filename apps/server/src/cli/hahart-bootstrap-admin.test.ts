import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { verifyPassword } from "../auth/password.js";
import { createSelfRequestAuthenticator } from "../auth/self-authenticator.js";
import {
  accessTokenSecretFrom,
  DEFAULT_ACCESS_TTL_SECONDS,
  signAccessToken,
} from "../auth/tokens.js";
import {
  createSession,
  findUserByEmail,
  findUserById,
  isSessionActive,
} from "../db/auth-repository.js";
import type { TransactionPool } from "../db/transaction.js";
import { createCanonicalDb } from "../test-support/db/canonical-db.js";
import { createPGliteTransactionPool } from "../test-support/db/pglite-db.js";

import {
  main,
  parseBootstrapAdminArgs,
  runBootstrapAdmin,
} from "./hahart-bootstrap-admin.js";

vi.setConfig({ testTimeout: 60_000 });

const EMAIL = "first-admin@example.test";
const PASSWORD = "first-admin-pass-1";
const OTHER_PASSWORD = "another-pass-2222";

let db: PGlite;
let pool: TransactionPool;

beforeAll(async () => {
  ({ db } = await createCanonicalDb());
  pool = createPGliteTransactionPool(db);
});

afterAll(async () => {
  await db.close();
});

async function countRows(sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: number }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

describe("parseBootstrapAdminArgs", () => {
  it("throws when --email is missing", () => {
    expect(() => parseBootstrapAdminArgs([])).toThrow("--email is required");
  });

  it("parses --email and --name", () => {
    expect(
      parseBootstrapAdminArgs(["--email", "a@x.test", "--name", "管理员"]),
    ).toEqual({ email: "a@x.test", displayName: "管理员" });
  });

  it("returns 2 for bad arguments without needing a database", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["--bogus"], {})).toBe(2);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("runBootstrapAdmin on a fresh canonical database", () => {
  it("refuses to create an account without a password or with a weak one", async () => {
    await expect(
      runBootstrapAdmin(pool, { email: EMAIL, password: undefined }),
    ).rejects.toThrow(
      "HAHART_BOOTSTRAP_ADMIN_PASSWORD is required to create the first administrator",
    );
    await expect(
      runBootstrapAdmin(pool, { email: EMAIL, password: "1234567" }),
    ).rejects.toThrow("password does not meet the policy (too_short)");

    expect(await countRows("select count(*)::int as n from hahart_auth.users")).toBe(0);
  });

  it("creates the first administrator and the team workspace", async () => {
    const result = await runBootstrapAdmin(pool, {
      email: EMAIL,
      displayName: "管理员",
      password: PASSWORD,
    });

    expect(result.created).toBe(true);

    const user = await findUserByEmail(pool, EMAIL);
    expect(user?.id).toBe(result.userId);
    expect(user?.status).toBe("active");
    expect(user?.passwordHash?.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(user?.passwordHash ?? "", PASSWORD)).toBe(true);

    expect(
      await countRows(
        "select count(*)::int as n from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [result.userId],
      ),
    ).toBe(1);

    const teams = await db.query<{ id: string; name: string }>(
      "select id, name from public.workspaces where type = 'team'",
    );
    expect(teams.rows).toHaveLength(1);
    expect(teams.rows[0]?.name).toBe("HaHart 团队");
    expect(teams.rows[0]?.id).toBe(result.teamWorkspaceId);

    const member = await db.query<{ role: string }>(
      "select role from public.workspace_members where workspace_id = $1 and user_id = $2",
      [result.teamWorkspaceId, result.userId],
    );
    expect(member.rows[0]?.role).toBe("owner");
  });

  it("is idempotent: a second run keeps the password and the workspaces", async () => {
    const before = await findUserByEmail(pool, EMAIL);
    const workspacesBefore = await countRows(
      "select count(*)::int as n from public.workspaces",
    );
    const teamBefore = await db.query<{ id: string }>(
      "select id from public.workspaces where type = 'team'",
    );

    const again = await runBootstrapAdmin(pool, {
      email: EMAIL,
      password: OTHER_PASSWORD,
    });

    expect(again.created).toBe(false);
    expect(again.userId).toBe(before?.id);
    expect(again.teamWorkspaceId).toBe(teamBefore.rows[0]?.id);

    const after = await findUserByEmail(pool, EMAIL);
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(await verifyPassword(after?.passwordHash ?? "", PASSWORD)).toBe(true);
    expect(await verifyPassword(after?.passwordHash ?? "", OTHER_PASSWORD)).toBe(
      false,
    );
    expect(await countRows("select count(*)::int as n from public.workspaces")).toBe(
      workspacesBefore,
    );
  });

  it("re-activates an existing account that is not active", async () => {
    await db.query("update hahart_auth.users set status = 'disabled' where lower(email) = lower($1)", [
      EMAIL,
    ]);

    const result = await runBootstrapAdmin(pool, {
      email: EMAIL,
      password: undefined,
    });

    expect(result.created).toBe(false);
    expect((await findUserByEmail(pool, EMAIL))?.status).toBe("active");
  });

  it("produces an account the self-hosted authenticator accepts", async () => {
    const user = await findUserByEmail(pool, EMAIL);
    if (!user) throw new Error("administrator missing");

    const now = new Date();
    const session = await createSession(pool, {
      userId: user.id,
      refreshHash: "bootstrap-admin-refresh-hash",
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
    const token = {
      secret: accessTokenSecretFrom("bootstrap-admin-test-secret-0123456789"),
      issuer: "hahart",
      audience: "hahart-api",
      ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
    };
    const accessToken = await signAccessToken(
      token,
      {
        sub: user.id,
        sid: session.id,
        ver: user.tokenVersion,
        email: user.email,
      },
      now,
    );

    const authenticator = createSelfRequestAuthenticator({
      token,
      findUserById: (id) => findUserById(pool, id),
      isSessionActive: (sessionId, at) => isSessionActive(pool, sessionId, at),
      now: () => now,
    });
    const authenticated = await authenticator.authenticate({
      headers: { authorization: `Bearer ${accessToken}` },
    } as never);

    expect(authenticated?.id).toBe(user.id);
    expect(authenticated?.email).toBe(EMAIL);
  });
});

describe("main output", () => {
  it("prints the result line and never the password", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    let ended = 0;

    try {
      const code = await main(
        ["--email", EMAIL],
        { DATABASE_URL: "postgres://unused.invalid/db", HAHART_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
        {
          createPool: () => ({
            connect: (...args) => pool.connect(...args),
            end: async () => {
              ended += 1;
            },
          }),
        },
      );
      expect(code).toBe(0);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }

    const output = stdout.join("") + stderr.join("");
    expect(output).toMatch(/^admin=first-admin@example\.test created=false team=\S+\n$/);
    expect(output).not.toContain(PASSWORD);
    expect(ended).toBe(1);
  });

  it("returns 1 without DATABASE_URL", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["--email", EMAIL], {})).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
