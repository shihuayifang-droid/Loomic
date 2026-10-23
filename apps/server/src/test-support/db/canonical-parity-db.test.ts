import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCanonicalDb } from "./canonical-db.js";
import { createMigratedDb } from "./pglite-db.js";

vi.setConfig({ testTimeout: 120_000 });

/**
 * Ticket 43Y: whole-schema parity between the canonical empty-database build
 * (`createCanonicalDb()`, apps/server/db/canonical/*.sql only) and the legacy
 * replay (`createMigratedDb()`, supabase/migrations + Supabase stubs).
 *
 * Every difference must be listed below with a reason. A difference that is not
 * listed fails the test: that is what catches a table or function that was never
 * ported.
 */

/** Old-only public tables. */
const INTENDED_MISSING_TABLES: Record<string, string> = {
  payment_events: "payments are offline (43R / 0007 header: no payment_events table)",
};

/** New-only public tables (besides none): the canonical migration ledger. */
const INTENDED_EXTRA_TABLES: Record<string, string> = {
  schema_migrations: "canonical migration ledger (0001)",
};

/** Old-only functions, keyed by `schema.name(identity args)`. */
const INTENDED_MISSING_FUNCTIONS: Record<string, string> = {
  "public.handle_new_user()":
    "auth.users signup trigger; accounts live in hahart_auth.users, workspaces come from bootstrap_viewer (43O)",
  "private.prevent_profile_email_change()":
    "email is owned by hahart_auth.users; trigger not ported (43O)",
  "public.create_project_with_canvas(p_workspace_id uuid, p_name text, p_slug text, p_description text, p_canvas_name text)":
    "legacy PostgREST rpc, superseded by server-side repository SQL (43P)",
  "public.migrate_personal_projects_to_team()":
    "one-off Supabase data migration; nothing to migrate on an empty database (43P)",
  "public.record_project_asset_if_matches(p_bucket text, p_object_path text, p_created_by uuid, p_fallback_workspace_id uuid, p_project_id uuid, p_canvas_id uuid, p_mime_type text, p_byte_size bigint, p_expected_asset_id uuid, p_expected_workspace_id uuid, p_expected_project_id uuid, p_expected_created_by uuid, p_expected_mime_type text, p_expected_byte_size bigint)":
    "storage-object bookkeeping rpc; storage is gone (43P)",
  "public.increment_job_attempt(p_job_id uuid)":
    "replaced by inline SQL in the repository (0006 header, 43R)",
  "private.asset_object_project_matches_workspace(p_project_id uuid, p_workspace_id uuid)":
    "RLS/storage helper only (43O/43P: no RLS)",
  "private.can_read_project(p_project_id uuid)": "RLS helper (43O/43P: no RLS)",
  "private.can_write_project(p_project_id uuid)": "RLS helper (43O/43P: no RLS)",
  "private.canvas_project_id(p_canvas_id uuid)": "RLS helper (43O/43P: no RLS)",
  "private.is_project_admin_or_owner(p_project_id uuid)": "RLS helper (43O/43P: no RLS)",
  "private.is_project_member(p_project_id uuid)": "RLS helper (43O/43P: no RLS)",
  "private.is_workspace_admin_or_owner(p_workspace_id uuid)": "RLS helper (43O/43P: no RLS)",
  "private.is_workspace_member(p_workspace_id uuid)": "RLS helper (43O/43P: no RLS)",
  "private.is_workspace_owner(p_workspace_id uuid)": "RLS helper (43O/43P: no RLS)",
  "private.session_project_id(p_session_id uuid)": "RLS helper (43O/43P: no RLS)",
};

/** Functions whose body legitimately differs (each proved line by line). */
const INTENDED_BODY_DIFF: Record<string, string> = {
  "public.create_charged_job": "pgmq.send -> hahart_queue (43V)",
  "public.remove_team_member": "storage section removed (43W)",
};

/**
 * Triggers present in old only, keyed `table|trigger|function`.
 * Everything on auth.users / langgraph.* is out of scope (those tables are not
 * shared); the rest are documented replacements.
 */
const INTENDED_MISSING_TRIGGERS: Record<string, string> = {
  "public.profiles|profiles_prevent_email_change|prevent_profile_email_change":
    "email trigger not ported (43O)",
  "public.chat_sessions|chat_sessions_updated_at|moddatetime":
    "Supabase moddatetime -> public.set_updated_at, renamed chat_sessions_set_updated_at (43O/43Q)",
};

/** Triggers present in new only, keyed `table|trigger|function`. */
const INTENDED_EXTRA_TRIGGERS: Record<string, string> = {
  "public.chat_sessions|chat_sessions_set_updated_at|set_updated_at":
    "replaces moddatetime trigger (43Q)",
};

/** Trigger whose name is shared but whose function is swapped. */
const INTENDED_TRIGGER_FN_SWAP: Record<string, string> = {
  "public.workspace_settings|workspace_settings_updated_at":
    "extensions.moddatetime -> public.set_updated_at (43O)",
};

const SUPABASE_SCHEMAS = [
  "auth",
  "storage",
  "pgmq",
  "graphql",
  "graphql_public",
  "realtime",
  "extensions",
  "vault",
  "langgraph",
];
const SUPABASE_ROLES = ["anon", "authenticated", "service_role"];

let canon: PGlite;
let legacy: PGlite;

async function rows<T>(db: PGlite, sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}

/**
 * Normalise a function body: drop comments, collapse whitespace, and lower-case
 * everything OUTSIDE single-quoted literals (the canonical files are written in
 * lower-case SQL, the legacy ones in upper-case; literals keep their case).
 */
function stripSql(src: string): string {
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  return noComments
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 === 1 ? part : part.toLowerCase()))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}


function diff(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => !set.has(x)).sort();
}

async function publicTables(db: PGlite): Promise<string[]> {
  return (
    await rows<{ t: string }>(
      db,
      `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p','v','m') order by 1`,
    )
  ).map((r) => r.t);
}

beforeAll(async () => {
  canon = (await createCanonicalDb()).db;
  legacy = (await createMigratedDb()).db;
});

afterAll(async () => {
  await canon?.close();
  await legacy?.close();
});

describe("canonical vs legacy schema parity", () => {
  it("public tables differ only by the intended lists", async () => {
    const n = await publicTables(canon);
    const o = await publicTables(legacy);
    expect(diff(o, n)).toEqual(Object.keys(INTENDED_MISSING_TABLES).sort());
    expect(diff(n, o)).toEqual(Object.keys(INTENDED_EXTRA_TABLES).sort());
  });

  // Only normalisation: legacy defaults say "extensions.gen_random_uuid()"; the canonical
  // database has no extensions schema and uses the built-in gen_random_uuid().
  it("columns of shared tables are identical", async () => {
    const q = `select table_name||'.'||column_name as k,
        data_type||'|'||udt_name||'|'||is_nullable||'|'||replace(coalesce(column_default,'<none>'),'extensions.gen_random_uuid()','gen_random_uuid()') as v
      from information_schema.columns where table_schema = 'public' order by 1`;
    const shared = new Set(diff(await publicTables(canon), Object.keys(INTENDED_EXTRA_TABLES)));
    const pick = async (db: PGlite) =>
      (await rows<{ k: string; v: string }>(db, q))
        .filter((r) => shared.has(r.k.split(".")[0] ?? ""))
        .map((r) => `${r.k} => ${r.v}`);
    const n = await pick(canon);
    const o = await pick(legacy);
    expect(n.length).toBeGreaterThan(100);
    expect(diff(o, n)).toEqual([]);
    expect(diff(n, o)).toEqual([]);
  });

  it("constraints of shared tables are identical (auth.users -> hahart_auth.users)", async () => {
    const q = `select c.relname||'|'||k.conname||'|'||k.contype::text||'|'||pg_get_constraintdef(k.oid) as d
      from pg_constraint k join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' order by 1`;
    const shared = new Set(diff(await publicTables(canon), Object.keys(INTENDED_EXTRA_TABLES)));
    const pick = async (db: PGlite, fix: boolean) =>
      (await rows<{ d: string }>(db, q))
        .map((r) => r.d)
        .filter((d) => shared.has(d.split("|")[0] ?? ""))
        .map((d) => (fix ? d.replace(/\bauth\.users\b/g, "hahart_auth.users") : d));
    const n = await pick(canon, false);
    const o = await pick(legacy, true);
    expect(n.length).toBeGreaterThan(100);
    expect(diff(o, n)).toEqual([]);
    expect(diff(n, o)).toEqual([]);
  });

  it("indexes of shared tables are identical", async () => {
    const q = `select tablename, tablename||'|'||indexname||'|'||indexdef as d
      from pg_indexes where schemaname = 'public' order by 2`;
    const shared = new Set(diff(await publicTables(canon), Object.keys(INTENDED_EXTRA_TABLES)));
    const pick = async (db: PGlite) =>
      (await rows<{ tablename: string; d: string }>(db, q))
        .filter((r) => shared.has(r.tablename))
        .map((r) => r.d);
    const n = await pick(canon);
    const o = await pick(legacy);
    expect(n.length).toBeGreaterThan(50);
    expect(diff(o, n)).toEqual([]);
    expect(diff(n, o)).toEqual([]);
  });

  it("public enums match in name and value order", async () => {
    const q = `select t.typname||'='||string_agg(e.enumlabel, ',' order by e.enumsortorder) as d
      from pg_type t join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' group by t.typname order by 1`;
    const n = (await rows<{ d: string }>(canon, q)).map((r) => r.d);
    const o = (await rows<{ d: string }>(legacy, q)).map((r) => r.d);
    expect(n.length).toBeGreaterThan(5);
    expect(n).toEqual(o);
  });

  describe("functions", () => {
    type Fn = {
      id: string;
      name: string;
      schema: string;
      ret: string;
      lang: string;
      secdef: boolean;
      src: string;
    };
    const q = `select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as id,
        p.proname as name, n.nspname as schema,
        pg_get_function_result(p.oid) as ret, l.lanname as lang,
        p.prosecdef as secdef, p.prosrc as src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where n.nspname in ('public','private')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by 1`;
    let nf: Fn[] = [];
    let of: Fn[] = [];
    beforeAll(async () => {
      nf = await rows<Fn>(canon, q);
      of = await rows<Fn>(legacy, q);
    });

    it("function sets differ only by the intended list", () => {
      const n = nf.map((f) => f.id);
      const o = of.map((f) => f.id);
      expect(n.length).toBeGreaterThan(30);
      expect(diff(o, n)).toEqual(Object.keys(INTENDED_MISSING_FUNCTIONS).sort());
      expect(diff(n, o)).toEqual([]);
    });

    it("shared functions have identical return type, language and security mode", () => {
      const oMap = new Map(of.map((f) => [f.id, f]));
      const mismatches: string[] = [];
      for (const f of nf) {
        const g = oMap.get(f.id);
        if (!g) continue;
        if (f.ret !== g.ret || f.lang !== g.lang || f.secdef !== g.secdef) {
          mismatches.push(
            `${f.id}: new(${f.ret}, ${f.lang}, secdef=${f.secdef}) old(${g.ret}, ${g.lang}, secdef=${g.secdef})`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    });

    it("shared function bodies are identical outside the intended list", () => {
      const oMap = new Map(of.map((f) => [f.id, f]));
      const mismatches: string[] = [];
      const seenIntended = new Set<string>();
      for (const f of nf) {
        const g = oMap.get(f.id);
        if (!g) continue;
        const same = stripSql(f.src) === stripSql(g.src);
        const key = `${f.schema}.${f.name}`;
        if (key in INTENDED_BODY_DIFF) {
          seenIntended.add(key);
          if (same) mismatches.push(`${key}: listed as different but bodies are equal`);
        } else if (!same) {
          mismatches.push(f.id);
        }
      }
      expect([...seenIntended].sort()).toEqual(Object.keys(INTENDED_BODY_DIFF).sort());
      expect(mismatches).toEqual([]);
    });
  });

  it("triggers of shared tables differ only by the intended lists", async () => {
    const q = `select n.nspname||'.'||c.relname as tbl, g.tgname as trg, p.proname as fn, g.tgtype as ty
      from pg_trigger g join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = g.tgfoid
      where not g.tgisinternal and n.nspname = 'public' order by 1,2`;
    type T = { tbl: string; trg: string; fn: string; ty: number };
    const swap = new Set(Object.keys(INTENDED_TRIGGER_FN_SWAP));
    const keys = (list: T[]) =>
      list.map((t) => `${t.tbl}|${t.trg}|${t.fn}|type=${t.ty}`);
    const n = await rows<T>(canon, q);
    const o = await rows<T>(legacy, q);
    // Triggers on the one swapped trigger are compared by table + name + timing only.
    const norm = (list: T[]) =>
      keys(
        list.map((t) =>
          swap.has(`${t.tbl}|${t.trg}`) ? { ...t, fn: "<swapped>" } : t,
        ),
      );
    const stripType = (s: string) => s.replace(/\|type=\d+$/, "");
    const missing = diff(norm(o), norm(n)).map(stripType);
    const extra = diff(norm(n), norm(o)).map(stripType);
    expect(missing).toEqual(Object.keys(INTENDED_MISSING_TRIGGERS).sort());
    expect(extra).toEqual(Object.keys(INTENDED_EXTRA_TRIGGERS).sort());
    // Trigger timing/event bits are identical for every trigger that exists on both sides.
    const oType = new Map(o.map((t) => [`${t.tbl}|${t.trg}`, t.ty]));
    const typeMismatch = n
      .filter((t) => oType.has(`${t.tbl}|${t.trg}`) && oType.get(`${t.tbl}|${t.trg}`) !== t.ty)
      .map((t) => `${t.tbl}|${t.trg}`);
    expect(typeMismatch).toEqual([]);
    // The swapped trigger really does call different functions on the two sides.
    for (const key of swap) {
      const [tbl, trg] = key.split("|");
      const nn = n.find((t) => t.tbl === tbl && t.trg === trg);
      const oo = o.find((t) => t.tbl === tbl && t.trg === trg);
      expect(nn?.fn).toBe("set_updated_at");
      expect(oo?.fn).toBe("moddatetime");
    }
  });

  it("the canonical database has no Supabase schemas, roles or grants", async () => {
    const schemas = (
      await rows<{ nspname: string }>(canon, "select nspname from pg_namespace")
    ).map((r) => r.nspname);
    expect(schemas.filter((s) => SUPABASE_SCHEMAS.includes(s))).toEqual([]);
    expect(schemas).toEqual(expect.arrayContaining(["hahart_auth", "hahart_queue"]));

    const roles = (await rows<{ rolname: string }>(canon, "select rolname from pg_roles")).map(
      (r) => r.rolname,
    );
    expect(roles.filter((r) => SUPABASE_ROLES.includes(r))).toEqual([]);

    const list = SUPABASE_ROLES.map((r) => `'${r}'`).join(",");
    const tableGrants = await rows<{ c: number }>(
      canon,
      `select count(*)::int as c from information_schema.role_table_grants where grantee in (${list})`,
    );
    const routineGrants = await rows<{ c: number }>(
      canon,
      `select count(*)::int as c from information_schema.role_routine_grants where grantee in (${list})`,
    );
    expect(tableGrants[0]?.c).toBe(0);
    expect(routineGrants[0]?.c).toBe(0);
  });
});
