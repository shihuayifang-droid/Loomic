// X-52 prep (T1): the home-seed bucket must be public for reads and closed for
// writes, and `project-assets` must be left exactly as it was.
//
// WHY EACH CASE EXISTS
//   * `public = true` is the whole point of the split: the home page, the example
//     library and the discovery library are all anonymous, and if this bucket is
//     not publicly readable the migration has bought nothing.
//   * A public SELECT policy without a matching write policy is the part that is
//     easy to get wrong: RLS denies by default, so "no policy" IS the write
//     protection — but only as long as nobody later adds a broad policy. Pinning
//     anon/authenticated INSERT being rejected is what makes that observable.
//   * `project-assets` still public is the safety property of this whole ticket:
//     while the seeds are only *copied*, the old bucket must keep serving them.
//     A migration that flipped it private here would take the home page down.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite, Transaction } from "@electric-sql/pglite";

import { asUser, createMigratedDb } from "./pglite-db.js";

const SEED_MIGRATION = "20261002000001_hahart_public_home_seeds_bucket.sql";

let db: PGlite;
let applied: string[] = [];

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** Run `fn` as service_role — the identity the seed CLI writes with. */
async function asServiceRole<T>(
  database: PGlite,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return fn(tx);
  });
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  applied = created.applied;
}, 120_000);

describe("home-seeds bucket (X-52 prep)", () => {
  it("case 1: the bucket exists, is public, 50 MiB, images only", async () => {
    const bucket = firstRow(
      (
        await db.query<{
          public: boolean;
          file_size_limit: string;
          allowed_mime_types: string[];
        }>(
          "select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'home-seeds'",
        )
      ).rows,
    );

    expect(bucket.public).toBe(true);
    expect(Number(bucket.file_size_limit)).toBe(52428800);
    expect(bucket.allowed_mime_types).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/svg+xml",
      "image/gif",
    ]);
  });

  it("case 2: exactly one policy touches the bucket, and it is a public SELECT", async () => {
    const policies = (
      await db.query<{ policyname: string; cmd: string; roles: string[] }>(
        `select policyname, cmd, roles
           from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'home_seeds_select_public'`,
      )
    ).rows;

    expect(policies).toHaveLength(1);
    expect(policies[0]?.cmd).toBe("SELECT");
    // `to public` — anonymous readers are the entire audience for seed images.
    expect(policies[0]?.roles).toContain("public");

    // And nothing else mentions the bucket, so no write path was opened.
    const writePolicies = (
      await db.query<{ count: string }>(
        `select count(*)::text as count
           from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and cmd <> 'SELECT'
            and coalesce(qual, '') || coalesce(with_check, '') like '%home-seeds%'`,
      )
    ).rows;
    expect(firstRow(writePolicies).count).toBe("0");
  });

  it("case 3: anon can read a seed object but cannot insert one", async () => {
    await db.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('home-seeds', 'home-seeds/discovery/sample/cover.webp', '{"size":123}'::jsonb)`,
    );

    const read = await asUser(db, null, async (tx) =>
      tx.query<{ name: string }>(
        "select name from storage.objects where bucket_id = 'home-seeds'",
      ),
    );
    expect(read.rows).toHaveLength(1);

    await expect(
      asUser(db, null, async (tx) =>
        tx.query(
          `insert into storage.objects (bucket_id, name) values ('home-seeds', 'home-seeds/anon.webp')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("case 4: authenticated cannot write either, service_role still can", async () => {
    const userId = "00000000-0000-0000-0000-0000000000f1";
    await db.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      "seed-writer@hahart.test",
    ]);

    await expect(
      asUser(db, userId, async (tx) =>
        tx.query(
          `insert into storage.objects (bucket_id, name) values ('home-seeds', 'home-seeds/auth.webp')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // The operator path must stay open, or nothing could ever publish a seed.
    const uploaded = await asServiceRole(db, async (tx) =>
      tx.query<{ name: string }>(
        `insert into storage.objects (bucket_id, name) values ('home-seeds', 'home-seeds/op.webp')
         returning name`,
      ),
    );
    expect(uploaded.rows).toHaveLength(1);
  });

  it("case 5: project-assets is untouched — still public, still the only copy", async () => {
    const bucket = firstRow(
      (
        await db.query<{ public: boolean }>(
          "select public from storage.buckets where id = 'project-assets'",
        )
      ).rows,
    );
    expect(bucket.public).toBe(true);
  });

  it("case 6: the migration is part of the applied set", () => {
    expect(applied).toContain(SEED_MIGRATION);
  });
});
