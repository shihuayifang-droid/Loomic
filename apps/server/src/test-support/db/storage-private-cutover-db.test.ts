// X-52 stage 1C (工单18 T1/T3/T4; fixup F1~F4): the FINAL private storage target, the
// rollback that puts it back, and the drift gates that make both of them fail closed.
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
// FIXUP (工单18-fixup, B2/B3/B4 -> F1/F2/F3/F4) — the counter-examples below are the
// reason this file exists in this shape:
//   * F1: failure atomicity is proven at the SAME entry point the migration harness uses
//     (`db.exec(CUTOVER_SQL)`, NO surrounding `db.transaction()`), with a fault injected
//     in the MIDDLE of the batch, after `project-assets` and the CHECK have already been
//     touched. Wrapping the probe in an outer transaction (what this case used to do)
//     proves the test's transaction, not the runner's.
//   * F2: the bucket CHECK is replaced BY NAME, only when it binds the `bucket` column
//     alone and only for the two allowed value sets. An unrelated CHECK that merely
//     mentions `bucket` must survive — the old `pg_get_constraintdef LIKE '%bucket%'`
//     sweep deleted it.
//   * F3: `storage.objects` policies are gated fail-closed BEFORE any change: unknown
//     names, wrong cmd/roles, `USING(true)`, or a missing required policy abort the
//     migration with the state untouched. Policies are OR-combined, so one extra
//     `TO public USING (true)` row would silently defeat the strict reader below.
//   * F4: the rollback refuses to run when a required bucket is missing, instead of
//     "UPDATE 0 rows" and reporting a disaster recovery that never happened.
//
// WHAT THIS CANNOT PROVE (do not claim otherwise in the 回传): PGlite is not the storage
// API. Real public HTTP endpoints, real signed URLs, the owner column being written by
// the storage API, CDN transforms, backups and true concurrency are all out of reach here.
// PGlite is also not the real Supabase migration runner: F1 pins the behaviour of the
// same-shaped entry point (`db.exec` of one file, no outer transaction) and the
// statement-by-statement counter-example, not the hosted runner itself.
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

const BUCKET_CHECK = "asset_objects_bucket_check";

let db: PGlite;
let applied: string[] = [];
let teamWorkspace = "";
let projectId = "";

type BucketState = { id: string; public: boolean };
type Policy = { policyname: string; cmd: string; roles: string[] };
type PolicyRow = {
  policyname: string;
  permissive: string;
  cmd: string;
  roles: string[];
  qual: string;
  with_check: string;
};
type CheckRow = { conname: string; conkey: string; def: string };
type Counts = { objects: number; assets: number; canvasAssets: number };
type World = {
  buckets: BucketState[];
  policies: PolicyRow[];
  checks: CheckRow[];
  counts: Counts & { buckets: number };
};

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

const TARGET_BUCKETS: BucketState[] = [
  { id: "canvases", public: false },
  { id: "home-seeds", public: true },
  { id: "project-assets", public: false },
];

const PRE_CUTOVER_BUCKETS: BucketState[] = [
  { id: "canvases", public: true },
  { id: "home-seeds", public: true },
  { id: "project-assets", public: true },
];

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

async function constraintDef(conname: string): Promise<string> {
  const result = await db.query<{ def: string }>(
    `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_class r on r.oid = c.conrelid
       join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public' and r.relname = 'asset_objects' and c.conname = $1`,
    [conname],
  );
  return firstRow(result.rows).def;
}

/**
 * Everything the cutover migration and the rollback are allowed to touch, plus the row
 * counts they must never touch. A failed run must leave this byte-for-byte identical —
 * that is the whole claim of F1/F2/F3/F4, so the counter-examples compare this object
 * instead of one hand-picked column.
 */
async function worldSnapshot(): Promise<World> {
  const buckets = (
    await db.query<BucketState>("select id, public from storage.buckets order by id")
  ).rows;
  const policies = (
    await db.query<PolicyRow>(
      `select policyname, permissive, cmd, roles::text[] as roles,
              coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
         from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
        order by policyname`,
    )
  ).rows;
  const checks = (
    await db.query<CheckRow>(
      `select c.conname, c.conkey::text as conkey, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class r on r.oid = c.conrelid
         join pg_namespace n on n.oid = r.relnamespace
        where n.nspname = 'public' and r.relname = 'asset_objects' and c.contype = 'c'
        order by c.conname`,
    )
  ).rows;

  return {
    buckets,
    policies,
    checks,
    counts: {
      buckets: await countRows("select count(*)::int as n from storage.buckets"),
      objects: await countRows("select count(*)::int as n from storage.objects"),
      assets: await countRows("select count(*)::int as n from public.asset_objects"),
      canvasAssets: await countRows(
        "select count(*)::int as n from public.asset_objects where bucket = 'canvases'",
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures for the drift counter-examples: the exact shapes the migration is
// allowed to accept, so a tamper can be undone without guessing.
// ---------------------------------------------------------------------------
const CHECK_NEW_SET =
  `${BUCKET_CHECK} check (bucket in ('project-assets', 'user-avatars', 'canvases'))`;
const CHECK_OLD_SET =
  `${BUCKET_CHECK} check (bucket in ('project-assets', 'user-avatars'))`;
const PROBE_CHECK = "asset_objects_wo18_probe_check";
const PROBE_DENIED_KEY = "canvases/team-project/probe-denied.png";

const RE_CANVASES_READER = `create policy "canvases_select_metadata_reader"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'canvases'
    and exists (
      select 1 from public.asset_objects a
       where a.bucket = storage.objects.bucket_id and a.object_path = storage.objects.name
    )
  )`;
const RE_PROJECT_ASSETS_UPDATE = `create policy "project_assets_update_owner"
  on storage.objects for update to authenticated
  using (bucket_id = 'project-assets'
    and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1])))
    and (owner = (select auth.uid())
         or (owner is null and (select private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1]))))))
  with check (bucket_id = 'project-assets'
    and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1]))))`;
const RE_PROJECT_ASSETS_DELETE = `create policy "project_assets_delete_owner"
  on storage.objects for delete to authenticated
  using (bucket_id = 'project-assets'
    and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1])))
    and (owner = (select auth.uid())
         or (owner is null and (select private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1]))))))`;
const RE_PROJECT_ASSETS_INSERT = `create policy "project_assets_insert_member"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'project-assets'
    and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1]))))`;
const RE_PROJECT_ASSETS_READER = `create policy "project_assets_select_metadata_reader"
  on storage.objects for select to authenticated
  using (bucket_id = 'project-assets'
    and (
      owner = (select auth.uid())
      or exists (
        select 1 from public.asset_objects a
         where a.bucket = storage.objects.bucket_id and a.object_path = storage.objects.name
      )
      or (
        owner is null
        and (select private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1])))
      )
    ))`;
const RE_HOME_SEEDS_PUBLIC = `create policy "home_seeds_select_public"
  on storage.objects for select to public using (bucket_id = 'home-seeds')`;

/** A fault injected INSIDE the migration batch: the third bucket update blows up. */
const FAULT_UP = `
create function public.zz_wo18_fault() returns trigger language plpgsql as $zz$
begin
  if old.public and not new.public and new.id = 'canvases' then
    raise exception 'zz_wo18_fault: refusing to privatise canvases';
  end if;
  return new;
end $zz$;
create trigger zz_wo18_fault before update on storage.buckets
  for each row execute function public.zz_wo18_fault();
`;
const FAULT_DOWN =
  "drop trigger zz_wo18_fault on storage.buckets; drop function public.zz_wo18_fault();";

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
    expect(await bucketStates()).toEqual(TARGET_BUCKETS);
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

  it("case 12: a mid-batch failure leaves bucket, CHECK and policy state untouched without any outer transaction", async () => {
    // Start from the pre-cutover state, so every step of the batch has something real to
    // do before the injected fault fires — and so "nothing changed" is a claim with teeth.
    await db.exec(ROLLBACK_SQL);
    expect(await bucketStates()).toEqual(PRE_CUTOVER_BUCKETS);

    // The CHECK goes back to the old value set as well. It is added NOT VALID because the
    // suite already contains `canvases` metadata rows; the migration must still recognise
    // it as the old set and rewrite it (that is F2's "only the old set is dropped").
    await db.exec(
      `alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_OLD_SET} not valid;`,
    );
    expect(await constraintDef(BUCKET_CHECK)).toContain("NOT VALID");

    const before = await worldSnapshot();

    // The fault fires on the THIRD bucket update, i.e. after the CHECK step and after
    // `project-assets` has already been flipped to private. A runner that commits each
    // statement separately would leave exactly those two changes behind.
    await db.exec(FAULT_UP);

    // THE POINT OF THIS CASE: no `db.transaction()` wrapper. `db.exec(sql)` is the same
    // shaped entry point the migration harness uses for a single migration file.
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /zz_wo18_fault: refusing to privatise canvases/,
    );

    await db.exec(FAULT_DOWN);

    expect(await worldSnapshot()).toEqual(before);

    // The batch was not merely inert: with the fault removed the same file applies.
    await db.exec(CUTOVER_SQL);
    expect(await bucketStates()).toEqual(TARGET_BUCKETS);
    expect(await constraintDef(BUCKET_CHECK)).toContain("canvases");
    expect(await constraintDef(BUCKET_CHECK)).not.toContain("NOT VALID");
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
    expect(constraints.rows[0]?.conname).toBe(BUCKET_CHECK);
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
    expect(await bucketStates()).toEqual(PRE_CUTOVER_BUCKETS);

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

    expect(await bucketStates()).toEqual(TARGET_BUCKETS);
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

// ---------------------------------------------------------------------------
// F2 (CHECK scope) / F3 (policy drift) / F4 (rollback fail-loud).
//
// Every counter-example is stated as: tamper -> the migration (or rollback) must abort ->
// the WHOLE world snapshot must be identical to the tampered state (nothing was
// half-applied) -> the tamper is undone and the snapshot returns to the reference state.
// The last step is not decoration: it is what makes the next case's "nothing changed"
// meaningful, and it proves the reference state itself is reachable.
// ---------------------------------------------------------------------------
describe("X-52 cutover drift gates (工单18 fixup F2/F3/F4)", () => {
  it("case 17: a CHECK that merely mentions bucket survives the cutover and stays enforced", async () => {
    const before = await worldSnapshot();

    // Cross-column (bucket + object_path), and its definition text contains 'bucket' —
    // exactly what the old `pg_get_constraintdef LIKE '%bucket%'` sweep used to delete.
    await db.exec(
      `alter table public.asset_objects add constraint ${PROBE_CHECK}
         check (not (bucket = 'canvases' and object_path = '${PROBE_DENIED_KEY}'))`,
    );
    const injected = await worldSnapshot();
    expect(injected.checks.map((row) => row.conname)).toContain(PROBE_CHECK);

    await db.exec(CUTOVER_SQL);

    expect(await worldSnapshot()).toEqual(injected);
    expect((await constraintDef(PROBE_CHECK)).length).toBeGreaterThan(0);

    // Still enforced, not just still present.
    await expect(
      db.query(
        `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
         values ($1, $2, 'canvases', $3, $4)`,
        [teamWorkspace, projectId, PROBE_DENIED_KEY, AUTHOR],
      ),
    ).rejects.toThrow(new RegExp(PROBE_CHECK));

    await db.exec(`alter table public.asset_objects drop constraint ${PROBE_CHECK}`);
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 18: the named bucket CHECK is rewritten from the allowed old set, and only from it", async () => {
    const before = await worldSnapshot();
    expect(await constraintDef(BUCKET_CHECK)).toContain("canvases");

    await db.exec(
      `alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_OLD_SET} not valid;`,
    );

    await db.exec(CUTOVER_SQL);

    // Old set -> dropped and recreated as the new set (and now validated).
    const rewritten = await constraintDef(BUCKET_CHECK);
    expect(rewritten).toContain("canvases");
    expect(rewritten).not.toContain("NOT VALID");
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 19: an unexpected value set in the named CHECK aborts the cutover untouched", async () => {
    const before = await worldSnapshot();

    await db.exec(
      `alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${BUCKET_CHECK}
         check (bucket in ('project-assets', 'user-avatars', 'canvases', 'legacy-thumbs')) not valid;`,
    );
    const tampered = await worldSnapshot();
    expect(tampered).not.toEqual(before);

    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /unexpected asset_objects_bucket_check bucket set/,
    );

    expect(await worldSnapshot()).toEqual(tampered);

    await db.exec(
      `alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_NEW_SET};`,
    );
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 20: missing, renamed-duplicate or multi-column bucket CHECKs abort the cutover", async () => {
    const before = await worldSnapshot();

    // (a) the named CHECK is bound to a second column as well.
    await db.exec(
      `alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${BUCKET_CHECK}
         check (bucket in ('project-assets', 'user-avatars', 'canvases')
                and object_path is not null);`,
    );
    let tampered = await worldSnapshot();
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /asset_objects_bucket_check is bound to columns/,
    );
    expect(await worldSnapshot()).toEqual(tampered);
    await db.exec(
      `alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_NEW_SET};`,
    );
    expect(await worldSnapshot()).toEqual(before);

    // (b) a second CHECK that constrains the bucket column alone, under another name.
    await db.exec(
      `alter table public.asset_objects add constraint asset_objects_wo18_dup_check
         check (bucket in ('project-assets', 'user-avatars', 'canvases'));`,
    );
    tampered = await worldSnapshot();
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /CHECK constraints on asset_objects are bound to the bucket column alone/,
    );
    expect(await worldSnapshot()).toEqual(tampered);
    await db.exec("alter table public.asset_objects drop constraint asset_objects_wo18_dup_check");
    expect(await worldSnapshot()).toEqual(before);

    // (c) the named CHECK is gone entirely.
    await db.exec(`alter table public.asset_objects drop constraint ${BUCKET_CHECK}`);
    tampered = await worldSnapshot();
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /CHECK asset_objects_bucket_check is missing/,
    );
    expect(await worldSnapshot()).toEqual(tampered);
    await db.exec(
      `alter table public.asset_objects add constraint ${CHECK_NEW_SET};`,
    );
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 21: an unknown policy on storage.objects aborts the cutover untouched", async () => {
    const before = await worldSnapshot();

    // No bucket literal anywhere in it, so "search the expressions for canvases" would
    // miss it entirely — but PostgreSQL OR-combines permissive policies, so this single
    // row would make every private-bucket read public.
    await db.exec(
      `create policy "rogue_storage_public" on storage.objects for select to public using (true)`,
    );
    const tampered = await worldSnapshot();
    expect(tampered).not.toEqual(before);

    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /unknown policy on storage.objects: rogue_storage_public/,
    );

    // The drift itself is left alone — no silent cleanup — and nothing else moved.
    expect(await worldSnapshot()).toEqual(tampered);

    await db.exec(`drop policy "rogue_storage_public" on storage.objects`);
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 22: a known policy widened with USING(true) or a wrong role/cmd aborts the cutover", async () => {
    const before = await worldSnapshot();

    // (a) right name, right cmd, but opened to `public` with an unconditional true.
    await db.exec(`drop policy "canvases_select_metadata_reader" on storage.objects`);
    await db.exec(`create policy "canvases_select_metadata_reader" on storage.objects for select to public using (true)`);
    let tampered = await worldSnapshot();
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /policy canvases_select_metadata_reader has roles/,
    );
    expect(await worldSnapshot()).toEqual(tampered);

    // (b) right name and roles, unconditional true.
    await db.exec(`drop policy "canvases_select_metadata_reader" on storage.objects`);
    await db.exec(`create policy "canvases_select_metadata_reader" on storage.objects for select to authenticated using (true)`);
    tampered = await worldSnapshot();
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /policy canvases_select_metadata_reader is unconditionally true/,
    );
    expect(await worldSnapshot()).toEqual(tampered);

    // (c) right name and roles, wrong command.
    await db.exec(`drop policy "canvases_select_metadata_reader" on storage.objects`);
    await db.exec(`create policy "canvases_select_metadata_reader" on storage.objects for delete to authenticated using (bucket_id = 'canvases')`);
    tampered = await worldSnapshot();
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /policy canvases_select_metadata_reader has cmd DELETE/,
    );
    expect(await worldSnapshot()).toEqual(tampered);

    await db.exec(`drop policy "canvases_select_metadata_reader" on storage.objects`);
    await db.exec(RE_CANVASES_READER);
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 23: a missing project-assets or home-seeds policy aborts the cutover untouched", async () => {
    const before = await worldSnapshot();

    const required: Array<[string, string]> = [
      ["project_assets_insert_member", RE_PROJECT_ASSETS_INSERT],
      ["project_assets_update_owner", RE_PROJECT_ASSETS_UPDATE],
      ["project_assets_delete_owner", RE_PROJECT_ASSETS_DELETE],
      ["project_assets_select_metadata_reader", RE_PROJECT_ASSETS_READER],
      ["home_seeds_select_public", RE_HOME_SEEDS_PUBLIC],
    ];

    for (const [policy, restore] of required) {
      await db.exec(`drop policy "${policy}" on storage.objects`);
      const tampered = await worldSnapshot();
      expect(tampered).not.toEqual(before);

      await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
        new RegExp(`required policy ${policy} is missing`),
      );
      expect(await worldSnapshot()).toEqual(tampered);

      await db.exec(restore);
      expect(await worldSnapshot()).toEqual(before);
    }
  });

  it("case 24: the normal old-state apply and the target-state replay still pass", async () => {
    const target = await worldSnapshot();

    await db.exec(ROLLBACK_SQL);
    expect(await bucketStates()).toEqual(PRE_CUTOVER_BUCKETS);
    expect((await canvasesPolicies()).map((row) => row.policyname)).toEqual([
      "canvases_insert_authenticated",
      "canvases_select_public",
    ]);

    // Old state -> apply (the preflight must accept the pre-cutover canvases pair).
    await db.exec(CUTOVER_SQL);
    expect(await worldSnapshot()).toEqual(target);

    // Target state -> replay (the preflight must accept the metadata reader).
    await db.exec(CUTOVER_SQL);
    expect(await worldSnapshot()).toEqual(target);
  });

  it("case 25: the rollback aborts loudly when a required bucket is missing", async () => {
    const before = await worldSnapshot();

    await db.exec("create table public._zz_wo18_buckets as select * from storage.buckets");
    await db.exec("create table public._zz_wo18_objects as select * from storage.objects");

    await db.exec("delete from storage.objects where bucket_id = 'home-seeds'");
    await db.exec("delete from storage.buckets where id = 'home-seeds'");
    const tampered = await worldSnapshot();
    expect(tampered).not.toEqual(before);

    await expect(db.exec(ROLLBACK_SQL)).rejects.toThrow(
      /X-52 storage rollback aborted: required bucket\(s\) missing: home-seeds/,
    );
    // The rollback opens its own BEGIN, so an aborted run leaves the session in the
    // aborted-transaction state until the caller rolls back — same as psql would.
    await db.exec("rollback");

    // "UPDATE 0 rows and commit" would have flipped the other two buckets to public and
    // swapped the canvases policies. Nothing of that may survive.
    expect(await worldSnapshot()).toEqual(tampered);

    await db.exec(
      "insert into storage.buckets select * from public._zz_wo18_buckets on conflict (id) do nothing",
    );
    await db.exec(
      "insert into storage.objects select * from public._zz_wo18_objects on conflict (id) do nothing",
    );
    await db.exec("drop table public._zz_wo18_buckets, public._zz_wo18_objects");
    expect(await worldSnapshot()).toEqual(before);
  });
});
