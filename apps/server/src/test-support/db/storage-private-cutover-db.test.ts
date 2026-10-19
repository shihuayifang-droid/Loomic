// X-52 stage 1C (工单18 T1/T3/T4; fixup F1~F4; fixup2 E1~E3): the FINAL private storage
// target, the rollback that puts it back, and the drift gates that make both fail closed.
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
//     touched.
//   * F2: the bucket CHECK is replaced BY NAME, only when it binds the `bucket` column
//     alone and only for the two allowed value sets. An unrelated CHECK that merely
//     mentions `bucket` must survive — the old `pg_get_constraintdef LIKE '%bucket%'`
//     sweep deleted it.
//   * F3: `storage.objects` policies are gated fail-closed BEFORE any change.
//   * F4: the rollback refuses to run when a required bucket is missing, instead of
//     "UPDATE 0 rows" and reporting a disaster recovery that never happened.
//
// FIXUP2 (工单18-fixup2, B1/B2/B3 -> E1/E2/E3) — the difference between "looks like the
// right policy" and "is the right policy":
//   * E1: the policy gate is EXPRESSION-level. It replays each repository `create policy`
//     as a throwaway probe policy on `storage.objects`, reads back `pg_get_expr` and
//     requires the real policy's USING and WITH CHECK to be textually identical, with
//     NULL (this command has no such side) landing on the same side. Substring checks
//     could not see any of these: a reader reduced to `bucket_id = 'project-assets'`, the
//     same reader widened with `OR auth.uid() IS NOT NULL`, or `canvases-archive` matching
//     a `position('canvases' in ...)` probe. Cases 26~30 are those counter-examples.
//   * E2: the bucket CHECK must be the exact static two-value or three-value expression
//     AND `convalidated`. `ARRAY['canvases','project-assets','user-avatars',bucket]`
//     keeps three correct literals while letting any value through, and a `NOT VALID`
//     target skips every existing row. Cases 31~32 are those counter-examples.
//   * E3: the statement-by-statement counter-example is IN this file, not in a throwaway
//     probe. Case 12b splits the same `CUTOVER_SQL` with a real splitter (strings,
//     comments and `$$` blocks) and commits each statement separately, showing that the
//     earlier statements really do land — which is what makes case 12's "nothing moved"
//     a claim with teeth.
//
// FIXUP3 (工单18-fixup3, B1 -> P1) — the E1 gate must not be carried by a GLOBAL object:
//   * P1: through fixup2 the expected expressions lived in two UNQUALIFIED composite types in
//     the default schema (`drop type if exists zz_wo18_policy; create type zz_wo18_policy ...`),
//     declared before the first preflight. On a database that already owns those names a
//     successful apply DESTROYS the real object, and one that has dependents aborts the whole
//     cutover. The carrier is a `jsonb` value now, which is not a schema object at all.
//     Cases 34~36 pin the pre-existing OID and attribute list, the fact that no non-temp
//     `zz_wo18*` object appears or disappears across apply/replay/failure, and the replayed
//     fixup2 DDL as the counter-example that fails both of those.
//
// WHAT THIS CANNOT PROVE (do not claim otherwise in the 回传): PGlite is not the storage
// API. Real public HTTP endpoints, real signed URLs, the owner column being written by
// the storage API, CDN transforms, backups and true concurrency are all out of reach here.
// PGlite is also not the real Supabase migration runner: F1 pins the behaviour of the
// same-shaped entry point (`db.exec` of one file, no outer transaction) and E3 pins the
// statement-by-statement counter-example, not the hosted runner itself.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
type CheckState = { def: string; convalidated: boolean };
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

/**
 * Split a migration file into statements the way a migration runner does: semicolons inside
 * single-quoted strings, inside `--` / block comments, and inside `$$`-quoted bodies do NOT
 * end a statement. Splitting naively on `;` would cut `do $$ ... $$;` blocks in half and the
 * statement-by-statement counter-example (case 12b) would prove nothing.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))?.[0];
      if (tag !== undefined) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) out.push(trimmed);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
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

/** The named CHECK's full text plus whether PostgreSQL actually enforces it. */
async function constraintState(conname: string): Promise<CheckState> {
  const result = await db.query<CheckState>(
    `select pg_get_constraintdef(c.oid) as def, c.convalidated
       from pg_constraint c
       join pg_class r on r.oid = c.conrelid
       join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public' and r.relname = 'asset_objects' and c.conname = $1`,
    [conname],
  );
  return firstRow(result.rows);
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
//
// The literal ORDER matters: the migration compares `pg_get_constraintdef` text exactly, and
// that text is whatever the recreated constraint carries — the order below is the one the
// repository's own `bucket in (...)` produces, not a re-sorted variant.
// ---------------------------------------------------------------------------
const CHECK_NEW_SET =
  `${BUCKET_CHECK} check (bucket in ('project-assets', 'user-avatars', 'canvases'))`;
const CHECK_OLD_SET =
  `${BUCKET_CHECK} check (bucket in ('project-assets', 'user-avatars'))`;
/** The exact definition text PostgreSQL renders for {@link CHECK_NEW_SET}. */
const CHECK_NEW_DEF =
  "CHECK ((bucket = ANY (ARRAY['project-assets'::text, 'user-avatars'::text, 'canvases'::text])))";
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

// ---------------------------------------------------------------------------
// E1 counter-example fixtures. Each is a REAL policy of an allowed name whose expression
// differs from the repository definition in exactly one way — the ways a substring check
// cannot see, because every one of them still "contains the bucket literal".
// ---------------------------------------------------------------------------
/** The reader with its authorization clauses deleted: only the bucket test survives. */
const TAMPER_READER_BUCKET_ONLY = `create policy "project_assets_select_metadata_reader"
  on storage.objects for select to authenticated
  using (bucket_id = 'project-assets')`;
/** The correct reader with `or auth.uid() is not null` appended outside the whole test. */
const TAMPER_READER_OR_UID = `create policy "project_assets_select_metadata_reader"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'project-assets'
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
    )
    or auth.uid() is not null
  )`;
/**
 * A bucket name that merely STARTS with `canvases`. `position('canvases' in qual) > 0` is
 * satisfied by this, so the old substring gate waved it through while the object it
 * describes lives in an entirely different bucket.
 */
const TAMPER_CANVASES_ARCHIVE = `create policy "canvases_select_metadata_reader"
  on storage.objects for select to authenticated
  using (bucket_id = 'canvases-archive')`;
/** The UPDATE policy with a correct USING and a gutted WITH CHECK. */
const TAMPER_UPDATE_WITH_CHECK = `create policy "project_assets_update_owner"
  on storage.objects for update to authenticated
  using (bucket_id = 'project-assets'
    and (select private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1])))
    and (owner = (select auth.uid())
         or (owner is null and (select private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1]))))))
  with check (bucket_id = 'project-assets')`;

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
  it("case 1: includes the cutover migration in order", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
    // 31B: total is pinned by the audit baseline (sql.migrations); here only "every file applied"
    expect(applied.length).toBe(files.length);
    // 31A: cutover is no longer the last migration; assert it is applied and ordered, not that it is last
    const cutoverIndex = applied.indexOf(CUTOVER_MIGRATION);
    expect(cutoverIndex).toBeGreaterThanOrEqual(0);
    expect(applied.slice(0, cutoverIndex).every((name) => name < CUTOVER_MIGRATION)).toBe(true);
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

    // The CHECK goes back to the old value set as well. fixup2 E2 requires the old form to be
    // VALIDATED too (the real baseline is), so this cannot be parked as `NOT VALID`: the
    // metadata rows that only the NEW set allows are moved aside for the duration and put
    // back afterwards. Nothing else in the suite depends on the fixture state at this point,
    // because this case restores the target state before it returns.
    await db.exec(
      `create table public._zz_wo18_assets_bak as
         select * from public.asset_objects where bucket = 'canvases';
       delete from public.asset_objects where bucket = 'canvases';
       alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_OLD_SET};`,
    );
    // A validated old set: not NOT VALID, and PostgreSQL is checking it.
    expect(await constraintState(BUCKET_CHECK)).toMatchObject({ convalidated: true });
    expect(await constraintDef(BUCKET_CHECK)).not.toContain("NOT VALID");

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

    // Put the temporarily stored metadata rows back and drop the scratch table.
    await db.exec(
      `insert into public.asset_objects select * from public._zz_wo18_assets_bak;
       drop table public._zz_wo18_assets_bak;`,
    );
  });

  it("case 12b: executing the SAME file statement by statement really does change the front of the batch", async () => {
    // fixup2 E3: this is the discriminating counterpart to case 12. Both use the identical
    // CUTOVER_SQL text, the identical fault and the identical starting state; the only
    // difference is the entry point. Case 12 proves the batch rolls back as a unit. This one
    // proves the earlier statements are NOT inert — which is what makes case 12's "nothing
    // moved" a claim rather than a tautology.
    const reference = await worldSnapshot();

    // Same pre-cutover setup as case 12, validated old CHECK included.
    await db.exec(ROLLBACK_SQL);
    expect(await bucketStates()).toEqual(PRE_CUTOVER_BUCKETS);
    await db.exec(
      `create table public._zz_wo18_assets_bak as
         select * from public.asset_objects where bucket = 'canvases';
       delete from public.asset_objects where bucket = 'canvases';
       alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_OLD_SET};`,
    );
    await db.exec(FAULT_UP);
    const before = await worldSnapshot();

    // The splitter is not naive: the migration's `do $$ ... $$;` guards contain semicolons
    // and would be torn in half by a plain `split(";")`. fixup3 removed the four standalone
    // `drop type` / `create type` statements that used to sit in front of the preflight block,
    // so "some statement begins with `do $$`" no longer describes this file — the check is the
    // direct one instead, and it is strictly harder to satisfy: every statement that opens a
    // `do $$` block must also be the statement that closes it.
    const statements = splitStatements(CUTOVER_SQL);
    expect(statements.length).toBeGreaterThan(10);
    const doBlocks = statements.filter((statement) => statement.includes("do $$"));
    expect(doBlocks.length).toBeGreaterThanOrEqual(5);
    expect(doBlocks.every((statement) => statement.endsWith("end $$"))).toBe(true);

    let executed = 0;
    let failure: unknown;
    for (const statement of statements) {
      try {
        await db.exec(statement);
        executed += 1;
      } catch (error) {
        failure = error;
        break;
      }
    }

    // The fault is the SECOND bucket update, so the four statements before it (both guards,
    // the CHECK rewrite, and the `project-assets` update) all committed before it.
    expect(String(failure)).toMatch(/zz_wo18_fault: refusing to privatise canvases/);

    // E3's required assertion: the front of the batch landed. `project-assets` is private and
    // the named CHECK now allows canvases — with a validated constraint, not a NOT VALID one.
    expect(await executed).toBeGreaterThan(0);
    expect((await bucketStates()).find((row) => row.id === "project-assets")?.public).toBe(false);
    expect((await bucketStates()).find((row) => row.id === "canvases")?.public).toBe(true);
    expect(await constraintState(BUCKET_CHECK)).toMatchObject({ convalidated: true });
    expect(await constraintDef(BUCKET_CHECK)).toContain("canvases");
    // Which is exactly what the whole-file entry point did NOT leave behind.
    expect(await worldSnapshot()).not.toEqual(before);

    await db.exec(FAULT_DOWN);

    // Restore the fixture completely, so no later case inherits a half-applied batch.
    await db.exec(ROLLBACK_SQL);
    await db.exec(
      `alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_NEW_SET};
       insert into public.asset_objects select * from public._zz_wo18_assets_bak;
       drop table public._zz_wo18_assets_bak;`,
    );
    await db.exec(CUTOVER_SQL);
    expect(await worldSnapshot()).toEqual(reference);
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

    // fixup2 E2: the old form must be VALIDATED as well, so the `canvases` metadata rows are
    // moved aside for the duration instead of parking the constraint as NOT VALID.
    await db.exec(
      `create table public._zz_wo18_assets_bak as
         select * from public.asset_objects where bucket = 'canvases';
       delete from public.asset_objects where bucket = 'canvases';
       alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_OLD_SET};`,
    );
    expect(await constraintState(BUCKET_CHECK)).toMatchObject({ convalidated: true });

    await db.exec(CUTOVER_SQL);

    // Old set -> dropped and recreated as the new set (validated, exact text).
    const rewritten = await constraintState(BUCKET_CHECK);
    expect(rewritten.convalidated).toBe(true);
    expect(rewritten.def).toBe(CHECK_NEW_DEF);

    await db.exec(
      `insert into public.asset_objects select * from public._zz_wo18_assets_bak;
       drop table public._zz_wo18_assets_bak;`,
    );
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
      /asset_objects_bucket_check is neither the exact static old set nor the exact static new set/,
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

    // (b) right name and roles, unconditional true. The expression gate names it as a
    // drift from the repository definition rather than as a special "true" shape, which is
    // strictly stronger: `true` is simply not the reader's expression.
    await db.exec(`drop policy "canvases_select_metadata_reader" on storage.objects`);
    await db.exec(`create policy "canvases_select_metadata_reader" on storage.objects for select to authenticated using (true)`);
    tampered = await worldSnapshot();
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /policy canvases_select_metadata_reader USING expression drifted from the repository definition\. actual=\[true\]/,
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

  // -------------------------------------------------------------------------
  // fixup2 E1: the gate must be EXPRESSION-level, not name + bucket-substring.
  //
  // Every tamper below keeps an allowed policy name and still contains the bucket literal,
  // so the previous shape gate accepted all four. Each one is OR-combined with the real
  // policies by PostgreSQL, which is why accepting any of them means the private bucket is
  // not actually private.
  // -------------------------------------------------------------------------
  it("case 26: a metadata reader stripped to its bucket condition aborts the cutover", async () => {
    const before = await worldSnapshot();

    await db.exec(`drop policy "project_assets_select_metadata_reader" on storage.objects`);
    await db.exec(TAMPER_READER_BUCKET_ONLY);
    const tampered = await worldSnapshot();
    expect(tampered).not.toEqual(before);

    // This is the tamper the old "non-true + contains the bucket string" gate accepted.
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /policy project_assets_select_metadata_reader USING expression drifted from the repository definition/,
    );
    expect(await worldSnapshot()).toEqual(tampered);

    await db.exec(`drop policy "project_assets_select_metadata_reader" on storage.objects`);
    await db.exec(RE_PROJECT_ASSETS_READER);
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 27: an OR auth.uid() IS NOT NULL appended to the reader aborts the cutover", async () => {
    const before = await worldSnapshot();

    await db.exec(`drop policy "project_assets_select_metadata_reader" on storage.objects`);
    await db.exec(TAMPER_READER_OR_UID);
    const tampered = await worldSnapshot();
    expect(tampered).not.toEqual(before);

    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /policy project_assets_select_metadata_reader USING expression drifted from the repository definition/,
    );
    expect(await worldSnapshot()).toEqual(tampered);

    await db.exec(`drop policy "project_assets_select_metadata_reader" on storage.objects`);
    await db.exec(RE_PROJECT_ASSETS_READER);
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 28: a canvases-archive bucket name is not a substring false hit", async () => {
    const before = await worldSnapshot();

    await db.exec(`drop policy "canvases_select_metadata_reader" on storage.objects`);
    await db.exec(TAMPER_CANVASES_ARCHIVE);
    const tampered = await worldSnapshot();
    expect(tampered).not.toEqual(before);

    // `position('canvases' in qual) > 0` is satisfied by 'canvases-archive'; the expression
    // comparison is not. The policy's own bucket is now a different bucket entirely.
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /policy canvases_select_metadata_reader USING expression drifted from the repository definition/,
    );
    expect(await worldSnapshot()).toEqual(tampered);

    await db.exec(`drop policy "canvases_select_metadata_reader" on storage.objects`);
    await db.exec(RE_CANVASES_READER);
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 29: tampering only the WITH CHECK half of an UPDATE policy aborts the cutover", async () => {
    const before = await worldSnapshot();

    await db.exec(`drop policy "project_assets_update_owner" on storage.objects`);
    await db.exec(TAMPER_UPDATE_WITH_CHECK);
    const tampered = await worldSnapshot();
    expect(tampered).not.toEqual(before);

    // USING is untouched and correct; only the WITH CHECK side was gutted. A gate that looks
    // at one expression per policy — or that only looks at USING — would miss this.
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /policy project_assets_update_owner WITH CHECK expression drifted from the repository definition/,
    );
    expect(await worldSnapshot()).toEqual(tampered);

    await db.exec(`drop policy "project_assets_update_owner" on storage.objects`);
    await db.exec(RE_PROJECT_ASSETS_UPDATE);
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 30: a tampered LEGACY canvases policy is rejected before the cutover runs", async () => {
    const before = await worldSnapshot();

    await db.exec(ROLLBACK_SQL);
    expect((await canvasesPolicies()).map((row) => row.policyname)).toEqual([
      "canvases_insert_authenticated",
      "canvases_select_public",
    ]);

    // The legacy public reader widened to a second bucket. Still `to public`, still contains
    // the literal `canvases`, and it would silently open `project-assets` as well.
    await db.exec(`drop policy "canvases_select_public" on storage.objects`);
    await db.exec(
      `create policy "canvases_select_public" on storage.objects for select to public
         using (bucket_id = 'canvases' or bucket_id = 'project-assets')`,
    );
    const tampered = await worldSnapshot();

    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /policy canvases_select_public USING expression drifted from the repository definition/,
    );
    expect(await worldSnapshot()).toEqual(tampered);

    // Back to the target: rollback restores both legacy policies, then the cutover consumes
    // them again.
    await db.exec(ROLLBACK_SQL);
    await db.exec(CUTOVER_SQL);
    expect(await worldSnapshot()).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // fixup2 E2: the bucket CHECK must be the exact STATIC expression and validated.
  // -------------------------------------------------------------------------
  it("case 31: a CHECK with three legal literals plus a dynamic element aborts the cutover", async () => {
    const before = await worldSnapshot();

    // The literals a naive extractor looks for are all present and correct. The trailing
    // `bucket` is a column reference, so the constraint accepts ANY value whatsoever.
    await db.exec(
      `alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${BUCKET_CHECK}
         check (bucket = any (array['canvases', 'project-assets', 'user-avatars', bucket]))`,
    );
    const tampered = await worldSnapshot();
    expect(tampered).not.toEqual(before);
    expect((await constraintDef(BUCKET_CHECK))).toContain(", bucket]");

    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /asset_objects_bucket_check is neither the exact static old set nor the exact static new set/,
    );
    expect(await worldSnapshot()).toEqual(tampered);

    // And the accepted set really is unbounded: a value outside every allowed bucket passes.
    const accepted = await db.query(
      `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
       values ($1, $2, 'anything-at-all', 'canvases/team-project/dynamic-probe.png', $3) returning id`,
      [teamWorkspace, projectId, AUTHOR],
    );
    expect(accepted.rows).toHaveLength(1);
    await db.query(
      "delete from public.asset_objects where object_path = 'canvases/team-project/dynamic-probe.png'",
    );

    await db.exec(
      `alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_NEW_SET};`,
    );
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 32: a NOT VALID target CHECK aborts the cutover", async () => {
    const before = await worldSnapshot();

    // The three-value target expression, correct in every character, but PostgreSQL is not
    // enforcing it — `NOT VALID` means every pre-existing row was skipped.
    await db.exec(
      `alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_NEW_SET} not valid;`,
    );
    const tampered = await worldSnapshot();
    expect(tampered).not.toEqual(before);
    expect(await constraintState(BUCKET_CHECK)).toMatchObject({ convalidated: false });
    expect(await constraintDef(BUCKET_CHECK)).toContain("NOT VALID");

    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /asset_objects_bucket_check \(form=new\) is NOT VALID; the cutover requires a validated constraint/,
    );
    expect(await worldSnapshot()).toEqual(tampered);

    await db.exec(
      `alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_NEW_SET};`,
    );
    expect(await worldSnapshot()).toEqual(before);
  });

  it("case 33: a re-validated old CHECK is rewritten and the target comes out validated", async () => {
    const before = await worldSnapshot();

    // The old two-value set, VALIDATED — which is what the real pre-cutover baseline carries.
    // This is the legitimate old state; the cutover must rewrite it rather than reject it,
    // and it must not leave any trace of the temporary metadata relocation behind.
    await db.exec(
      `create table public._zz_wo18_assets_bak as
         select * from public.asset_objects where bucket = 'canvases';
       delete from public.asset_objects where bucket = 'canvases';
       alter table public.asset_objects drop constraint ${BUCKET_CHECK};
       alter table public.asset_objects add constraint ${CHECK_OLD_SET};`,
    );
    expect(await constraintState(BUCKET_CHECK)).toMatchObject({ convalidated: true });

    await db.exec(CUTOVER_SQL);

    const rewritten = await constraintState(BUCKET_CHECK);
    expect(rewritten.convalidated).toBe(true);
    expect(rewritten.def).toBe(CHECK_NEW_DEF);

    await db.exec(
      `insert into public.asset_objects select * from public._zz_wo18_assets_bak;
       drop table public._zz_wo18_assets_bak;`,
    );
    expect(await worldSnapshot()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// fixup3 B1: the probe carrier must not occupy, replace or drop a GLOBAL object.
//
// fixup2 opened the migration with two UNQUALIFIED composite types in the default schema
// (`drop type if exists zz_wo18_policy; create type zz_wo18_policy ...`) and dropped them
// again after the preflight block. On a database that already owns those names that is either
// a silent loss of a non-target object or an unexpected abort. The gate is the same migration
// with a `jsonb` carrier; the counter-example is the fixup2 DDL, transcribed verbatim from
// `git show e585fa8:supabase/migrations/20261013000002_hahart_storage_private_cutover.sql`.
// ---------------------------------------------------------------------------

/** The fixup2 (e585fa8) carrier, verbatim: unqualified DDL, before the first preflight. */
const FIXUP2_PROBE_DDL = `drop type if exists zz_wo18_expect;
drop type if exists zz_wo18_policy;
create type zz_wo18_policy
  as (p_name text, p_tail text, p_bucket text, p_cmd text);
create type zz_wo18_expect
  as (p_name text, p_bucket text, p_cmd text, p_expect_qual text, p_expect_wc text);`;

/** The fixup2 file's own cleanup of those two types, after the preflight block. */
const FIXUP2_PROBE_CLEANUP = `drop type zz_wo18_policy;
drop type zz_wo18_expect;`;

/**
 * A pre-existing BUSINESS type of the same name, deliberately a DIFFERENT shape from the one
 * fixup2 declares: a takeover then shows up in both the OID and the attribute list, which is
 * what makes "the definition did not change" a claim with teeth.
 */
const PREEXISTING_TYPE_FIXTURE = `create type public.zz_wo18_policy
  as (tenant_id uuid, policy_key text, revision integer);
create type public.zz_wo18_expect
  as (expect_id bigint, note text);`;
const PREEXISTING_TYPE_DROP = `drop type public.zz_wo18_expect;
drop type public.zz_wo18_policy;`;

/** A business table that DEPENDS on both types: the state fixup2 cannot run in at all. */
const PREEXISTING_TYPE_DEPENDENT = `create table public.zz_wo18_business (
  id integer primary key,
  payload public.zz_wo18_policy,
  meta public.zz_wo18_expect
);
insert into public.zz_wo18_business (id, payload, meta)
values (
  1,
  row('00000000-0000-0000-0000-0000000000a1'::uuid, 'canvases', 7)::public.zz_wo18_policy,
  row(42::bigint, 'kept')::public.zz_wo18_expect
);`;
const PREEXISTING_TYPE_DEPENDENT_DROP = "drop table public.zz_wo18_business";

type TypeAttribute = { attnum: number; name: string; type: string; notnull: boolean };
type CompositeTypeState = { oid: string; name: string; attributes: TypeAttribute[] };
type ProbeResidue = { types: string[]; relations: string[]; policies: string[] };

const NO_RESIDUE: ProbeResidue = { types: [], relations: [], policies: [] };

/** OID plus the full attribute list of a `public` composite type, or undefined when absent. */
async function compositeTypeState(typeName: string): Promise<CompositeTypeState | undefined> {
  const type = (
    await db.query<{ oid: string; name: string }>(
      `select t.oid::text as oid, t.typname as name
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typname = $1`,
      [typeName],
    )
  ).rows[0];
  if (type === undefined) return undefined;

  const attributes = (
    await db.query<TypeAttribute>(
      `select a.attnum, a.attname as name,
              format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull
         from pg_attribute a
         join pg_type t on t.typrelid = a.attrelid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typname = $1
          and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
      [typeName],
    )
  ).rows;

  return { oid: type.oid, name: type.name, attributes };
}

/** The dependent business row, rendered to text so a round trip can be compared exactly. */
async function businessRowText(): Promise<string> {
  return firstRow(
    (
      await db.query<{ business_row: string }>(
        `select payload::text || '|' || meta::text as business_row
           from public.zz_wo18_business where id = 1`,
      )
    ).rows,
  ).business_row;
}

/**
 * Every `zz_wo18*` object a migration could leak into a NON-temp schema — types, relations
 * and policies. The cutover is allowed to own nothing outside its three buckets, one CHECK
 * and the canvases policies, so a successful run, a replay and a rolled-back failure must
 * all leave this set exactly as they found it.
 */
async function probeResidue(): Promise<ProbeResidue> {
  const types = await db.query<{ name: string }>(
    `select n.nspname || '.' || t.typname as name
       from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
      where t.typname like 'zz_wo18%'
        and n.nspname not like 'pg_temp%'
        and n.nspname not like 'pg_toast%'
      order by 1`,
  );
  const relations = await db.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relname like 'zz_wo18%'
        and n.nspname not like 'pg_temp%'
        and n.nspname not like 'pg_toast%'
      order by 1`,
  );
  const policies = await db.query<{ name: string }>(
    `select n.nspname || '.' || c.relname || '.' || p.polname as name
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
      where p.polname like 'zz_wo18%'
      order by 1`,
  );
  return {
    types: types.rows.map((row) => row.name),
    relations: relations.rows.map((row) => row.name),
    policies: policies.rows.map((row) => row.name),
  };
}

describe("X-52 probe carrier must not touch global objects (工单18 fixup3 B1)", () => {
  it("case 34: pre-existing public zz_wo18_* types with dependents keep their OID, attributes and data across apply and replay", async () => {
    await db.exec(PREEXISTING_TYPE_FIXTURE);
    await db.exec(PREEXISTING_TYPE_DEPENDENT);

    const policyBefore = await compositeTypeState("zz_wo18_policy");
    const expectBefore = await compositeTypeState("zz_wo18_expect");
    const rowBefore = await businessRowText();
    // The fixture really is a different shape from fixup2's carrier, and really holds data.
    expect(policyBefore?.attributes.map((row) => row.name)).toEqual([
      "tenant_id",
      "policy_key",
      "revision",
    ]);
    expect(expectBefore?.attributes.map((row) => row.name)).toEqual(["expect_id", "note"]);
    expect(rowBefore).toContain("canvases");

    // A REAL apply (from the legacy state), then a replay: both must be transparent to a
    // database that already owns these names — fixup2 aborted on exactly this state.
    await db.exec(ROLLBACK_SQL);
    expect(await bucketStates()).toEqual(PRE_CUTOVER_BUCKETS);
    await db.exec(CUTOVER_SQL);
    expect(await bucketStates()).toEqual(TARGET_BUCKETS);

    expect(await compositeTypeState("zz_wo18_policy")).toEqual(policyBefore);
    expect(await compositeTypeState("zz_wo18_expect")).toEqual(expectBefore);
    expect(await businessRowText()).toBe(rowBefore);

    await db.exec(CUTOVER_SQL);
    expect(await compositeTypeState("zz_wo18_policy")).toEqual(policyBefore);
    expect(await compositeTypeState("zz_wo18_expect")).toEqual(expectBefore);
    expect(await businessRowText()).toBe(rowBefore);

    // The fixture leaves with this case.
    await db.exec(PREEXISTING_TYPE_DEPENDENT_DROP);
    await db.exec(PREEXISTING_TYPE_DROP);
    expect(await compositeTypeState("zz_wo18_policy")).toBeUndefined();
    expect(await compositeTypeState("zz_wo18_expect")).toBeUndefined();
    expect(await probeResidue()).toEqual(NO_RESIDUE);
  });

  it("case 35: apply, replay and a rolled-back failure neither add nor remove a non-temp zz_wo18_* object", async () => {
    await db.exec(PREEXISTING_TYPE_FIXTURE);

    // The checker is not vacuous: it SEES the two pre-existing objects (a composite type also
    // shows up in `pg_class` under its own name), and it sees no probe policy at rest.
    const baseline = await probeResidue();
    expect(baseline).toEqual({
      types: ["public.zz_wo18_expect", "public.zz_wo18_policy"],
      relations: ["public.zz_wo18_expect", "public.zz_wo18_policy"],
      policies: [],
    });

    await db.exec(CUTOVER_SQL);
    expect(await probeResidue()).toEqual(baseline);
    await db.exec(CUTOVER_SQL);
    expect(await probeResidue()).toEqual(baseline);

    // The failure path: same entry point as case 12, from the legacy state, with the fault
    // firing after the preflight has already created (and dropped) every probe policy.
    await db.exec(ROLLBACK_SQL);
    expect(await bucketStates()).toEqual(PRE_CUTOVER_BUCKETS);
    await db.exec(FAULT_UP);
    await expect(db.exec(CUTOVER_SQL)).rejects.toThrow(
      /zz_wo18_fault: refusing to privatise canvases/,
    );
    await db.exec(FAULT_DOWN);
    expect(await probeResidue()).toEqual(baseline);

    // Back to the target, then the fixture leaves: what remains is exactly nothing.
    await db.exec(CUTOVER_SQL);
    expect(await bucketStates()).toEqual(TARGET_BUCKETS);
    await db.exec(PREEXISTING_TYPE_DROP);
    expect(await probeResidue()).toEqual(NO_RESIDUE);
  });

  it("case 36: the replayed fixup2 carrier destroys or collides with those same types — the jsonb carrier does not", async () => {
    // (1) Counter-example, branch A — no dependents, so fixup2 TAKES THE NAME OVER.
    await db.exec(PREEXISTING_TYPE_FIXTURE);
    const before = await compositeTypeState("zz_wo18_policy");
    expect(before?.oid).toBeTruthy();
    await db.exec(FIXUP2_PROBE_DDL);
    const takenOver = await compositeTypeState("zz_wo18_policy");
    expect(takenOver?.oid).not.toBe(before?.oid);
    expect(takenOver?.attributes.map((row) => row.name)).toEqual([
      "p_name",
      "p_tail",
      "p_bucket",
      "p_cmd",
    ]);

    // ... and the file's own post-preflight cleanup then deletes the replacement — which IS the
    // pre-existing business type. A successful fixup2 apply loses a non-target object.
    await db.exec(FIXUP2_PROBE_CLEANUP);
    expect(await compositeTypeState("zz_wo18_policy")).toBeUndefined();
    expect(await compositeTypeState("zz_wo18_expect")).toBeUndefined();

    // (2) Branch B — with a dependent table the same DDL cannot even run, so the cutover aborts.
    await db.exec(PREEXISTING_TYPE_FIXTURE);
    await db.exec(PREEXISTING_TYPE_DEPENDENT);
    const policyBefore = await compositeTypeState("zz_wo18_policy");
    const expectTypeBefore = await compositeTypeState("zz_wo18_expect");
    const rowBefore = await businessRowText();
    await expect(db.exec(FIXUP2_PROBE_DDL)).rejects.toThrow(/cannot drop type/);
    expect(await compositeTypeState("zz_wo18_policy")).toEqual(policyBefore);
    expect(await compositeTypeState("zz_wo18_expect")).toEqual(expectTypeBefore);

    // (3) The jsonb carrier on that very same fixture: applies and touches neither OID nor data.
    await db.exec(CUTOVER_SQL);
    expect(await compositeTypeState("zz_wo18_policy")).toEqual(policyBefore);
    expect(await compositeTypeState("zz_wo18_expect")).toEqual(expectTypeBefore);
    expect(await businessRowText()).toBe(rowBefore);

    await db.exec(PREEXISTING_TYPE_DEPENDENT_DROP);
    await db.exec(PREEXISTING_TYPE_DROP);
    expect(await probeResidue()).toEqual(NO_RESIDUE);
  });
});

afterAll(async () => {
  // The drift cases tamper with the reference state on purpose; this asserts the suite hands
  // the database back in the shape a later test file would expect to find.
  if (db === undefined) return;
  const buckets = await bucketStates();
  expect(buckets).toEqual(TARGET_BUCKETS);
  expect((await canvasesPolicies()).map((row) => row.policyname)).toEqual([
    "canvases_select_metadata_reader",
  ]);
  expect(await constraintState(BUCKET_CHECK)).toMatchObject({
    convalidated: true,
    def: CHECK_NEW_DEF,
  });
});
