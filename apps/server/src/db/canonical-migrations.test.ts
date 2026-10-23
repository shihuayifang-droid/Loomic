/**
 * Tests for the canonical migration runner (ticket 43N).
 *
 * PGlite is a real PostgreSQL parser in memory, so these cases exercise the real
 * DDL in `apps/server/db/canonical/*.sql` — no Supabase stubs, no baseline.
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  createCanonicalDb,
  createCanonicalUser,
} from "../test-support/db/canonical-db.js";

import {
  CANONICAL_DIR,
  listCanonicalMigrations,
  runCanonicalMigrations,
  type MigrationFile,
} from "./canonical-migrations.js";

vi.setConfig({ testTimeout: 60_000 });

const USER_ID = "3f6f1d52-4a1f-4c37-9d4b-2c0c6f6f3a11";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "canonical-migrations-"));
  tempDirs.push(dir);
  return dir;
}

/** `pg`-shaped adapter over one PGlite instance; `begin`/`commit` are plain SQL. */
function execOver(db: PGlite) {
  return {
    async query(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: any[] }> {
      const result = await db.query(sql, params ? [...params] : undefined);
      return { rows: result.rows as any[] };
    },
    async exec(sql: string): Promise<unknown> {
      return db.exec(sql);
    },
  };
}

async function countRows(db: PGlite, table: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `select count(*)::int as n from ${table}`,
  );
  return result.rows[0]?.n ?? -1;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("listCanonicalMigrations", () => {
  it("lists 0001 and 0002 in ascending order with sha256 checksums", () => {
    const files = listCanonicalMigrations();
    const versions = files.map((file) => file.version);

    expect(CANONICAL_DIR).toMatch(/db[\\/]canonical$/);
    expect(versions).toContain("0001");
    expect(versions).toContain("0002");
    expect(versions).toEqual([...versions].sort());
    expect(files.map((file) => file.name)).toContain("0001_auth.sql");
    expect(files.map((file) => file.name)).toContain("0002_queue.sql");

    for (const file of files) {
      expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(file.name.startsWith(file.version)).toBe(true);
      expect(file.sql.length).toBeGreaterThan(0);
    }
  });

  it("ignores file names that are not NNNN_lower_snake_case.sql", () => {
    const dir = makeTempDir();

    copyFileSync(
      join(CANONICAL_DIR, "0001_auth.sql"),
      join(dir, "0001_auth.sql"),
    );
    writeFileSync(join(dir, "README.md"), "not a migration\n");
    writeFileSync(join(dir, "0003_Bad-Name.sql"), "select 1;\n");
    writeFileSync(join(dir, "0004_leftover.sql.bak"), "select 1;\n");
    writeFileSync(join(dir, "01_too_short.sql"), "select 1;\n");

    expect(listCanonicalMigrations(dir).map((file) => file.name)).toEqual([
      "0001_auth.sql",
    ]);
  });

  it("throws when two files claim the same version", () => {
    const dir = makeTempDir();

    writeFileSync(join(dir, "0005_auth.sql"), "select 1;\n");
    writeFileSync(join(dir, "0005_queue.sql"), "select 1;\n");

    expect(() => listCanonicalMigrations(dir)).toThrow(/0005/);
  });
});

describe("runCanonicalMigrations", () => {
  it("applies every canonical file and records it once", async () => {
    const files = listCanonicalMigrations();
    const { db, applied } = await createCanonicalDb();

    try {
      expect(applied).toEqual(files.map((file) => file.name));
      expect(await countRows(db, "public.schema_migrations")).toBe(
        files.length,
      );

      const tables = await db.query<{
        table_schema: string;
        table_name: string;
      }>(
        "select table_schema, table_name from information_schema.tables " +
          "where table_schema in ('hahart_auth', 'hahart_queue')",
      );
      const qualified = tables.rows.map(
        (row) => `${row.table_schema}.${row.table_name}`,
      );

      expect(qualified).toContain("hahart_auth.users");
      expect(qualified).toContain("hahart_queue.messages");
    } finally {
      await db.close();
    }
  });

  it("is idempotent: a second run applies nothing and skips everything", async () => {
    const files = listCanonicalMigrations();
    const { db } = await createCanonicalDb();

    try {
      const second = await runCanonicalMigrations(execOver(db));

      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(files.map((file) => file.name));
      expect(await countRows(db, "public.schema_migrations")).toBe(
        files.length,
      );
    } finally {
      await db.close();
    }
  });

  it("refuses a file whose recorded checksum changed and leaves the database untouched", async () => {
    const files = listCanonicalMigrations();
    const { db } = await createCanonicalDb();

    try {
      const tampered: MigrationFile = {
        version: "0001",
        name: "0001_auth.sql",
        sql: "create table hahart_auth.tampered (id integer);\n",
        checksum: "0".repeat(64),
      };

      await expect(
        runCanonicalMigrations(execOver(db), [tampered]),
      ).rejects.toThrow(
        "canonical migration 0001_auth.sql was changed after it was applied",
      );

      expect(await countRows(db, "public.schema_migrations")).toBe(
        files.length,
      );

      const tamperedTable = await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables " +
          "where table_schema = 'hahart_auth' and table_name = 'tampered'",
      );
      expect(tamperedTable.rows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("rolls back a new file whose SQL fails and does not record it", async () => {
    const { db } = await createCanonicalDb();

    try {
      const broken: MigrationFile = {
        version: "9999",
        name: "9999_broken.sql",
        sql:
          "create table hahart_queue.broken (id integer);\n" +
          "this is not valid sql;\n",
        checksum: "1".repeat(64),
      };

      await expect(
        runCanonicalMigrations(execOver(db), [broken]),
      ).rejects.toThrow(/^canonical migration 9999_broken\.sql failed:/);

      const recorded = await db.query<{ version: string }>(
        "select version from public.schema_migrations where version = '9999'",
      );
      expect(recorded.rows).toEqual([]);

      const brokenTable = await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables " +
          "where table_schema = 'hahart_queue' and table_name = 'broken'",
      );
      expect(brokenTable.rows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("leaves no Supabase schema on a fresh database", async () => {
    const { db } = await createCanonicalDb();

    try {
      const schemas = await db.query<{ schema_name: string }>(
        "select schema_name from information_schema.schemata",
      );
      const names = schemas.rows.map((row) => row.schema_name);

      expect(names).toContain("hahart_auth");
      expect(names).toContain("hahart_queue");
      expect(names).not.toContain("auth");
      expect(names).not.toContain("storage");
      expect(names).not.toContain("pgmq");
    } finally {
      await db.close();
    }
  });
});

describe("createCanonicalUser", () => {
  it("inserts an active user into hahart_auth.users", async () => {
    const { db } = await createCanonicalDb();

    try {
      await createCanonicalUser(db, USER_ID, "viewer@example.com");

      const users = await db.query<{ id: string; email: string; status: string }>(
        "select id, email, status from hahart_auth.users where id = $1",
        [USER_ID],
      );

      expect(users.rows).toHaveLength(1);
      expect(users.rows[0]?.id).toBe(USER_ID);
      expect(users.rows[0]?.email).toBe("viewer@example.com");
      expect(users.rows[0]?.status).toBe("active");
    } finally {
      await db.close();
    }
  });
});
