import { describe, expect, it } from "vitest";

import {
  DELETE_OWN_SKILL,
  DELETE_WORKSPACE_SKILL,
  FIND_VISIBLE_SKILL,
  INSERT_OWN_SKILL,
  INSERT_OWN_SKILL_FILES,
  LIST_VISIBLE_SKILL_FILES,
  LIST_VISIBLE_SKILLS,
  LIST_WORKSPACE_INSTALLED_SKILLS,
  SkillRepositoryError,
  UPDATE_OWN_SKILL,
  UPSERT_WORKSPACE_SKILL,
  createSkillRepository,
  type SkillRepository,
} from "./skill-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the statement the
 * repository issues, the actor (and workspace) it carries, how it binds values,
 * and how it classifies every way a call can fail.
 *
 * The SQL assertions are deliberately about the AUTHORIZATION predicates and the
 * parameter ORDER, not about a happy path that merely returns rows. Workorder
 * 21AE translates `skills_select_all`, `skills_insert_user`,
 * `skills_update_user`, `skills_delete_user`, `skill_files_select`,
 * `skill_files_insert`, `ws_skills_select` and both branches of
 * `private.is_workspace_admin_or_owner` into these ten statements, so a predicate
 * dropped here would silently widen who may read or rewrite a skill.
 *
 * The number of `set_config` statements is deliberately NOT pinned: how the
 * transaction writes its four session settings is `transaction.ts`'s business,
 * not this module's.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000a1";
const OTHER_ID = "00000000-0000-0000-0000-0000000000a2";
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000c1";
const SKILL_ID = "00000000-0000-0000-0000-0000000000d1";
const SECOND_SKILL_ID = "00000000-0000-0000-0000-0000000000d2";
const FILE_ID = "00000000-0000-0000-0000-0000000000e1";
const INVALID_ID = "not-a-uuid";

type QueryRecord = { sql: string; params?: readonly unknown[] };

type Harness = {
  pool: TransactionPool;
  queries: QueryRecord[];
  connectAttempts: () => number;
};

/** A pool whose single connection records every statement and answers `respond`. */
function createHarness(
  respond: (sql: string) => unknown[] | Promise<unknown[]>,
  options: { connectError?: Error } = {},
): Harness {
  const queries: QueryRecord[] = [];
  let connectAttempts = 0;

  const connection: TransactionConnection = {
    async query(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, ...(params === undefined ? {} : { params }) });

      if (
        sql === TRANSACTION_STATEMENTS.setLocalSetting ||
        sql === TRANSACTION_STATEMENTS.begin ||
        sql === TRANSACTION_STATEMENTS.commit ||
        sql === TRANSACTION_STATEMENTS.rollback
      ) {
        return { rows: [] };
      }

      return { rows: await respond(sql) };
    },
    release() {},
  };

  return {
    pool: {
      async connect() {
        connectAttempts += 1;
        if (options.connectError) throw options.connectError;
        return connection;
      },
    },
    queries,
    connectAttempts: () => connectAttempts,
  };
}

/** Only the domain statements touch these three tables; BEGIN/COMMIT do not. */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter(
    (entry) =>
      entry.sql.includes("public.skills") ||
      entry.sql.includes("public.skill_files") ||
      entry.sql.includes("public.workspace_skills"),
  );
}

function onlyDomain(queries: readonly QueryRecord[]): QueryRecord {
  const domain = domainCalls(queries);
  expect(domain).toHaveLength(1);
  return domain[0] as QueryRecord;
}

/**
 * The four session settings as (name, value) pairs. The pair ORDER is
 * `TRANSACTION_SETTING_ORDER`, so the assertions below can read one value without
 * caring how many statements carried it.
 */
function contextValue(
  queries: readonly QueryRecord[],
  name: string,
): unknown {
  const flat = queries
    .filter((entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting)
    .flatMap((entry) => [...(entry.params ?? [])]);

  const pairs: Array<[unknown, unknown]> = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    pairs.push([flat[index], flat[index + 1]]);
  }

  return pairs.find((pair) => pair[0] === name)?.[1];
}

function repositoryFor(harness: Harness): SkillRepository {
  return createSkillRepository({ getTransactionPool: () => harness.pool });
}

/**
 * What `pg` really hands back for a `public.skills` row: timestamptz as a `Date`,
 * jsonb as an object. The mapped answer below is what the HTTP contract needs, so
 * this fixture also pins the timestamp normalisation.
 */
const DRIVER_SKILL_ROW = {
  id: SKILL_ID,
  name: "Canvas Design",
  slug: "canvas-design",
  description: "Design on the canvas",
  author: "anthropic",
  version: "1.0",
  license: "Apache-2.0",
  category: "design",
  icon_name: "palette",
  source: "system",
  skill_content: "# SKILL\nDo the thing.",
  metadata: { tags: ["design"] },
  is_featured: true,
  created_by: null,
  created_at: new Date("2026-10-19T12:00:00.000Z"),
  updated_at: new Date("2026-10-19T12:05:00.000Z"),
  source_url: null,
  package_name: null,
};

const MAPPED_SKILL_ROW = {
  ...DRIVER_SKILL_ROW,
  created_at: "2026-10-19T12:00:00.000Z",
  updated_at: "2026-10-19T12:05:00.000Z",
};

const DRIVER_FILE_ROW = {
  id: FILE_ID,
  skill_id: SKILL_ID,
  file_path: "scripts/analyze.py",
  content: "print('hi')\n",
  mime_type: "text/plain",
  created_at: new Date("2026-10-19T12:00:00.000Z"),
  updated_at: new Date("2026-10-19T12:00:00.000Z"),
};

const MAPPED_FILE_ROW = {
  ...DRIVER_FILE_ROW,
  created_at: "2026-10-19T12:00:00.000Z",
  updated_at: "2026-10-19T12:00:00.000Z",
};

const DRIVER_INSTALLED_ROW = {
  ...DRIVER_SKILL_ROW,
  enabled: false,
  installed_at: new Date("2026-10-18T09:30:00.000Z"),
};

describe("skill-repository: listVisibleSkills", () => {
  it("case 1: exactly one domain statement, privileged, carrying the actor, ordered featured-then-name", async () => {
    const harness = createHarness(() => [DRIVER_SKILL_ROW]);

    const rows = await repositoryFor(harness).listVisibleSkills(ACTOR_ID);

    expect(rows).toEqual([MAPPED_SKILL_ROW]);

    const statement = onlyDomain(harness.queries);
    const sql = statement.sql;

    // `skills_select_all`: shared skills are public, a user skill is its author's.
    expect(sql).toContain("s.source in ('system', 'community')");
    expect(sql).toContain("s.created_by = $1::uuid");
    // The published order is part of the answer.
    expect(sql).toContain("order by s.is_featured desc, s.name asc");
    // The whole catalogue, so no extra WHERE half may appear.
    expect(sql).not.toContain("ws.");
    expect(statement.params).toEqual([ACTOR_ID]);

    // A privileged read, so the statement's own predicate is the authorisation.
    expect(
      contextValue(harness.queries, TRANSACTION_SETTING_NAMES.executionMode),
    ).toBe("privileged");
    expect(contextValue(harness.queries, TRANSACTION_SETTING_NAMES.userId)).toBe(
      ACTOR_ID,
    );
    // No role and no workspace are claimed by this read.
    expect(contextValue(harness.queries, TRANSACTION_SETTING_NAMES.role)).toBe("");
    expect(
      contextValue(harness.queries, TRANSACTION_SETTING_NAMES.workspaceId),
    ).toBe("");
  });

  it("case 2: an unusable actorId fails BEFORE a connection is opened, and names the operation", async () => {
    const harness = createHarness(() => []);

    const error = await repositoryFor(harness)
      .listVisibleSkills("")
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SkillRepositoryError);
    expect((error as SkillRepositoryError).operation).toBe(LIST_VISIBLE_SKILLS);
    expect((error as SkillRepositoryError).sqlstate).toBeNull();
    expect(harness.connectAttempts()).toBe(0);
    expect(harness.queries).toHaveLength(0);
  });
});

describe("skill-repository: findVisibleSkill", () => {
  it("case 3: one statement carrying the visibility predicate and the id, bound actor first then id", async () => {
    const harness = createHarness(() => [DRIVER_SKILL_ROW]);

    const row = await repositoryFor(harness).findVisibleSkill(
      ACTOR_ID,
      SKILL_ID,
    );

    expect(row).toEqual(MAPPED_SKILL_ROW);

    const statement = onlyDomain(harness.queries);
    expect(statement.sql).toContain("s.source in ('system', 'community')");
    expect(statement.sql).toContain("s.created_by = $1::uuid");
    expect(statement.sql).toContain("s.id = $2::uuid");
    expect(statement.params).toEqual([ACTOR_ID, SKILL_ID]);
  });

  it("case 4: zero rows is the answer `null`, not an error", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).findVisibleSkill(ACTOR_ID, SKILL_ID),
    ).resolves.toBeNull();
  });

  it("case 5: a malformed id is NOT pre-validated, it reaches the pool as the raw bind value", async () => {
    // The server, not this module, has to reject it: 22P02 is a real SQL error the
    // routes map onto their own status codes, so hiding it here would change them.
    const harness = createHarness(() => {
      throw Object.assign(
        new Error(`invalid input syntax for type uuid: "${INVALID_ID}"`),
        { code: "22P02" },
      );
    });

    const error = await repositoryFor(harness)
      .findVisibleSkill(ACTOR_ID, INVALID_ID)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SkillRepositoryError);
    expect((error as SkillRepositoryError).sqlstate).toBe("22P02");
    expect(onlyDomain(harness.queries).params).toEqual([ACTOR_ID, INVALID_ID]);
  });
});

describe("skill-repository: listVisibleSkillFiles", () => {
  it("case 6: the visibility predicate rides on the JOIN, and the files are ordered by path", async () => {
    const harness = createHarness(() => [DRIVER_FILE_ROW]);

    const rows = await repositoryFor(harness).listVisibleSkillFiles(
      ACTOR_ID,
      SKILL_ID,
    );

    expect(rows).toEqual([MAPPED_FILE_ROW]);

    const statement = onlyDomain(harness.queries);
    const sql = statement.sql;
    expect(sql).toContain("join public.skills s");
    expect(sql).toContain("s.id = f.skill_id");
    expect(sql).toContain("s.source in ('system', 'community')");
    expect(sql).toContain("s.created_by = $1::uuid");
    expect(sql).toContain("f.skill_id = $2::uuid");
    expect(sql).toContain("order by f.file_path asc");
    // No workspace predicate: this read is authorised by skill visibility alone.
    expect(sql).not.toContain("workspace_members");
    expect(statement.params).toEqual([ACTOR_ID, SKILL_ID]);
  });

  it("case 7: an EMPTY file is a real file, while a missing id is a shape disagreement", async () => {
    const empty = createHarness(() => [{ ...DRIVER_FILE_ROW, content: "" }]);
    await expect(
      repositoryFor(empty).listVisibleSkillFiles(ACTOR_ID, SKILL_ID),
    ).resolves.toEqual([{ ...MAPPED_FILE_ROW, content: "" }]);

    const broken = createHarness(() => [
      { ...DRIVER_FILE_ROW, id: undefined },
    ]);
    const error = await repositoryFor(broken)
      .listVisibleSkillFiles(ACTOR_ID, SKILL_ID)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SkillRepositoryError);
    expect((error as SkillRepositoryError).operation).toBe(
      LIST_VISIBLE_SKILL_FILES,
    );
    expect(String((error as SkillRepositoryError).cause)).toContain("id");
  });
});

describe("skill-repository: listWorkspaceInstalledSkills", () => {
  it("case 8: the membership predicate AND the skill-visibility predicate, no enabled filter, newest first", async () => {
    const harness = createHarness(() => [DRIVER_INSTALLED_ROW]);

    const rows = await repositoryFor(harness).listWorkspaceInstalledSkills(
      ACTOR_ID,
      WORKSPACE_ID,
    );

    expect(rows).toEqual([
      {
        ...MAPPED_SKILL_ROW,
        enabled: false,
        installed_at: "2026-10-18T09:30:00.000Z",
      },
    ]);

    const statement = onlyDomain(harness.queries);
    const sql = statement.sql;

    // `ws_skills_select`: private.is_workspace_member(workspace_id), bound.
    expect(sql).toContain("public.workspace_members m");
    expect(sql).toContain("m.workspace_id = $2::uuid");
    expect(sql).toContain("m.user_id = $1::uuid");
    // `skills_select_all` on the join, so a private skill of somebody else cannot
    // contribute a row.
    expect(sql).toContain("s.source in ('system', 'community')");
    expect(sql).toContain("s.created_by = $1::uuid");
    // The question itself, and the published order.
    expect(sql).toContain("ws.workspace_id = $2::uuid");
    expect(sql).toContain("order by ws.installed_at desc");
    // Disabled installs are published too, so there is no `enabled` filter.
    expect(sql).not.toContain("ws.enabled =");
    expect(statement.params).toEqual([ACTOR_ID, WORKSPACE_ID]);

    // The workspace this statement is about rides in the transaction context.
    expect(
      contextValue(harness.queries, TRANSACTION_SETTING_NAMES.workspaceId),
    ).toBe(WORKSPACE_ID);
  });

  it("case 9: an unusable workspaceId fails before the pool, and no statement is sent", async () => {
    const harness = createHarness(() => []);

    const error = await repositoryFor(harness)
      .listWorkspaceInstalledSkills(ACTOR_ID, "")
      .catch((reason: unknown) => reason);

    expect((error as SkillRepositoryError).operation).toBe(
      LIST_WORKSPACE_INSTALLED_SKILLS,
    );
    expect(harness.connectAttempts()).toBe(0);
  });
});

describe("skill-repository: insertOwnSkill", () => {
  it("case 10: `source = 'user'` and `created_by` are written into the statement, and the omitted columns fall back to their DEFAULT", async () => {
    const harness = createHarness(() => [DRIVER_SKILL_ROW]);

    const row = await repositoryFor(harness).insertOwnSkill(ACTOR_ID, {
      name: "Canvas Design",
      slug: "canvas-design",
      description: "Design on the canvas",
      category: "design",
      skillContent: "# SKILL",
      iconName: null,
    });

    expect(row).toEqual(MAPPED_SKILL_ROW);

    const statement = onlyDomain(harness.queries);
    const sql = statement.sql;

    // `skills_insert_user`'s WITH CHECK, written out: the policy does not run on a
    // privileged connection.
    expect(sql).toContain("'user'");
    expect(sql).toContain("$1::uuid");
    // The three marketplace-only columns keep the migration's DEFAULT when absent.
    expect(sql).toContain("coalesce($5::text, 'system')");
    expect(sql).toContain("coalesce($6::text, '1.0')");
    expect(sql).toContain("coalesce($11::jsonb, '{}'::jsonb)");

    // Actor first, the twelve column values after it, and `undefined`-as-absent.
    // `source_url` / `package_name` (T-61 ②) are the last two and are NULL when the
    // caller omits them, which is the create route's shape.
    expect(statement.params).toEqual([
      ACTOR_ID,
      "Canvas Design",
      "canvas-design",
      "Design on the canvas",
      null,
      null,
      null,
      "design",
      null,
      "# SKILL",
      null,
      null,
      null,
    ]);
  });

  it("case 11: the marketplace columns change only the PARAMETERS, never the statement", async () => {
    const minimal = createHarness(() => [DRIVER_SKILL_ROW]);
    await repositoryFor(minimal).insertOwnSkill(ACTOR_ID, {
      name: "A",
      slug: "a",
      description: "",
      category: "custom",
      skillContent: "x",
    });

    const marketplace = createHarness(() => [DRIVER_SKILL_ROW]);
    await repositoryFor(marketplace).insertOwnSkill(ACTOR_ID, {
      name: "A",
      slug: "a",
      description: "",
      category: "custom",
      skillContent: "x",
      author: "unknown",
      version: "1.0",
      license: null,
      iconName: null,
      metadata: { source_url: "https://example.test/pkg", package_name: "pkg" },
      sourceUrl: "https://example.test/pkg",
      packageName: "pkg",
    });

    // Byte-identical SQL: the shape of the payload cannot widen the write.
    expect(onlyDomain(marketplace.queries).sql).toBe(
      onlyDomain(minimal.queries).sql,
    );

    const metadata = onlyDomain(marketplace.queries).params?.[10];
    expect(typeof metadata).toBe("string");
    expect(JSON.parse(String(metadata))).toEqual({
      source_url: "https://example.test/pkg",
      package_name: "pkg",
    });

    // T-61 ②: the same two values also reach their OWN columns, bound after
    // `metadata`.
    expect(onlyDomain(marketplace.queries).params?.[11]).toBe(
      "https://example.test/pkg",
    );
    expect(onlyDomain(marketplace.queries).params?.[12]).toBe("pkg");
  });

  it("case 12: a unique-slug conflict surfaces as SQLSTATE 23505 on the error", async () => {
    const harness = createHarness(() => {
      throw Object.assign(
        new Error('duplicate key value violates unique constraint "skills_slug_key"'),
        { code: "23505" },
      );
    });

    const error = await repositoryFor(harness)
      .insertOwnSkill(ACTOR_ID, {
        name: "A",
        slug: "a",
        description: "",
        category: "custom",
        skillContent: "x",
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SkillRepositoryError);
    expect((error as SkillRepositoryError).operation).toBe(INSERT_OWN_SKILL);
    expect((error as SkillRepositoryError).sqlstate).toBe("23505");
    // The published message carries no SQL and no constraint name.
    expect((error as SkillRepositoryError).message).toBe(
      `skill repository failed (${INSERT_OWN_SKILL})`,
    );
    expect((error as SkillRepositoryError).message).not.toMatch(
      /public\.|skills_slug_key|duplicate/i,
    );
  });

  it("case 13: an unusable field is refused before the pool is touched", async () => {
    const harness = createHarness(() => [DRIVER_SKILL_ROW]);

    const error = await repositoryFor(harness)
      .insertOwnSkill(ACTOR_ID, {
        name: "",
        slug: "a",
        description: "",
        category: "custom",
        skillContent: "x",
      })
      .catch((reason: unknown) => reason);

    expect((error as SkillRepositoryError).operation).toBe(INSERT_OWN_SKILL);
    expect(harness.connectAttempts()).toBe(0);
  });
});

describe("skill-repository: insertOwnSkillFiles", () => {
  it("case 14: ONE statement for the whole batch, gated by the owner-only `exists` clause", async () => {
    const harness = createHarness(() => [{ id: FILE_ID }]);

    const result = await repositoryFor(harness).insertOwnSkillFiles(
      ACTOR_ID,
      SKILL_ID,
      [
        { filePath: "scripts/a.py", content: "print(1)\n", mimeType: "text/plain" },
        { filePath: "references/b.md", content: "# b\n" },
      ],
    );

    expect(result).toEqual({ inserted: 1 });

    const statement = onlyDomain(harness.queries);
    const sql = statement.sql;
    expect(sql).toContain("jsonb_to_recordset($3::jsonb)");
    // `skill_files_insert`: the skill must be a USER skill of the actor.
    expect(sql).toContain("s.source = 'user'");
    expect(sql).toContain("s.created_by = $1::uuid");
    expect(sql).toContain("s.id = $2::uuid");
    // An omitted mime type keeps the column DEFAULT.
    expect(sql).toContain("coalesce(f.mime_type, 'text/plain')");

    const payload = JSON.parse(String(statement.params?.[2]));
    expect(payload).toEqual([
      { file_path: "scripts/a.py", content: "print(1)\n", mime_type: "text/plain" },
      { file_path: "references/b.md", content: "# b\n", mime_type: null },
    ]);
    expect(statement.params?.slice(0, 2)).toEqual([ACTOR_ID, SKILL_ID]);
  });

  it("case 15: an empty batch is answered WITHOUT a connection", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).insertOwnSkillFiles(ACTOR_ID, SKILL_ID, []),
    ).resolves.toEqual({ inserted: 0 });

    expect(harness.connectAttempts()).toBe(0);
    expect(harness.queries).toHaveLength(0);
  });
});

describe("skill-repository: updateOwnSkill", () => {
  it("case 16: the three patch shapes produce BYTE-IDENTICAL SQL, and name/slug share one flag", async () => {
    const patches = [
      { name: "New Name", slug: "new-name" },
      { description: "New description" },
      { name: "New Name", slug: "new-name", category: "custom", icon_name: null },
    ] as const;

    const statements: QueryRecord[] = [];
    for (const patch of patches) {
      const harness = createHarness(() => [DRIVER_SKILL_ROW]);
      await repositoryFor(harness).updateOwnSkill(ACTOR_ID, SKILL_ID, patch);
      statements.push(onlyDomain(harness.queries));
    }

    expect(statements[1]?.sql).toBe(statements[0]?.sql);
    expect(statements[2]?.sql).toBe(statements[0]?.sql);

    const sql = statements[0]?.sql ?? "";
    // `skills_update_user`: the ownership predicate is the WHERE clause.
    expect(sql).toContain("s.id = $2::uuid");
    expect(sql).toContain("s.created_by = $1::uuid");
    // Six flag/value pairs, so the SET list never depends on the payload.
    for (const column of [
      "s.name",
      "s.slug",
      "s.description",
      "s.category",
      "s.skill_content",
      "s.icon_name",
    ]) {
      expect(sql).toContain(`else ${column} end`);
    }

    // Patch 1: name+slug only. Patch 3: name+slug, category and a cleared icon.
    expect(statements[0]?.params).toEqual([
      ACTOR_ID,
      SKILL_ID,
      true,
      "New Name",
      "new-name",
      false,
      null,
      false,
      null,
      false,
      null,
      false,
      null,
    ]);
    expect(statements[2]?.params).toEqual([
      ACTOR_ID,
      SKILL_ID,
      true,
      "New Name",
      "new-name",
      false,
      null,
      true,
      "custom",
      false,
      null,
      true,
      null,
    ]);
  });

  it("case 17: zero updated rows is `null`, not an error", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).updateOwnSkill(ACTOR_ID, SKILL_ID, {
        description: "x",
      }),
    ).resolves.toBeNull();
  });
});

describe("skill-repository: deleteOwnSkill and deleteWorkspaceSkill", () => {
  it("case 18: deleteOwnSkill counts the row it removed, owner predicate included", async () => {
    const harness = createHarness(() => [{ id: SKILL_ID }]);

    await expect(
      repositoryFor(harness).deleteOwnSkill(ACTOR_ID, SKILL_ID),
    ).resolves.toEqual({ deleted: 1 });

    const statement = onlyDomain(harness.queries);
    expect(statement.sql).toContain("delete from public.skills s");
    expect(statement.sql).toContain("s.id = $2::uuid");
    expect(statement.sql).toContain("s.created_by = $1::uuid");
    expect(statement.params).toEqual([ACTOR_ID, SKILL_ID]);
  });

  it("case 19: deleteWorkspaceSkill carries BOTH branches of admin_or_owner and counts zero as an answer", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).deleteWorkspaceSkill(
        ACTOR_ID,
        WORKSPACE_ID,
        SKILL_ID,
      ),
    ).resolves.toEqual({ deleted: 0 });

    const statement = onlyDomain(harness.queries);
    const sql = statement.sql;
    expect(sql).toContain("delete from public.workspace_skills ws");
    expect(sql).toContain("ws.workspace_id = $2::uuid");
    expect(sql).toContain("ws.skill_id = $3::uuid");
    // The two branches of private.is_workspace_admin_or_owner, verbatim.
    expect(sql).toContain("public.workspaces w");
    expect(sql).toContain("w.owner_user_id = $1::uuid");
    expect(sql).toContain("m.user_id = $1::uuid");
    expect(sql).toContain("m.role in ('owner', 'admin')");
    expect(statement.params).toEqual([ACTOR_ID, WORKSPACE_ID, SKILL_ID]);
  });
});

describe("skill-repository: upsertWorkspaceSkill", () => {
  it("case 20: both ACL branches, the conflict target, and `installed_at` left alone", async () => {
    const harness = createHarness(() => [{ id: "00000000-0000-0000-0000-0000000000f1" }]);

    await expect(
      repositoryFor(harness).upsertWorkspaceSkill(
        ACTOR_ID,
        WORKSPACE_ID,
        SKILL_ID,
        false,
      ),
    ).resolves.toBeUndefined();

    const statement = onlyDomain(harness.queries);
    const sql = statement.sql;
    expect(sql).toContain("insert into public.workspace_skills");
    // Branch 1: the workspace owner, even when their member row says otherwise.
    expect(sql).toContain("public.workspaces w");
    expect(sql).toContain("w.id = $2::uuid");
    expect(sql).toContain("w.owner_user_id = $1::uuid");
    // Branch 2: an owner/admin member row.
    expect(sql).toContain("m.role in ('owner', 'admin')");
    // The conflict path overwrites `enabled` and `installed_by` only.
    expect(sql).toContain("on conflict (workspace_id, skill_id) do update");
    expect(sql).toContain("set enabled = excluded.enabled");
    expect(sql).toContain("installed_by = excluded.installed_by");
    expect(sql).not.toContain("installed_at =");
    // $1 actor, $2 workspace, $3 skill, $4 enabled.
    expect(statement.params).toEqual([ACTOR_ID, WORKSPACE_ID, SKILL_ID, false]);
  });

  it("case 21: a refused upsert (no row admitted) THROWS instead of reporting a silent success", async () => {
    const harness = createHarness(() => []);

    const error = await repositoryFor(harness)
      .upsertWorkspaceSkill(ACTOR_ID, WORKSPACE_ID, SKILL_ID, true)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SkillRepositoryError);
    expect((error as SkillRepositoryError).operation).toBe(
      UPSERT_WORKSPACE_SKILL,
    );
    // Not a SQLSTATE: this module raised the refusal itself.
    expect((error as SkillRepositoryError).sqlstate).toBeNull();
    expect(String((error as SkillRepositoryError).cause)).toContain(
      "not permitted",
    );
  });
});

describe("skill-repository: failure classification", () => {
  it("case 22: a connect failure is classified, keeps the driver error as `cause`, and never answers empty", async () => {
    const harness = createHarness(() => [], {
      connectError: Object.assign(new Error("pool exhausted"), {
        code: "ECONNRESET",
      }),
    });

    const error = await repositoryFor(harness)
      .listVisibleSkills(ACTOR_ID)
      .catch((reason: unknown) => reason);

    // An empty catalogue and an unreachable database are DIFFERENT answers, and
    // only the route may decide to degrade.
    expect(error).toBeInstanceOf(SkillRepositoryError);
    expect((error as SkillRepositoryError).sqlstate).toBe("ECONNRESET");
    expect(String((error as SkillRepositoryError).cause)).toContain(
      "pool exhausted",
    );
  });

  it("case 23: a row that is not an object, and one with a `Date` it cannot use, are both shape failures", async () => {
    const notAnObject = createHarness(() => ["not-a-row"]);
    const firstError = await repositoryFor(notAnObject)
      .listVisibleSkills(ACTOR_ID)
      .catch((reason: unknown) => reason);

    expect(firstError).toBeInstanceOf(SkillRepositoryError);
    expect(String((firstError as SkillRepositoryError).cause)).toContain(
      "not an object",
    );

    const badDate = createHarness(() => [
      { ...DRIVER_SKILL_ROW, updated_at: new Date(Number.NaN) },
    ]);
    const secondError = await repositoryFor(badDate)
      .listVisibleSkills(ACTOR_ID)
      .catch((reason: unknown) => reason);

    expect(secondError).toBeInstanceOf(SkillRepositoryError);
    expect(String((secondError as SkillRepositoryError).cause)).toContain(
      "updated_at",
    );
  });
});
