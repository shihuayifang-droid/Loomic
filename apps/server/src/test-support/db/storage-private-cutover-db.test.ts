// X-52 stage 1C (工单18 T1/T3/T4): the FINAL private storage target, and the rollback
// that puts it back.
//
// WHAT THIS FILE PINS, AND WHY EACH PIECE IS HERE
//   * The cutover migration must land as the 40th migration and stay in sync with the
//     directory — a new migration that silently is not applied buys nothing.
//   * The three bucket `public` values are the whole point: `project-assets` and the
//     legacy `canvases` bucket go private, `home-seeds` stays public because the home
//     page, example library and discovery library are all anonymous.
//   * `canvases` must keep exactly ONE read policy, and that policy's only authority is
//     a precise `asset_objects` row the CALLER can see. `storage.objects.owner` must NOT
//     be an authority: an object whose owner matches but which has no metadata row is
//     invisible to everyone, including its uploader. That is the "do not guess ownership
//     from the path" rule made observable.
//   * `project-assets` must come out of the cutover with its policy set unweakened — a
//     private bucket with no reader policy is the worst state this ticket can produce.
//   * The rollback must be lossless: it flips bucket publicity and canvases policies
//     only, so every object and every metadata row must survive it, and re-applying the
//     cutover afterwards must still work.
//
// WHAT THIS CANNOT PROVE (do not claim otherwise in the 回传): PGlite is not the storage
// API. Real public HTTP endpoints, real signed URLs, the owner column being written by
// the storage API, CDN transforms, backups and true concurrency are all out of reach here.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
const ROLLBACKS_DIR = join(REPO_ROOT, "supabase", "rollbacks");

const CUTOVER_MIGRATION = "20261013000002_hahart_storage_private_cutover.sql";
const ROLLBACK_FILE = "20261013000002_hahart_storage_private_cutover_rollback.sql";

const CUTOVER_SQL = readFileSync(join(MIGRATIONS_DIR, CUTOVER_MIGRATION), "utf8");
const ROLLBACK_SQL = readFileSync(join(ROLLBACKS_DIR, ROLLBACK_FILE), "utf8");

/** The author of the project: owns the mapped canvas object. */
const AUTHOR = "00000000-0000-0000-0000-0000000000a1";
/** A plain member of the team workspace, with no relation to the project. */
const UNRELATED_MEMBER = "00000000-0000-0000-0000-0000000000b1";
/** Not a member of the team workspace at all. */
const NON_MEMBER = "00000000-0000-0000-0000-0000000000c1";
/** Team admin: may READ every project in the workspace (Q2: read-only). */
const TEAM_ADMIN = "00000000-0000-0000-0000-0000000000d1";

const MAPPED_KEY = "canvases/team-project/mapped.png";
const UNMAPPED_KEY = "canvases/team-project/unmapped.png";
const SEED_KEY = "home-seeds/library/one.webp";

let db: PGlite;
let applied: string[] = [];
let teamWorkspace = "";
let projectId = "";

type BucketState = { id: string; public: boolean };
type Policy = { policyname: string; cmd: string; roles: string[] };
type Counts = { objects: number; assets: number; canvasAssets: number };

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** Run `fn` as service_role — the identity the operator publishes seeds with. */
async function asServiceRole<T>(
  database: PGlite,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return fn(tx);
  });
}

/** The `public` value of the three buckets this ticket is about, in a stable order. */
async function bucketStates(): Promise<BucketState[]> {
  const result = await db.query<BucketState>(
    `select id, public
       from storage.buckets
      where id in ('project-assets', 'canvases', 'home-seeds')
      order by id`,
  );
  return result.rows;
}

/** Every policy that mentions the `canvases` bucket, by name. */
async function canvasesPolicies(): Promise<Policy[]> {
  const result = await db.query<Policy>(
    `select policyname, cmd, roles
       from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and (coalesce(qual, '') || coalesce(with_check, '')) like '%canvases%'
      order by policyname`,
  );
  return result.rows;
}

/** Object names a given identity can actually see through RLS. */
async function visibleNames(
  userId: string | null,
  bucket: string,
): Promise<string[]> {
  const result = await asUser(db, userId, async (tx) =>
    tx.query<{ name: string }>(
      "select name from storage.objects where bucket_id = $1 order by name",
      [bucket],
    ),
  );
  return result.rows.map((row) => row.name);
}

async function countRows(sql: string): Promise<number> {
  return firstRow((await db.query<{ n: number }>(sql)).rows).n;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  applied = created.applied;

  await createUser(db, AUTHOR, "cutover-author@hahart.test");
  await createUser(db, UNRELATED_MEMBER, "cutover-member@hahart.test");
  await createUser(db, NON_MEMBER, "cutover-stranger@hahart.test");
  await createUser(db, TEAM_ADMIN, "cutover-admin@hahart.test");

  // The single team workspace (a unique index allows exactly one) plus three roles:
  // owner (the project author), a plain member, and an admin who may read all projects.
  teamWorkspace = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', 'HaHart Team', $1) returning id`,
        [AUTHOR],
      )
    ).rows,
  ).id;

  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role)
     values ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'admin')`,
    [teamWorkspace, AUTHOR, UNRELATED_MEMBER, TEAM_ADMIN],
  );

  projectId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.projects (workspace_id, name, slug, created_by)
         values ($1, 'Team project', 'team-project', $2) returning id`,
        [teamWorkspace, AUTHOR],
      )
    ).rows,
  ).id;

  // The MAPPED legacy screenshot: a storage object plus a precise asset_objects row.
  // Its storage `owner` is deliberately a DIFFERENT user, so "readable" cannot be
  // explained by the owner column — only by the metadata row and asset_objects RLS.
  await db.query(
    `insert into storage.objects (bucket_id, name, owner, metadata)
     values ('canvases', $1, $2, '{"size":11}'::jsonb)`,
    [MAPPED_KEY, NON_MEMBER],
  );
  await db.query(
    `insert into public.asset_objects
       (workspace_id, project_id, bucket, object_path, created_by, mime_type, byte_size)
     values ($1, $2, 'canvases', $3, $4, 'image/png', 11)`,
    [teamWorkspace, projectId, MAPPED_KEY, AUTHOR],
  );

  // The UNMAPPED legacy screenshot, owned by the project author: the case that must be
  // denied to everyone, because `storage.objects.owner` is not proof of ownership.
  await db.query(
    `insert into storage.objects (bucket_id, name, owner, metadata)
     values ('canvases', $1, $2, '{"size":12}'::jsonb)`,
    [UNMAPPED_KEY, AUTHOR],
  );

  // One published home seed, which must stay anonymously readable.
  await db.query(
    `insert into storage.objects (bucket_id, name, metadata)
     values ('home-seeds', $1, '{"size":13}'::jsonb)`,
    [SEED_KEY],
  );
}, 120_000);

describe("X-52 final private storage cutover (工单18)", () => {
  it("case 1: the migration set grows from 39 to 40 and matches the directory", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
    expect(applied.length).toBe(40);
    expect(applied.length).toBe(files.length);
    expect(applied).toContain(CUTOVER_MIGRATION);
    // Applied last: a migration that lands out of order is not the cutover.
    expect(applied[applied.length - 1]).toBe(CUTOVER_MIGRATION);
  });

  it("case 2: the three buckets carry the final public values", async () => {
    expect(await bucketStates()).toEqual([
      { id: "canvases", public: false },
      { id: "home-seeds", public: true },
      { id: "project-assets", public: false },
    ]);
  });

  it("case 3: project-assets keeps its reader policy, its three write policies and no public SELECT", async () => {
    const policies = await db.query<Policy>(
      `select policyname, cmd, roles
         from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname in (
            'project_assets_select_metadata_reader',
            'project_assets_insert_member',
            'project_assets_update_owner',
            'project_assets_delete_owner'
          )
        order by cmd`,
    );

    expect(policies.rows.map((row) => [row.policyname, row.cmd])).toEqual([
      ["project_assets_delete_owner", "DELETE"],
      ["project_assets_insert_member", "INSERT"],
      ["project_assets_select_metadata_reader", "SELECT"],
      ["project_assets_update_owner", "UPDATE"],
    ]);

    // The reader is the signed-read path (工单13), still authenticated-only.
    const reader = firstRow(
      policies.rows.filter((row) => row.policyname === "project_assets_select_metadata_reader"),
    );
    expect(reader.roles).toContain("authenticated");
    expect(reader.roles).not.toContain("public");

    // And nothing about project-assets was opened to `public`.
    const publicPolicies = await db.query<{ policyname: string }>(
      `select policyname
         from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and 'public' = any(roles)
          and (coalesce(qual, '') || coalesce(with_check, '')) like '%project-assets%'`,
    );
    expect(publicPolicies.rows).toEqual([]);
  });

  it("case 4: canvases keeps exactly one SELECT policy and no authenticated write policy", async () => {
    const policies = await canvasesPolicies();

    expect(policies).toHaveLength(1);
    expect(policies[0]?.policyname).toBe("canvases_select_metadata_reader");
    expect(policies[0]?.cmd).toBe("SELECT");
    expect(policies[0]?.roles).toContain("authenticated");
    expect(policies[0]?.roles).not.toContain("public");

    // The two legacy policies are gone by name, and nothing replaced the write half.
    const legacy = await db.query<{ policyname: string }>(
      `select policyname
         from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname in ('canvases_select_public', 'canvases_insert_authenticated')`,
    );
    expect(legacy.rows).toEqual([]);

    const writes = await db.query<{ n: number }>(
      `select count(*)::int as n
         from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and cmd <> 'SELECT'
          and (coalesce(qual, '') || coalesce(with_check, '')) like '%canvases%'`,
    );
    expect(firstRow(writes.rows).n).toBe(0);
  });

  it("case 5: the project author reads the mapped canvas object — and only that one", async () => {
    // MAPPED_KEY alone: UNMAPPED_KEY is owned by this same user but has no metadata.
    expect(await visibleNames(AUTHOR, "canvases")).toEqual([MAPPED_KEY]);
  });

  it("case 6: a team admin/owner reads the mapped canvas object", async () => {
    expect(await visibleNames(TEAM_ADMIN, "canvases")).toEqual([MAPPED_KEY]);
  });

  it("case 7: an unrelated ordinary member cannot read it", async () => {
    expect(await visibleNames(UNRELATED_MEMBER, "canvases")).toEqual([]);
  });

  it("case 8: a non-member cannot read it", async () => {
    expect(await visibleNames(NON_MEMBER, "canvases")).toEqual([]);
  });

  it("case 9: an anonymous request cannot read it", async () => {
    expect(await visibleNames(null, "canvases")).toEqual([]);
  });

  it("case 10: an unmapped object is invisible to all five identities, owner column notwithstanding", async () => {
    const identities: Array<[string, string | null]> = [
      ["project author (is also storage.objects.owner)", AUTHOR],
      ["team admin", TEAM_ADMIN],
      ["unrelated member", UNRELATED_MEMBER],
      ["non-member", NON_MEMBER],
      ["anon", null],
    ];

    for (const [label, userId] of identities) {
      const names = await visibleNames(userId, "canvases");
      expect(names, label).not.toContain(UNMAPPED_KEY);
    }
  });

  it("case 11: home-seeds stays anonymously readable, closed to client writes and open to service_role", async () => {
    // Read: anon and authenticated both see the published seed.
    expect(await visibleNames(null, "home-seeds")).toEqual([SEED_KEY]);
    expect(await visibleNames(AUTHOR, "home-seeds")).toEqual([SEED_KEY]);

    // Write: neither client identity may insert.
    await expect(
      asUser(db, null, async (tx) =>
        tx.query(
          `insert into storage.objects (bucket_id, name) values ('home-seeds', 'home-seeds/anon.webp')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    await expect(
      asUser(db, AUTHOR, async (tx) =>
        tx.query(
          `insert into storage.objects (bucket_id, name) values ('home-seeds', 'home-seeds/auth.webp')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // The operator path must stay open, or no seed could ever be published.
    const uploaded = await asServiceRole(db, async (tx) =>
      tx.query<{ name: string }>(
        `insert into storage.objects (bucket_id, name) values ('home-seeds', 'home-seeds/op.webp')
         returning name`,
      ),
    );
    expect(uploaded.rows).toHaveLength(1);
  });

  it("case 12: a missing bucket aborts the migration instead of updating zero rows", async () => {
    const before = await bucketStates();

    await expect(
      db.transaction(async (tx) => {
        // The FK from storage.objects makes this order necessary inside the probe.
        await tx.exec("delete from storage.objects where bucket_id = 'canvases'");
        await tx.exec("delete from storage.buckets where id = 'canvases'");
        await tx.exec(CUTOVER_SQL);
      }),
    ).rejects.toThrow(/required bucket\(s\) missing: canvases/);

    // The aborted transaction rolled its own delete back too, so the probe is not
    // destructive — and no bucket value moved before the RAISE.
    expect(await bucketStates()).toEqual(before);
    expect(await countRows("select count(*)::int as n from storage.buckets where id = 'canvases'")).toBe(1);
  });

  it("case 13: replaying the cutover migration is idempotent", async () => {
    const bucketsBefore = await bucketStates();
    const policiesBefore = await canvasesPolicies();

    await db.exec(CUTOVER_SQL);

    expect(await bucketStates()).toEqual(bucketsBefore);
    expect(await canvasesPolicies()).toEqual(policiesBefore);

    // Exactly one bucket CHECK constraint, explicitly named, and it allows canvases.
    const constraints = await db.query<{ conname: string; def: string }>(
      `select c.conname, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class r on r.oid = c.conrelid
         join pg_namespace n on n.oid = r.relnamespace
        where n.nspname = 'public' and r.relname = 'asset_objects'
          and c.contype = 'c'
          and pg_get_constraintdef(c.oid) like '%bucket%'`,
    );
    expect(constraints.rows).toHaveLength(1);
    expect(constraints.rows[0]?.conname).toBe("asset_objects_bucket_check");
    expect(constraints.rows[0]?.def).toContain("canvases");
    expect(constraints.rows[0]?.def).toContain("project-assets");
    expect(constraints.rows[0]?.def).toContain("user-avatars");

    // The extended CHECK really accepts the legacy bucket and still refuses a stranger.
    const accepted = await db.query(
      `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
       values ($1, $2, 'canvases', 'canvases/team-project/replay-probe.png', $3) returning id`,
      [teamWorkspace, projectId, AUTHOR],
    );
    expect(accepted.rows).toHaveLength(1);
    await db.query("delete from public.asset_objects where object_path = 'canvases/team-project/replay-probe.png'");

    await expect(
      db.query(
        `insert into public.asset_objects (workspace_id, bucket, object_path, created_by)
         values ($1, 'home-seeds', 'home-seeds/nope.webp', $2)`,
        [teamWorkspace, AUTHOR],
      ),
    ).rejects.toThrow(/asset_objects_bucket_check/);
  });
});

describe("X-52 lossless rollback (工单18 T3)", () => {
  let countsBefore: Counts;
  let countsAfter: Counts;
  let policiesBeforeRollback: Policy[];

  beforeAll(async () => {
    policiesBeforeRollback = await canvasesPolicies();
    countsBefore = {
      objects: await countRows("select count(*)::int as n from storage.objects"),
      assets: await countRows("select count(*)::int as n from public.asset_objects"),
      canvasAssets: await countRows(
        "select count(*)::int as n from public.asset_objects where bucket = 'canvases'",
      ),
    };

    await db.exec(ROLLBACK_SQL);

    countsAfter = {
      objects: await countRows("select count(*)::int as n from storage.objects"),
      assets: await countRows("select count(*)::int as n from public.asset_objects"),
      canvasAssets: await countRows(
        "select count(*)::int as n from public.asset_objects where bucket = 'canvases'",
      ),
    };
  }, 60_000);

  it("case 14: rollback restores the pre-cutover public values and the two canvases policies", async () => {
    expect(await bucketStates()).toEqual([
      { id: "canvases", public: true },
      { id: "home-seeds", public: true },
      { id: "project-assets", public: true },
    ]);

    // The cutover-time policy is gone…
    expect(policiesBeforeRollback.map((row) => row.policyname)).toEqual([
      "canvases_select_metadata_reader",
    ]);

    // …and the two legacy policies are back, with their original shape.
    const restored = await canvasesPolicies();
    expect(restored.map((row) => [row.policyname, row.cmd])).toEqual([
      ["canvases_insert_authenticated", "INSERT"],
      ["canvases_select_public", "SELECT"],
    ]);
    const select = firstRow(
      restored.filter((row) => row.policyname === "canvases_select_public"),
    );
    expect(select.roles).toContain("public");
    const insert = firstRow(
      restored.filter((row) => row.policyname === "canvases_insert_authenticated"),
    );
    expect(insert.roles).toContain("authenticated");

    // project-assets and home-seeds policies are outside the rollback's scope.
    const untouched = await db.query<{ policyname: string }>(
      `select policyname
         from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname in (
            'project_assets_select_metadata_reader',
            'home_seeds_select_public'
          )
        order by policyname`,
    );
    expect(untouched.rows.map((row) => row.policyname)).toEqual([
      "home_seeds_select_public",
      "project_assets_select_metadata_reader",
    ]);
  });

  it("case 15: rollback deletes nothing — object and metadata counts are exactly equal", () => {
    expect(countsAfter).toEqual(countsBefore);
    expect(countsBefore.objects).toBeGreaterThan(0);
    expect(countsBefore.canvasAssets).toBeGreaterThan(0);
  });

  it("case 16: re-applying the cutover after a rollback still succeeds", async () => {
    await db.exec(CUTOVER_SQL);

    expect(await bucketStates()).toEqual([
      { id: "canvases", public: false },
      { id: "home-seeds", public: true },
      { id: "project-assets", public: false },
    ]);
    expect((await canvasesPolicies()).map((row) => row.policyname)).toEqual([
      "canvases_select_metadata_reader",
    ]);

    // The mapped object is readable again through the restored reader policy, and the
    // unmapped one is still denied — the round trip did not change the authorisation rule.
    expect(await visibleNames(AUTHOR, "canvases")).toEqual([MAPPED_KEY]);
    expect(await visibleNames(null, "canvases")).toEqual([]);
    expect(await visibleNames(AUTHOR, "home-seeds")).toEqual([
      SEED_KEY,
      "home-seeds/op.webp",
    ]);
  });
});
