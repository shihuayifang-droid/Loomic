import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createBrandKitReadRepository } from "../../db/brand-kit-read-repository.js";
import { createBrandKitWriteRepository } from "../../db/brand-kit-write-repository.js";
import { createSkillRepository } from "../../db/skill-repository.js";
import { createWorkspaceSkillReadRepository } from "../../db/workspace-skill-read-repository.js";
import { createCanonicalDb, createCanonicalUser } from "./canonical-db.js";
import { createMigratedDb, createPGliteTransactionPool } from "./pglite-db.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Ticket 43X: canonical migration 0012 (brand kits, skills registry, home page
 * content tables) on an empty database. No Supabase stubs: only
 * `apps/server/db/canonical/*.sql`.
 *
 * The comparison against the retired `supabase/migrations` chain
 * (`createMigratedDb()`, built once) is the evidence that 0012 is the final form of
 * that chain. The only intended difference is the user reference schema
 * (`auth.users` -> `hahart_auth.users`), which is normalised before comparing.
 * Only the final state is asserted here.
 */

const SQL_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/canonical/0012_brand_skills_home.sql",
);

const TABLES = [
  "brand_kits",
  "brand_kit_assets",
  "skills",
  "skill_files",
  "workspace_skills",
  "home_example_categories",
  "home_example_examples",
  "home_discovery_categories",
  "home_discovery_cases",
] as const;

const FUNCTIONS = ["init_workspace_skills", "update_skills_updated_at"] as const;

const MAX_LINES = 600;

const USER_A = "00000000-0000-0000-0000-00000043f001";
const USER_B = "00000000-0000-0000-0000-00000043f002";
const KIT_PROJECT = "aaaa0000-0000-4000-8000-00000043f001";

let canonical: PGlite;
let legacy: PGlite;
let applied: string[] = [];

const tableList = TABLES.map((name) => `'${name}'`).join(", ");

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** The only intended difference between the two databases. */
function normalise(text: string): string {
  return text
    .replace(/hahart_auth\.users/g, "auth.users")
    .replace(/\bpublic\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function lines(database: PGlite, sql: string): Promise<string[]> {
  const result = await database.query<{ line: string }>(sql);
  return result.rows.map((row) => normalise(row.line));
}

function columnsOf(database: PGlite): Promise<string[]> {
  return lines(
    database,
    `select table_name || '.' || ordinal_position || ' ' || column_name || ' ' || data_type || ' '
            || udt_name || ' ' || is_nullable || ' ' || coalesce(column_default, '-') as line
       from information_schema.columns
      where table_schema = 'public' and table_name in (${tableList})
      order by table_name, ordinal_position`,
  );
}

function constraintsOf(database: PGlite): Promise<string[]> {
  return lines(
    database,
    `select c.relname || ' ' || k.conname || ' ' || k.contype::text || ' ' || pg_get_constraintdef(k.oid) as line
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in (${tableList}) and k.contype <> 'n'
      order by 1`,
  );
}

function indexesOf(database: PGlite): Promise<string[]> {
  return lines(
    database,
    `select tablename || ' ' || indexname || ' ' || indexdef as line
       from pg_indexes
      where schemaname = 'public' and tablename in (${tableList})
      order by 1`,
  );
}

function triggersOf(database: PGlite): Promise<string[]> {
  return lines(
    database,
    `select c.relname || ' ' || pg_get_triggerdef(t.oid) as line
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal
        and (c.relname in (${tableList}) or t.tgname = 'trg_init_workspace_skills')
      order by 1`,
  );
}

function functionsOf(database: PGlite): Promise<string[]> {
  const names = FUNCTIONS.map((name) => `'${name}'`).join(", ");
  return lines(
    database,
    `select p.proname || ' ' || pg_get_function_identity_arguments(p.oid) || ' secdef=' || p.prosecdef
            || ' ' || regexp_replace(pg_get_functiondef(p.oid), '--[^\r\n]*', '', 'g') as line
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in (${names})
      order by p.proname`,
  );
}

function commentsOf(database: PGlite): Promise<string[]> {
  return lines(
    database,
    `select c.relname || ' ' || coalesce(a.attname, '-') || ' ' || d.description as line
       from pg_description d
       join pg_class c on c.oid = d.objoid
       left join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid and d.objsubid > 0
      where c.relname in (${tableList})
      order by 1`,
  );
}

function enumOf(database: PGlite): Promise<string[]> {
  return lines(
    database,
    `select t.typname || ' ' || e.enumlabel as line
       from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'brand_kit_asset_type'
      order by e.enumsortorder`,
  );
}

function projectForeignKeysOf(database: PGlite): Promise<string[]> {
  return lines(
    database,
    `select conname || ' ' || pg_get_constraintdef(oid) as line
       from pg_constraint
      where conrelid = 'public.projects'::regclass and contype = 'f'
      order by 1`,
  );
}

async function personalWorkspace(database: PGlite, userId: string): Promise<string> {
  return firstRow(
    (
      await database.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [userId],
      )
    ).rows,
  ).id;
}

async function count(database: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  return firstRow((await database.query<{ n: number }>(sql, params)).rows).n;
}

beforeAll(async () => {
  const created = await createCanonicalDb();
  canonical = created.db;
  applied = created.applied;
  legacy = (await createMigratedDb()).db;

  await createCanonicalUser(canonical, USER_A, "a-43x@hahart.test");
  await createCanonicalUser(canonical, USER_B, "b-43x@hahart.test");
}, 120_000);

afterAll(async () => {
  await canonical.close();
  await legacy.close();
});

describe("canonical 0012 brand kits, skills and home content: schema", () => {
  it("applies 0012_brand_skills_home.sql", () => {
    expect(applied).toContain("0012_brand_skills_home.sql");
  });

  it("creates the nine tables, all empty", async () => {
    const tables = await canonical.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name in (${tableList})
        order by table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([...TABLES].sort());

    for (const table of TABLES) {
      expect(await count(canonical, `select count(*)::int as n from public.${table}`)).toBe(0);
    }
  });

  it("columns equal the old schema table by table", async () => {
    const expected = await columnsOf(legacy);
    expect(expected.length).toBeGreaterThan(0);
    expect(await columnsOf(canonical)).toEqual(expected);
  });

  it("constraints equal the old schema (user references now point at hahart_auth.users)", async () => {
    const expected = await constraintsOf(legacy);
    expect(expected.length).toBeGreaterThan(0);
    expect(await constraintsOf(canonical)).toEqual(expected);
  });

  it("indexes equal the old schema", async () => {
    const expected = await indexesOf(legacy);
    expect(expected.length).toBeGreaterThan(0);
    expect(await indexesOf(canonical)).toEqual(expected);
  });

  it("the enum has the same labels in the same order", async () => {
    const expected = await enumOf(legacy);
    expect(expected).toEqual([
      "brand_kit_asset_type color",
      "brand_kit_asset_type font",
      "brand_kit_asset_type logo",
      "brand_kit_asset_type image",
    ]);
    expect(await enumOf(canonical)).toEqual(expected);
  });

  it("the two functions have the same signature and body (comments and whitespace aside)", async () => {
    const expected = await functionsOf(legacy);
    expect(expected).toHaveLength(FUNCTIONS.length);
    expect(await functionsOf(canonical)).toEqual(expected);
  });

  it("the trigger set equals the old schema, including the workspace insert trigger", async () => {
    const expected = await triggersOf(legacy);
    expect(expected.some((line) => line.includes("trg_init_workspace_skills"))).toBe(true);
    expect(await triggersOf(canonical)).toEqual(expected);
  });

  it("column and table comments equal the old schema", async () => {
    const expected = await commentsOf(legacy);
    expect(expected).toHaveLength(4);
    expect(await commentsOf(canonical)).toEqual(expected);
  });

  it("projects and asset_objects carry the same foreign keys as the old schema", async () => {
    const expected = await projectForeignKeysOf(legacy);
    expect(expected.some((line) => line.startsWith("projects_brand_kit_id_fkey"))).toBe(true);
    expect(await projectForeignKeysOf(canonical)).toEqual(expected);
  });

  it("deleting a hahart_auth user cascades to its brand kits", async () => {
    const userId = "00000000-0000-0000-0000-00000043f0e9";
    await createCanonicalUser(canonical, userId, "gone-43x@hahart.test");
    await canonical.query("insert into public.brand_kits (user_id, name) values ($1, 'gone kit')", [
      userId,
    ]);
    await canonical.query("delete from hahart_auth.users where id = $1", [userId]);
    expect(
      await count(canonical, "select count(*)::int as n from public.brand_kits where user_id = $1", [
        userId,
      ]),
    ).toBe(0);
  });
});

describe("canonical 0012: SQL file hygiene", () => {
  const sql = readFileSync(SQL_FILE, "utf8");

  it(`stays within ${MAX_LINES} lines`, () => {
    expect(sql.split(/\r?\n/).length).toBeLessThanOrEqual(MAX_LINES);
  });

  it("contains none of the retired platform wording and no data statements", () => {
    const lowered = sql.toLowerCase();
    const withoutOwnSchema = lowered.replace(/hahart_auth\./g, "");

    expect(withoutOwnSchema).not.toMatch(/auth\./);
    expect(lowered).not.toMatch(/storage\./);
    expect(lowered).not.toMatch(/pgmq/);
    expect(lowered).not.toMatch(/row level security/);
    expect(lowered).not.toMatch(/create policy/);
    expect(lowered).not.toMatch(/grant /);
    expect(lowered).not.toMatch(/anon/);
    expect(lowered).not.toMatch(/authenticated/);
    expect(lowered).not.toMatch(/service_role/);
    expect(lowered).not.toMatch(/\binsert\s+into\s+public\.(skills|home_)/);
  });
});

describe("canonical 0012: real repositories on the empty database", () => {
  const getTransactionPool = () => createPGliteTransactionPool(canonical);

  it("brand kits: create, read and update through the repositories", async () => {
    const write = createBrandKitWriteRepository({ getTransactionPool });
    const read = createBrandKitReadRepository({ getTransactionPool });

    const { id: kitId } = await write.insertOwnKit({
      actorId: USER_A,
      name: "Canonical Kit",
      guidanceText: "be bold",
    });

    const asset = await write.insertOwnAsset({
      actorId: USER_A,
      kitId,
      asset: {
        asset_type: "color",
        display_name: "Primary",
        text_content: "#ff0000",
        role: "primary",
        sort_order: 0,
        metadata: { a: 1 },
        file_url: null,
      },
    });
    expect(asset?.display_name).toBe("Primary");

    const listed = await read.listOwnKits({ actorId: USER_A });
    expect(listed.kits.map((kit) => kit.id)).toEqual([kitId]);
    expect(listed.assets).toHaveLength(1);

    const found = await read.findOwnKit({ actorId: USER_A, kitId });
    expect(found?.name).toBe("Canonical Kit");
    expect(await read.findOwnKit({ actorId: USER_B, kitId })).toBeNull();

    const updated = await write.updateOwnKit({
      actorId: USER_A,
      kitId,
      patch: { name: "Renamed Kit", is_default: true },
    });
    expect(updated.updated).toBe(1);
    expect((await read.findOwnKit({ actorId: USER_A, kitId }))?.name).toBe("Renamed Kit");

    const updatedAsset = await write.updateOwnAsset({
      actorId: USER_A,
      kitId,
      assetId: asset!.id,
      patch: { display_name: "Primary 2" },
    });
    expect(updatedAsset?.display_name).toBe("Primary 2");
    expect(
      await read.readNextSortOrder({ actorId: USER_A, kitId, assetType: "color" }),
    ).toBe(1);
  });

  it("deleting a brand kit sets projects.brand_kit_id to null and removes the assets", async () => {
    const write = createBrandKitWriteRepository({ getTransactionPool });
    const workspaceId = await personalWorkspace(canonical, USER_A);
    const { id: kitId } = await write.insertOwnKit({
      actorId: USER_A,
      name: "Linked Kit",
      guidanceText: null,
    });
    await write.insertOwnAsset({
      actorId: USER_A,
      kitId,
      asset: {
        asset_type: "font",
        display_name: "Serif",
        text_content: "Georgia",
        role: null,
        sort_order: 0,
        metadata: null,
        file_url: null,
      },
    });
    await canonical.query(
      `insert into public.projects (id, workspace_id, name, slug, created_by, brand_kit_id)
       values ($1, $2, 'Kit project', 'kit-project', $3, $4)`,
      [KIT_PROJECT, workspaceId, USER_A, kitId],
    );

    await write.deleteOwnKit({ actorId: USER_A, kitId });

    expect(
      firstRow(
        (
          await canonical.query<{ brand_kit_id: string | null }>(
            "select brand_kit_id from public.projects where id = $1",
            [KIT_PROJECT],
          )
        ).rows,
      ).brand_kit_id,
    ).toBeNull();
    expect(
      await count(canonical, "select count(*)::int as n from public.brand_kit_assets where kit_id = $1", [
        kitId,
      ]),
    ).toBe(0);
  });

  it("skills: create and read through the repository, then install in a workspace", async () => {
    const skills = createSkillRepository({ getTransactionPool });
    const workspaceSkills = createWorkspaceSkillReadRepository({ getTransactionPool });
    const workspaceId = await personalWorkspace(canonical, USER_A);

    const created = await skills.insertOwnSkill(USER_A, {
      name: "Canonical Skill",
      slug: "canonical-skill",
      description: "created by the repository",
      category: "custom",
      skillContent: "# canonical",
      metadata: { source_url: "https://example.test/pkg", package_name: "pkg" },
    });
    expect(created.source).toBe("user");
    expect(created.created_by).toBe(USER_A);

    expect((await skills.listVisibleSkills(USER_A)).map((skill) => skill.slug)).toEqual([
      "canonical-skill",
    ]);
    expect(await skills.findVisibleSkill(USER_B, created.id)).toBeNull();

    expect(
      await skills.insertOwnSkillFiles(USER_A, created.id, [
        { filePath: "scripts/run.py", content: "print(1)", mimeType: "text/x-python" },
      ]),
    ).toEqual({ inserted: 1 });
    expect((await skills.listVisibleSkillFiles(USER_A, created.id)).map((file) => file.file_path)).toEqual([
      "scripts/run.py",
    ]);

    await skills.upsertWorkspaceSkill(USER_A, workspaceId, created.id, true);
    const installed = await skills.listWorkspaceInstalledSkills(USER_A, workspaceId);
    expect(installed.map((skill) => [skill.slug, skill.enabled])).toEqual([
      ["canonical-skill", true],
    ]);

    const enabled = await workspaceSkills.listEnabledWorkspaceSkills({
      actorId: USER_A,
      workspaceId,
    });
    expect(enabled.map((skill) => skill.slug)).toEqual(["canonical-skill"]);
    const files = await workspaceSkills.listSkillFiles({
      actorId: USER_A,
      skillIds: [created.id],
    });
    expect(files.map((file) => file.file_path)).toEqual(["scripts/run.py"]);

    expect(await skills.deleteWorkspaceSkill(USER_A, workspaceId, created.id)).toEqual({
      deleted: 1,
    });
  });

  it("a new workspace installs every system skill and nothing else, like the old trigger", async () => {
    const SYSTEM_ID = "00000000-0000-0000-0000-00000043f0a1";
    const USER_ID = "00000000-0000-0000-0000-00000043f0a2";
    const NEW_USER = "00000000-0000-0000-0000-00000043f0a3";

    for (const database of [canonical, legacy]) {
      // The old schema ships its own system skills; add one more of each source.
      await database.query(
        `insert into public.skills (id, name, slug, source, skill_content)
         values ($1, 'Probe system', 'probe-system', 'system', 'x'),
                ($2, 'Probe community', 'probe-community', 'community', 'x')`,
        [SYSTEM_ID, USER_ID],
      );

      if (database === canonical) {
        await createCanonicalUser(database, NEW_USER, "trigger-43x@hahart.test");
      } else {
        await database.query("insert into auth.users (id, email) values ($1, $2)", [
          NEW_USER,
          "trigger-43x@hahart.test",
        ]);
      }
    }

    const installedFor = async (database: PGlite): Promise<string[]> => {
      const result = await database.query<{ slug: string }>(
        `select s.slug from public.workspace_skills ws
           join public.skills s on s.id = ws.skill_id
           join public.workspaces w on w.id = ws.workspace_id
          where w.owner_user_id = $1 and ws.enabled
          order by s.slug`,
        [NEW_USER],
      );
      return result.rows.map((row) => row.slug);
    };

    const fromCanonical = await installedFor(canonical);
    const systemSlugs = (
      await canonical.query<{ slug: string }>(
        "select slug from public.skills where source = 'system' order by slug",
      )
    ).rows.map((row) => row.slug);

    expect(fromCanonical).toEqual(["probe-system"]);
    expect(fromCanonical).toEqual(systemSlugs);
    // Old schema: its own system skills plus the probe, never the community one.
    const fromLegacy = await installedFor(legacy);
    expect(fromLegacy).toContain("probe-system");
    expect(fromLegacy).not.toContain("probe-community");
  });
});
