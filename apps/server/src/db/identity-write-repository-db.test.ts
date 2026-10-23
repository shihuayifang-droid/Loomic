import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCanonicalDb } from "../test-support/db/canonical-db.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "../test-support/db/pglite-db.js";
import {
  createIdentityWriteRepository,
  type IdentityWriteRepository,
} from "./identity-write-repository.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Workorder 44N: the new-user initialisation write, run on the same cases
 * against the retired supabase migration chain ("legacy") and against the
 * canonical schema ("canonical").
 *
 * Legacy: inserting into `auth.users` fires the sign-up trigger, so the user
 * already has a foundation and `bootstrap_viewer` must be idempotent.
 * Canonical: there is no trigger, and the user is inserted straight into
 * `hahart_auth.users` (not through `createCanonicalUser`, which already calls
 * `bootstrap_viewer`), so the first repository call is the one that creates the
 * foundation.
 */

const USER_ID = "00000000-0000-0000-0000-00000044e001";
const EMAIL = "boot-44n@hahart.test";

type Fixture = {
  db: PGlite;
  repository: IdentityWriteRepository;
};

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function setupLegacy(): Promise<Fixture> {
  const { db } = await createMigratedDb();
  await createUser(db, USER_ID, EMAIL);
  const pool = createPGliteTransactionPool(db);
  return {
    db,
    repository: createIdentityWriteRepository({ getTransactionPool: () => pool }),
  };
}

async function setupCanonical(): Promise<Fixture> {
  const { db } = await createCanonicalDb();
  await db.query(
    "insert into hahart_auth.users (id, email, status) values ($1, $2, 'active')",
    [USER_ID, EMAIL],
  );
  const pool = createPGliteTransactionPool(db);
  return {
    db,
    repository: createIdentityWriteRepository({ getTransactionPool: () => pool }),
  };
}

type Counts = { workspaces: number; members: number; profiles: number };

async function counts(db: PGlite): Promise<Counts> {
  const workspaces = firstRow(
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.workspaces where owner_user_id = $1::uuid and type = 'personal'",
        [USER_ID],
      )
    ).rows,
  ).n;
  const members = firstRow(
    (
      await db.query<{ n: number }>(
        `select count(*)::int as n
           from public.workspace_members m
           join public.workspaces w on w.id = m.workspace_id
          where m.user_id = $1::uuid and m.role = 'owner'
            and w.owner_user_id = $1::uuid and w.type = 'personal'`,
        [USER_ID],
      )
    ).rows,
  ).n;
  const profiles = firstRow(
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.profiles where id = $1::uuid",
        [USER_ID],
      )
    ).rows,
  ).n;
  return { workspaces, members, profiles };
}

async function displayNameOf(db: PGlite): Promise<string | null> {
  return firstRow(
    (
      await db.query<{ display_name: string | null }>(
        "select display_name from public.profiles where id = $1::uuid",
        [USER_ID],
      )
    ).rows,
  ).display_name;
}

function describeSuite(
  label: "legacy" | "canonical",
  setup: () => Promise<Fixture>,
  expectedBefore: Counts,
) {
  describe(`identity write repository (${label})`, () => {
    let fx: Fixture;

    beforeAll(async () => {
      fx = await setup();
    });

    afterAll(async () => {
      await fx.db.close();
    });

    it("starts from the expected pre-bootstrap state", async () => {
      expect(await counts(fx.db)).toEqual(expectedBefore);
    });

    it("bootstrapViewer leaves one profile, one personal workspace and one owner membership", async () => {
      await fx.repository.bootstrapViewer({
        userId: USER_ID,
        email: EMAIL,
        userMeta: { full_name: "Tester 44N" },
      });

      expect(await counts(fx.db)).toEqual({ workspaces: 1, members: 1, profiles: 1 });
    });

    it("a second call adds no rows", async () => {
      await fx.repository.bootstrapViewer({
        userId: USER_ID,
        email: EMAIL,
        userMeta: { full_name: "Tester 44N" },
      });

      expect(await counts(fx.db)).toEqual({ workspaces: 1, members: 1, profiles: 1 });
    });

    it("null email and undefined metadata are accepted", async () => {
      await fx.repository.bootstrapViewer({
        userId: USER_ID,
        email: null,
        userMeta: undefined,
      });

      expect(await counts(fx.db)).toEqual({ workspaces: 1, members: 1, profiles: 1 });
    });

    it("a database error reaches the caller unwrapped", async () => {
      const error = await fx.repository
        .bootstrapViewer({
          userId: "not-a-uuid",
          email: null,
          userMeta: {},
        })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: unknown }).code).toBe("22P02");
    });
  });
}

describeSuite("legacy", setupLegacy, { workspaces: 1, members: 1, profiles: 1 });
describeSuite("canonical", setupCanonical, { workspaces: 0, members: 0, profiles: 0 });

describe("identity write repository: display name", () => {
  it("canonical: the display name in the metadata lands on the profile", async () => {
    const fx = await setupCanonical();
    try {
      await fx.repository.bootstrapViewer({
        userId: USER_ID,
        email: EMAIL,
        userMeta: { full_name: "Tester 44N" },
      });

      expect(await displayNameOf(fx.db)).toBe("Tester 44N");
    } finally {
      await fx.db.close();
    }
  });
});
