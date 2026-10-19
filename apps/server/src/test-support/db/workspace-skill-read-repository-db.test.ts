import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TransactionPool } from "../../db/transaction.js";
import {
  LIST_SKILL_FILES,
  WorkspaceSkillReadError,
  createWorkspaceSkillReadRepository,
  type SkillFileRow,
  type WorkspaceSkillReadRepository,
  type WorkspaceSkillRow,
} from "../../db/workspace-skill-read-repository.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL identity matrix for the workspace skill READ repository (workorder
 * 21AC), measured against the three policies it replaces.
 *
 * Every case reads the same question THREE times for the same identity:
 *
 *   (1) through the repository, which is privileged — the database owner
 *       bypasses RLS, so the ONLY gate is each statement's own predicate: the
 *       `private.is_workspace_member` body plus `skills_select_all` /
 *       `skill_files_select` translated into SQL;
 *   (2) through `asUser()`, i.e. `set local role authenticated` plus a
 *       transaction-local `request.jwt.claim.sub` (the claim the PGlite stub's
 *       `auth.uid()` reads), running the EXACT two reads the removed PostgREST
 *       client performed — the workspace/enabled filter and the skill-id filter,
 *       caller filter and all — so the policies decide;
 *   (3) through `asUser()` again, running the same two joins with NO caller
 *       filter at all. Only the policies may narrow those, so this is the
 *       strongest of the three: it fails if the repository's predicate is
 *       narrower OR wider than the policy, including the case where a caller
 *       filter in (2) would have hidden a policy that is too generous.
 *
 * Two different ACLs are live at once and the fixture is built so a leak in
 * either direction is visible:
 *
 * - `workspace_skills` is readable by WORKSPACE MEMBERS, whatever their role;
 * - `skills` / `skill_files` are readable when the skill is `system`/`community`,
 *   or when its `created_by` is the caller — a membership does NOT make another
 *   member's private user skill visible.
 *
 * So MEMBER sees the two shared skills but not OWNER's private one, while
 * OUTSIDER sees neither the workspace's installs nor a private skill of anybody
 * else. That asymmetry is the whole point: an inner join that dropped the
 * visibility half would hand every member another member's private skills.
 *
 * PGlite runs in-process, in-repo: no server, no socket, no `DATABASE_URL`. One
 * instance is migrated in `beforeAll` (with the 120s timeout the parallel full
 * run needs), the identities are created through the real signup trigger, and
 * `afterAll` closes it. PGlite holds a single session, so nothing here runs
 * concurrently and no case may leave a transaction open for the next one.
 */

const OWNER_ID = "00000000-0000-0000-0000-0000000e1001";
const MEMBER_ID = "00000000-0000-0000-0000-0000000e1002";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000e1003";

const SYS_SKILL = "00000000-0000-0000-0000-0000000f2001";
const COMMUNITY_SKILL = "00000000-0000-0000-0000-0000000f2002";
const OWNER_SKILL = "00000000-0000-0000-0000-0000000f2003";
const OUTSIDER_SKILL = "00000000-0000-0000-0000-0000000f2004";
/** Installed in the team workspace with `enabled = false`. */
const DISABLED_SKILL = "00000000-0000-0000-0000-0000000f2005";

const TEAM_NAME = "Skill Read Team";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

type RawSkillRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  skill_content: string | null;
  metadata: Record<string, unknown> | null;
};

let db: PGlite;
let pool: TransactionPool;
let repository: WorkspaceSkillReadRepository;
let teamWorkspaceId: string;

/**
 * The removed PostgREST workspace-skill read, as SQL: the skill columns, joined
 * through the installed row, filtered to the workspace and to enabled installs.
 * Under `asUser()` the two policies do the authorising exactly as PostgREST's own
 * client did.
 */
const SELECT_ENABLED_SKILLS = `select s.id, s.slug, s.name, s.description, s.skill_content, s.metadata
  from public.workspace_skills ws
  join public.skills s on s.id = ws.skill_id
 where ws.workspace_id = $1::uuid and ws.enabled = true`;

/** The same join with NO workspace filter: only the policies may narrow it. */
const SELECT_ALL_ENABLED_SKILLS = `select ws.workspace_id, s.id, s.slug, s.name, s.description,
       s.skill_content, s.metadata
  from public.workspace_skills ws
  join public.skills s on s.id = ws.skill_id
 where ws.enabled = true`;

/** The removed PostgREST file read: `.in("skill_id", skillIds)`, three columns. */
const SELECT_SKILL_FILES = `select skill_id, file_path, content
  from public.skill_files where skill_id = any($1::uuid[])`;

/** The same table with NO filter: only `skill_files_select` may narrow it. */
const SELECT_ALL_SKILL_FILES = `select skill_id, file_path, content
  from public.skill_files`;

function sortSkills(rows: readonly WorkspaceSkillRow[]): WorkspaceSkillRow[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function sortFiles(rows: readonly SkillFileRow[]): SkillFileRow[] {
  return [...rows].sort((left, right) =>
    left.skill_id === right.skill_id
      ? left.file_path.localeCompare(right.file_path)
      : left.skill_id.localeCompare(right.skill_id),
  );
}

function canonicalSkills(rows: readonly Record<string, unknown>[]): WorkspaceSkillRow[] {
  return sortSkills(
    rows.map((row) => ({
      id: String(row["id"]),
      slug: String(row["slug"]),
      name: String(row["name"]),
      description: String(row["description"]),
      skill_content:
        row["skill_content"] === null || row["skill_content"] === undefined
          ? null
          : String(row["skill_content"]),
      metadata:
        row["metadata"] === null || row["metadata"] === undefined
          ? null
          : (row["metadata"] as Record<string, unknown>),
    })),
  );
}

/** (1) The repository read: privileged, with both ACLs written into the statements. */
async function skillsViaRepository(
  actorId: string,
  workspaceId = teamWorkspaceId,
): Promise<WorkspaceSkillRow[]> {
  return sortSkills(
    await repository.listEnabledWorkspaceSkills({ actorId, workspaceId }),
  );
}

/**
 * (2) The read the removed PostgREST client performed: the caller's own identity
 * AND the caller's own filters, so `ws_skills_select` and `skills_select_all`
 * decide what exists.
 */
async function skillsViaPolicy(
  actorId: string,
  workspaceId = teamWorkspaceId,
): Promise<WorkspaceSkillRow[]> {
  const rows = await asUser(db, actorId, async (tx) =>
    (await tx.query<RawSkillRow>(SELECT_ENABLED_SKILLS, [workspaceId])).rows,
  );

  return canonicalSkills(rows as unknown as Record<string, unknown>[]);
}

/**
 * (3) The same join with NO caller filter: the policies alone decide, so a
 * predicate that is wider than the policy shows up here even though (2) would
 * have agreed. The rows are narrowed to the workspace of interest in JS only,
 * because "which workspace" is the question under test, not the filter used to
 * ask it.
 */
async function skillsViaRlsOnly(
  actorId: string,
  workspaceId = teamWorkspaceId,
): Promise<WorkspaceSkillRow[]> {
  const rows = await asUser(db, actorId, async (tx) =>
    (
      await tx.query<RawSkillRow & { workspace_id: string }>(
        SELECT_ALL_ENABLED_SKILLS,
      )
    ).rows.filter((row) => row.workspace_id === workspaceId),
  );

  return canonicalSkills(rows as unknown as Record<string, unknown>[]);
}

async function filesViaRepository(
  actorId: string,
  skillIds: readonly string[],
): Promise<SkillFileRow[]> {
  return sortFiles(await repository.listSkillFiles({ actorId, skillIds }));
}

async function filesViaPolicy(
  actorId: string,
  skillIds: readonly string[],
): Promise<SkillFileRow[]> {
  const rows = await asUser(db, actorId, async (tx) =>
    (await tx.query<SkillFileRow>(SELECT_SKILL_FILES, [[...skillIds]])).rows,
  );

  return sortFiles(rows);
}

async function filesViaRlsOnly(
  actorId: string,
  skillIds: readonly string[],
): Promise<SkillFileRow[]> {
  const wanted = new Set(skillIds);
  const rows = await asUser(db, actorId, async (tx) =>
    (await tx.query<SkillFileRow>(SELECT_ALL_SKILL_FILES)).rows,
  );

  return sortFiles(rows.filter((row) => wanted.has(row.skill_id)));
}

/** The comparison this file exists for: three reads, one identity, one answer. */
async function expectAllThreeReads(
  actorId: string,
  expected: WorkspaceSkillRow[],
): Promise<void> {
  const byRepository = await skillsViaRepository(actorId);
  const byPolicy = await skillsViaPolicy(actorId);
  const byRlsOnly = await skillsViaRlsOnly(actorId);

  expect(byPolicy).toEqual(expected);
  expect(byRlsOnly).toEqual(expected);
  expect(byRepository).toEqual(expected);
}

async function expectAllThreeFileReads(
  actorId: string,
  skillIds: readonly string[],
  expected: SkillFileRow[],
): Promise<void> {
  const byRepository = await filesViaRepository(actorId, skillIds);
  const byPolicy = await filesViaPolicy(actorId, skillIds);
  const byRlsOnly = await filesViaRlsOnly(actorId, skillIds);

  expect(byPolicy).toEqual(expected);
  expect(byRlsOnly).toEqual(expected);
  expect(byRepository).toEqual(expected);
}

async function insertSkill(options: {
  id: string;
  slug: string;
  source: "system" | "community" | "user";
  createdBy: string | null;
  content: string | null;
}): Promise<void> {
  await db.query(
    `insert into public.skills (id, name, slug, description, source, created_by, skill_content, metadata)
     values ($1, $2, $3, $4, $5::text, $6, $7, '{"tags":["t"]}'::jsonb)`,
    [
      options.id,
      `Skill ${options.slug}`,
      options.slug,
      `Description of ${options.slug}`,
      options.source,
      options.createdBy,
      options.content ?? `# ${options.slug}\nContent.`,
    ],
  );
}

async function installSkill(
  workspaceId: string,
  skillId: string,
  enabled: boolean,
): Promise<void> {
  await db.query(
    `insert into public.workspace_skills (workspace_id, skill_id, enabled)
     values ($1, $2, $3)`,
    [workspaceId, skillId, enabled],
  );
}

async function insertSkillFile(
  skillId: string,
  filePath: string,
  content: string,
): Promise<void> {
  await db.query(
    `insert into public.skill_files (skill_id, file_path, content)
     values ($1, $2, $3)`,
    [skillId, filePath, content],
  );
}

/** Sorted by id, which is the order every comparison in this file uses. */
const EXPECTED_FOR_OWNER: WorkspaceSkillRow[] = [
  {
    id: SYS_SKILL,
    slug: "sys-skill",
    name: "Skill sys-skill",
    description: "Description of sys-skill",
    skill_content: "# sys-skill\nContent.",
    metadata: { tags: ["t"] },
  },
  {
    id: COMMUNITY_SKILL,
    slug: "community-skill",
    name: "Skill community-skill",
    description: "Description of community-skill",
    skill_content: "# community-skill\nContent.",
    metadata: { tags: ["t"] },
  },
  {
    id: OWNER_SKILL,
    slug: "owner-skill",
    name: "Skill owner-skill",
    description: "Description of owner-skill",
    skill_content: "# owner-skill\nContent.",
    metadata: { tags: ["t"] },
  },
];

/** MEMBER is a member, so the shared skills arrive — OWNER's private one does not. */
const EXPECTED_FOR_MEMBER: WorkspaceSkillRow[] = [
  {
    id: SYS_SKILL,
    slug: "sys-skill",
    name: "Skill sys-skill",
    description: "Description of sys-skill",
    skill_content: "# sys-skill\nContent.",
    metadata: { tags: ["t"] },
  },
  {
    id: COMMUNITY_SKILL,
    slug: "community-skill",
    name: "Skill community-skill",
    description: "Description of community-skill",
    skill_content: "# community-skill\nContent.",
    metadata: { tags: ["t"] },
  },
];

const EXPECTED_FOR_OUTSIDER: WorkspaceSkillRow[] = [];

/** The four ENABLED installs of the team workspace; the disabled one has its own case. */
const ALL_ENABLED_INSTALLS = [
  SYS_SKILL,
  COMMUNITY_SKILL,
  OWNER_SKILL,
  OUTSIDER_SKILL,
];

/**
 * Exactly the ids statement 1 answers for OWNER — i.e. what the real flow feeds
 * into the file read. Asking with anything else would measure the file policy
 * rather than the wiring of the two reads.
 */
const VISIBLE_TO_OWNER = [SYS_SKILL, COMMUNITY_SKILL, OWNER_SKILL];

/** Every installed id, the disabled one included. */
const ALL_INSTALLED = [...ALL_ENABLED_INSTALLS, DISABLED_SKILL];

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createWorkspaceSkillReadRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity. Skill fixtures are then seeded as the database
  // owner, so the fixture itself is never gated by a policy.
  await createUser(db, OWNER_ID, "workspace-skill-read-owner@hahart.test");
  await createUser(db, MEMBER_ID, "workspace-skill-read-member@hahart.test");
  await createUser(db, OUTSIDER_ID, "workspace-skill-read-outsider@hahart.test");

  teamWorkspaceId = (
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', $1, $2)
         returning id`,
        [TEAM_NAME, OWNER_ID],
      )
    ).rows[0] as { id: string }
  ).id;

  // OWNER is the workspace owner, MEMBER an ordinary member. A plain member is
  // enough for `ws_skills_select` on purpose: the policy asks for membership,
  // never for a role.
  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role)
     values ($1, $2, 'owner'), ($1, $3, 'member')`,
    [teamWorkspaceId, OWNER_ID, MEMBER_ID],
  );

  // `20260403000001_fix_skills_toggle.sql` adds a trigger that installs EVERY
  // `system` skill into every new workspace, and per-workspace rows are unique. The
  // fixture needs a known install set, so the auto-installed rows of this one
  // workspace are cleared as the database owner and replaced by the five below.
  // Deleting them is fixture setup, not a statement about the trigger: case 8
  // below still covers a system skill whose install is disabled.
  await db.query(
    `delete from public.workspace_skills where workspace_id = $1`,
    [teamWorkspaceId],
  );

  await insertSkill({
    id: SYS_SKILL,
    slug: "sys-skill",
    source: "system",
    createdBy: null,
    content: null,
  });
  await insertSkill({
    id: COMMUNITY_SKILL,
    slug: "community-skill",
    source: "community",
    createdBy: null,
    content: null,
  });
  await insertSkill({
    id: OWNER_SKILL,
    slug: "owner-skill",
    source: "user",
    createdBy: OWNER_ID,
    content: null,
  });
  await insertSkill({
    id: OUTSIDER_SKILL,
    slug: "outsider-skill",
    source: "user",
    createdBy: OUTSIDER_ID,
    content: null,
  });
  await insertSkill({
    id: DISABLED_SKILL,
    slug: "disabled-skill",
    source: "system",
    createdBy: null,
    content: null,
  });

  // Every installed row is ENABLED except the last one, so "not returned" can only
  // mean "the enabled predicate refused it" rather than "it was never installed".
  await installSkill(teamWorkspaceId, SYS_SKILL, true);
  await installSkill(teamWorkspaceId, COMMUNITY_SKILL, true);
  await installSkill(teamWorkspaceId, OWNER_SKILL, true);
  await installSkill(teamWorkspaceId, OUTSIDER_SKILL, true);
  await installSkill(teamWorkspaceId, DISABLED_SKILL, false);

  await insertSkillFile(SYS_SKILL, "scripts/analyze.py", "print('sys')\n");
  await insertSkillFile(COMMUNITY_SKILL, "references/guide.md", "# guide\n");
  await insertSkillFile(OWNER_SKILL, "assets/logo.png", "png-bytes");
  await insertSkillFile(OUTSIDER_SKILL, "scripts/private.py", "print('private')\n");
  // The disabled skill HAS a file: a file read that ignored the workspace install
  // would hand it out, so its absence below is meaningful.
  await insertSkillFile(DISABLED_SKILL, "scripts/disabled.py", "print('off')\n");
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("workspace skill read repository: the fixture the matrix runs against", () => {
  it("case 1: five fixture installs (one disabled) and five files in the team workspace, all seeded as the owner", async () => {
    // Counted per workspace on purpose: the signup trigger and
    // `init_workspace_skills` install system skills into every new workspace, so
    // the GLOBAL totals of these tables are not this fixture's business. What the
    // cases depend on is the install set of the team workspace below.
    const counts = (
      await db.query<{ installs: number; enabled_installs: number; files: number }>(
        `select
           (select count(*)::int from public.workspace_skills where workspace_id = $1) as installs,
           (select count(*)::int from public.workspace_skills
             where workspace_id = $1 and enabled) as enabled_installs,
           (select count(*)::int from public.skill_files) as files`,
        [teamWorkspaceId],
      )
    ).rows[0];

    expect(counts).toEqual({
      installs: 5,
      enabled_installs: 4,
      files: 5,
    });

    // The memberships are exactly the two the cases assume: OUTSIDER is in none.
    const members = (
      await db.query<{ user_id: string; role: string }>(
        `select user_id, role from public.workspace_members
          where workspace_id = $1 order by user_id`,
        [teamWorkspaceId],
      )
    ).rows;

    expect(members).toEqual([
      { user_id: OWNER_ID, role: "owner" },
      { user_id: MEMBER_ID, role: "member" },
    ]);
  });
});

describe("workspace skill read repository: enabled skills per identity", () => {
  it("case 2: the workspace OWNER reads the shared skills AND their own user skill, through all three reads", async () => {
    await expectAllThreeReads(OWNER_ID, EXPECTED_FOR_OWNER);

    // The private skill of another user is absent even though the INSTALL is
    // enabled — that is `skills_select_all` doing its job on the join.
    expect(
      (await skillsViaRepository(OWNER_ID)).some(
        (skill) => skill.id === OUTSIDER_SKILL,
      ),
    ).toBe(false);
    // An install that is `enabled = false` is not returned either.
    expect(
      (await skillsViaRepository(OWNER_ID)).some(
        (skill) => skill.id === DISABLED_SKILL,
      ),
    ).toBe(false);
  });

  it("case 3: a plain MEMBER reads the shared skills, but NOT the owner's private user skill", async () => {
    await expectAllThreeReads(MEMBER_ID, EXPECTED_FOR_MEMBER);

    // The difference from case 2 is EXACTLY one row, and it is the visibility
    // clause that removes it: MEMBER is a member, so membership alone would have
    // been enough to see the install.
    const forMember = await skillsViaRepository(MEMBER_ID);
    expect(forMember.map((skill) => skill.id)).toEqual([
      SYS_SKILL,
      COMMUNITY_SKILL,
    ]);
    expect(forMember.some((skill) => skill.id === OWNER_SKILL)).toBe(false);
  });

  it("case 4: a non-member reads NOTHING, while the same query answers rows for members", async () => {
    await expectAllThreeReads(OUTSIDER_ID, EXPECTED_FOR_OUTSIDER);

    // "Empty" here means "not a member": the identical statement answers three
    // rows for OWNER and two for MEMBER. The workspace is not empty.
    expect(await skillsViaRepository(OWNER_ID)).toHaveLength(3);
    expect(await skillsViaRepository(MEMBER_ID)).toHaveLength(2);
  });

  it("case 5: a non-member's OWN workspace still answers its own installs, so the refusal is per workspace", async () => {
    // Every identity owns a personal workspace from signup; install a shared
    // skill into OUTSIDER's own workspace. Their own answer must NOT stay empty,
    // which proves the empty answer in case 4 is the membership predicate and not
    // a broken repository.
    const personalWorkspaceId = (
      await db.query<{ id: string }>(
        `select id from public.workspaces
          where owner_user_id = $1 and type = 'personal'`,
        [OUTSIDER_ID],
      )
    ).rows[0]?.id;

    expect(typeof personalWorkspaceId).toBe("string");

    // Same trigger cleanup as the team workspace: this case measures one install,
    // not whatever the signup trigger put there.
    await db.query(
      `delete from public.workspace_skills where workspace_id = $1`,
      [personalWorkspaceId],
    );
    await installSkill(personalWorkspaceId!, SYS_SKILL, true);

    const own = await skillsViaRepository(OUTSIDER_ID, personalWorkspaceId!);
    expect(own.map((skill) => skill.id)).toEqual([SYS_SKILL]);
    // And the team workspace still answers them nothing.
    await expect(
      skillsViaRepository(OUTSIDER_ID, teamWorkspaceId),
    ).resolves.toEqual([]);

    await db.query(
      `delete from public.workspace_skills where workspace_id = $1 and skill_id = $2`,
      [personalWorkspaceId, SYS_SKILL],
    );
  });
});

describe("workspace skill read repository: skill files follow skill visibility", () => {
  it("case 6: the owner reads the files of the visible skills only — never another user's private one", async () => {
    // Sorted by `skill_id`, which is the order every comparison here uses.
    await expectAllThreeFileReads(OWNER_ID, VISIBLE_TO_OWNER, [
      { skill_id: SYS_SKILL, file_path: "scripts/analyze.py", content: "print('sys')\n" },
      { skill_id: COMMUNITY_SKILL, file_path: "references/guide.md", content: "# guide\n" },
      { skill_id: OWNER_SKILL, file_path: "assets/logo.png", content: "png-bytes" },
    ]);
  });

  it("case 7: a member never reads the owner's private file, and a non-member keeps the shared ones plus their own", async () => {
    // MEMBER: membership is irrelevant to this read — `skill_files_select` is
    // about the skill's source/author alone.
    await expectAllThreeFileReads(MEMBER_ID, ALL_ENABLED_INSTALLS, [
      { skill_id: SYS_SKILL, file_path: "scripts/analyze.py", content: "print('sys')\n" },
      { skill_id: COMMUNITY_SKILL, file_path: "references/guide.md", content: "# guide\n" },
    ]);

    // OUTSIDER: exactly one MORE row than MEMBER, and it is their OWN private skill
    // — `created_by = auth.uid()` holds for them. The shared files are visible to
    // every authenticated user by policy; in the real flow these ids can only come
    // from statement 1, which answers `[]` for a non-member, so this call is never
    // made with them.
    await expectAllThreeFileReads(OUTSIDER_ID, ALL_ENABLED_INSTALLS, [
      { skill_id: SYS_SKILL, file_path: "scripts/analyze.py", content: "print('sys')\n" },
      { skill_id: COMMUNITY_SKILL, file_path: "references/guide.md", content: "# guide\n" },
      { skill_id: OUTSIDER_SKILL, file_path: "scripts/private.py", content: "print('private')\n" },
    ]);

    // Neither identity ever reaches the OWNER's private file — the one row the
    // visibility clause exists to withhold from a workspace member.
    for (const actorId of [MEMBER_ID, OUTSIDER_ID]) {
      const rows = await filesViaRepository(actorId, ALL_ENABLED_INSTALLS);
      expect(rows.some((row) => row.skill_id === OWNER_SKILL)).toBe(false);
    }
  });

  it("case 8: the disabled skill's file is readable by the POLICY but is never reached by the flow", async () => {
    // The file policy does not know about `workspace_skills.enabled`: the disabled
    // skill's file is as visible as any other system skill's. That is exactly the
    // removed behaviour — the flow's protection is that the file ids come from the
    // enabled-only read in statement 1, which never returns DISABLED_SKILL.
    await expect(
      filesViaRepository(OWNER_ID, [DISABLED_SKILL]),
    ).resolves.toEqual([
      { skill_id: DISABLED_SKILL, file_path: "scripts/disabled.py", content: "print('off')\n" },
    ]);

    const enabledOnly = (await skillsViaRepository(OWNER_ID)).map(
      (skill) => skill.id,
    );
    expect(enabledOnly).not.toContain(DISABLED_SKILL);
  });

  it("case 9: an empty skill-id list answers `[]` without a statement, for every identity", async () => {
    for (const actorId of [OWNER_ID, MEMBER_ID, OUTSIDER_ID]) {
      await expect(filesViaRepository(actorId, [])).resolves.toEqual([]);
    }
  });
});

describe("workspace skill read repository: bad binds and read-only behaviour", () => {
  it("case 10: a malformed uuid is a real SQL error (22P02) on both reads, and the pool reads again afterwards", async () => {
    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query("select id from public.workspace_skills where workspace_id = $1::uuid", [
        INVALID_ID,
      ]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const skillsError = await repository
      .listEnabledWorkspaceSkills({
        actorId: INVALID_ID,
        workspaceId: teamWorkspaceId,
      })
      .catch((reason: unknown) => reason);

    expect(skillsError).toBeInstanceOf(WorkspaceSkillReadError);
    expect((skillsError as WorkspaceSkillReadError).message).toBe(
      "workspace skill read failed (listEnabledWorkspaceSkills)",
    );
    expect(((skillsError as WorkspaceSkillReadError).cause as { code?: string }).code).toBe(
      "22P02",
    );

    const filesError = await repository
      .listSkillFiles({ actorId: OWNER_ID, skillIds: [INVALID_ID] })
      .catch((reason: unknown) => reason);

    expect(filesError).toBeInstanceOf(WorkspaceSkillReadError);
    expect((filesError as WorkspaceSkillReadError).operation).toBe(LIST_SKILL_FILES);
    expect(((filesError as WorkspaceSkillReadError).cause as { code?: string }).code).toBe(
      "22P02",
    );

    // The fixed messages carry no SQL, no host and no id.
    for (const error of [skillsError, filesError]) {
      expect((error as Error).message).not.toMatch(
        /public\.|workspace_skills|skill_files|invalid input|postgres:\/\//i,
      );
    }

    // ROLLBACK plus release left the connection usable for the next read.
    await expect(skillsViaRepository(OWNER_ID)).resolves.toEqual(EXPECTED_FOR_OWNER);
  });

  it("case 11: the reads modify nothing — same installs, same files, same enablement", async () => {
    const snapshot = async () =>
      (
        await db.query<{ table_name: string; rows: number; enabled: number }>(
          `select 'workspace_skills' as table_name,
                  count(*)::int as rows,
                  count(*) filter (where enabled)::int as enabled
             from public.workspace_skills
            union all
           select 'skill_files', count(*)::int, 0
             from public.skill_files`,
        )
      ).rows;

    const before = await snapshot();

    await skillsViaRepository(OWNER_ID);
    await skillsViaRepository(MEMBER_ID);
    await skillsViaRepository(OUTSIDER_ID);
    await filesViaRepository(OWNER_ID, ALL_INSTALLED);
    await filesViaPolicy(MEMBER_ID, ALL_INSTALLED);
    await filesViaRlsOnly(OUTSIDER_ID, ALL_INSTALLED);

    expect(await snapshot()).toEqual(before);
  });
});
