import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SkillRepositoryError,
  createSkillRepository,
  type SkillRepository,
  type SkillRow,
  type WorkspaceInstalledSkillRow,
} from "../../db/skill-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL identity matrix for the skill repository (workorder 21AE), measured
 * against the five policies it replaces.
 *
 * Every read is asked THREE times for the same identity:
 *
 *   (1) through the repository, which is privileged — the database owner bypasses
 *       RLS, so the ONLY gate is each statement's own predicate;
 *   (2) through `asUser()`, i.e. `set local role authenticated` plus a
 *       transaction-local `request.jwt.claim.sub` (the claim the PGlite stub's
 *       `auth.uid()` reads), running the read the removed PostgREST client
 *       performed — caller filter and all — so the policies decide;
 *   (3) through `asUser()` again, with the caller filter REMOVED where a read has
 *       one, so only the policies narrow the answer. This is the strongest of the
 *       three: it fails if the repository's predicate is narrower OR wider than
 *       the policy, including the case where a caller filter in (2) would have
 *       hidden a policy that is too generous.
 *
 * Two different ACLs are live at once and the fixture is built so a leak in
 * either direction is visible:
 *
 * - `skills` / `skill_files` are readable when the skill is `system`/`community`,
 *   or when its `created_by` is the caller — a workspace membership does NOT make
 *   another member's private user skill visible;
 * - `workspace_skills` is readable by WORKSPACE MEMBERS whatever their role, and
 *   writable only by an admin/owner — where "owner" has TWO sources,
 *   `workspaces.owner_user_id` and a member row with role owner/admin.
 *
 * The fixture deliberately gives the workspace OWNER a member row whose role is
 * `member`: nothing but the `owner_user_id` branch can let them install or
 * uninstall, which is how "both branches were translated" is observed instead of
 * asserted in prose.
 *
 * PGlite runs in-process, in-repo: no server, no socket, no `DATABASE_URL`. One
 * instance is migrated in `beforeAll` (with the 120s timeout the parallel full
 * run needs), the identities are created through the real signup trigger, and
 * `afterAll` closes it. PGlite holds a single session, so nothing here runs
 * concurrently and no case may leave a transaction open for the next one.
 *
 * `20260403000001_fix_skills_toggle.sql` installs EVERY `system` skill into every
 * new workspace through `trg_init_workspace_skills`, so each workspace the fixture
 * cares about has those rows deleted before its own install set is written.
 */

const OWNER_ID = "00000000-0000-0000-0000-0000000e2001";
const ADMIN_ID = "00000000-0000-0000-0000-0000000e2002";
const MEMBER_ID = "00000000-0000-0000-0000-0000000e2003";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000e2004";

const SYS_SKILL = "00000000-0000-0000-0000-0000000f3001";
const COMMUNITY_SKILL = "00000000-0000-0000-0000-0000000f3002";
const OWNER_SKILL = "00000000-0000-0000-0000-0000000f3003";
const MEMBER_SKILL = "00000000-0000-0000-0000-0000000f3004";
const OUTSIDER_SKILL = "00000000-0000-0000-0000-0000000f3005";
/** Installed in the team workspace with `enabled = false`. */
const DISABLED_SKILL = "00000000-0000-0000-0000-0000000f3006";

const OWNER_TARGET = "00000000-0000-0000-0000-0000000f3011";
const ADMIN_TARGET = "00000000-0000-0000-0000-0000000f3012";
const MEMBER_TARGET = "00000000-0000-0000-0000-0000000f3013";
const DELETE_TARGET = "00000000-0000-0000-0000-0000000f3014";

/** Installed in the write workspace by the fixture, for the "member cannot delete" case. */
const TEAM_NAME = "Skill Repository Team";

/**
 * Not used as a team workspace: `workspaces_single_team_key` allows exactly ONE
 * team row in the whole database, so the write cases run in a PERSONAL workspace.
 * That is also the cleanest way to test the `workspaces.owner_user_id` branch,
 * because a personal workspace's owner normally has a member row with role
 * `owner` — the fixture downgrades that row to `member`, leaving only
 * `owner_user_id` able to authorise the install.
 */

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

type RawSkillRow = { id: string };

let db: PGlite;
let pool: TransactionPool;
let repository: SkillRepository;
let teamWorkspaceId: string;
let writeWorkspaceId: string;
/**
 * The two `system` skills the migrations themselves seed (`canvas-design`,
 * `json-image-prompt`). They are part of every catalogue the queries below return,
 * so the expectations carry their generated ids instead of pretending the
 * catalogue starts empty.
 */
let seededSkillIds: string[] = [];

/** The removed PostgREST catalogue read: `.select("*")` with no filter at all. */
const SELECT_ALL_SKILLS = `select id, name, slug, description, author, version, license,
       category, icon_name, source, skill_content, metadata, is_featured,
       created_by, created_at, updated_at, source_url, package_name
  from public.skills`;

/** The same table with NO filter: only `skills_select_all` may narrow it. */
const SELECT_SKILL_BY_ID = `${SELECT_ALL_SKILLS} where id = $1::uuid`;

/** The removed PostgREST file read: `.eq("skill_id", id)`. */
const SELECT_SKILL_FILES = `select id, skill_id, file_path, content, mime_type,
       created_at, updated_at
  from public.skill_files where skill_id = $1::uuid`;

const SELECT_ALL_SKILL_FILES = `select id, skill_id, file_path, content, mime_type,
       created_at, updated_at
  from public.skill_files`;

/**
 * The removed PostgREST install read: `workspace_skills` with the skill embedded
 * (`.select("skill_id, enabled, installed_at, skills(*)")`), filtered to the
 * workspace. PostgREST applied `skills_select_all` to the EMBEDDED resource, so an
 * install whose skill the caller may not see came back with `skills === null` and
 * the route dropped it — which is exactly what an INNER JOIN does here while the
 * policies, not this SQL, decide which skill rows survive.
 */
const SELECT_INSTALLS = `select ws.skill_id, ws.enabled
  from public.workspace_skills ws
  join public.skills s on s.id = ws.skill_id
 where ws.workspace_id = $1::uuid`;

/** The same join with NO workspace filter: only the policies may narrow it. */
const SELECT_ALL_INSTALLS = `select ws.workspace_id, ws.skill_id, ws.enabled
  from public.workspace_skills ws
  join public.skills s on s.id = ws.skill_id`;

function sortById<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

/** (1) The repository read. */
async function skillsViaRepository(actorId: string): Promise<SkillRow[]> {
  return sortById(await repository.listVisibleSkills(actorId));
}

/** (2)+(3) The policy read: one SELECT, no filter, so the policies alone decide. */
async function skillsViaPolicy(actorId: string): Promise<RawSkillRow[]> {
  const rows = await asUser(db, actorId, async (tx) =>
    (await tx.query<RawSkillRow>(SELECT_ALL_SKILLS)).rows,
  );

  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

/** The comparison this file exists for: both reads, one identity, one answer. */
async function expectSkillsFor(
  actorId: string,
  expected: readonly string[],
): Promise<void> {
  const byRepository = (await skillsViaRepository(actorId)).map((row) => row.id);
  const byPolicy = (await skillsViaPolicy(actorId)).map((row) => row.id);

  expect(byPolicy).toEqual(expected);
  expect(byRepository).toEqual(expected);
}

async function findViaRepository(
  actorId: string,
  skillId: string,
): Promise<SkillRow | null> {
  return repository.findVisibleSkill(actorId, skillId);
}

/** (2) The caller's own `where id = …` read under the policies. */
async function findViaPolicy(
  actorId: string,
  skillId: string,
): Promise<RawSkillRow | null> {
  const rows = await asUser(db, actorId, async (tx) =>
    (await tx.query<RawSkillRow>(SELECT_SKILL_BY_ID, [skillId])).rows,
  );

  return rows[0] ?? null;
}

/** (3) The same lookup with NO caller filter: the policies alone decide. */
async function findViaRlsOnly(
  actorId: string,
  skillId: string,
): Promise<RawSkillRow | null> {
  const rows = await skillsViaPolicy(actorId);
  return rows.find((row) => row.id === skillId) ?? null;
}

async function filesViaRepository(
  actorId: string,
  skillId: string,
): Promise<string[]> {
  const rows = await repository.listVisibleSkillFiles(actorId, skillId);
  return rows.map((row) => row.file_path).sort();
}

async function filesViaPolicy(
  actorId: string,
  skillId: string,
): Promise<string[]> {
  const rows = await asUser(db, actorId, async (tx) =>
    (await tx.query<{ file_path: string }>(SELECT_SKILL_FILES, [skillId])).rows,
  );

  return rows.map((row) => row.file_path).sort();
}

async function filesViaRlsOnly(
  actorId: string,
  skillId: string,
): Promise<string[]> {
  const rows = await asUser(db, actorId, async (tx) =>
    (await tx.query<{ skill_id: string; file_path: string }>(
      SELECT_ALL_SKILL_FILES,
    )).rows,
  );

  return rows
    .filter((row) => row.skill_id === skillId)
    .map((row) => row.file_path)
    .sort();
}

async function installsViaRepository(
  actorId: string,
  workspaceId = teamWorkspaceId,
): Promise<WorkspaceInstalledSkillRow[]> {
  return repository.listWorkspaceInstalledSkills(actorId, workspaceId);
}

async function installsViaPolicy(
  actorId: string,
  workspaceId = teamWorkspaceId,
): Promise<Array<{ skill_id: string; enabled: boolean }>> {
  const rows = await asUser(db, actorId, async (tx) =>
    (
      await tx.query<{ skill_id: string; enabled: boolean }>(SELECT_INSTALLS, [
        workspaceId,
      ])
    ).rows,
  );

  return rows
    .map((row) => ({ skill_id: row.skill_id, enabled: row.enabled }))
    .sort((left, right) => left.skill_id.localeCompare(right.skill_id));
}

async function installsViaRlsOnly(
  actorId: string,
  workspaceId = teamWorkspaceId,
): Promise<Array<{ skill_id: string; enabled: boolean }>> {
  const rows = await asUser(db, actorId, async (tx) =>
    (
      await tx.query<{
        workspace_id: string;
        skill_id: string;
        enabled: boolean;
      }>(SELECT_ALL_INSTALLS)
    ).rows,
  );

  return rows
    .filter((row) => row.workspace_id === workspaceId)
    .map((row) => ({ skill_id: row.skill_id, enabled: row.enabled }))
    .sort((left, right) => left.skill_id.localeCompare(right.skill_id));
}

async function insertSkill(options: {
  id: string;
  slug: string;
  source: "system" | "community" | "user";
  createdBy: string | null;
}): Promise<void> {
  await db.query(
    `insert into public.skills (id, name, slug, description, source, created_by, skill_content)
     values ($1, $2, $3, $4, $5::text, $6, $7)`,
    [
      options.id,
      `Skill ${options.slug}`,
      options.slug,
      `Description of ${options.slug}`,
      options.source,
      options.createdBy,
      `# ${options.slug}\nContent.`,
    ],
  );
}

async function installSkill(
  workspaceId: string,
  skillId: string,
  enabled: boolean,
  installedAt: string,
): Promise<void> {
  await db.query(
    `insert into public.workspace_skills (workspace_id, skill_id, enabled, installed_at)
     values ($1, $2, $3, $4::timestamptz)`,
    [workspaceId, skillId, enabled, installedAt],
  );
}

async function insertSkillFile(
  skillId: string,
  filePath: string,
  content: string,
): Promise<void> {
  await db.query(
    `insert into public.skill_files (skill_id, file_path, content) values ($1, $2, $3)`,
    [skillId, filePath, content],
  );
}

async function createTeamWorkspace(
  name: string,
  ownerUserId: string,
): Promise<string> {
  const id = (
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', $1, $2)
         returning id`,
        [name, ownerUserId],
      )
    ).rows[0] as { id: string }
  ).id;

  // `trg_init_workspace_skills` just installed every `system` skill. This fixture
  // needs a known install set, so those rows are cleared as the database owner.
  await db.query(
    `delete from public.workspace_skills where workspace_id = $1`,
    [id],
  );

  return id;
}

/** A personal workspace of `ownerUserId`, with the trigger's installs cleared. */
async function personalWorkspaceOf(ownerUserId: string): Promise<string> {
  const row = (
    await db.query<{ id: string }>(
      `select id from public.workspaces
        where owner_user_id = $1 and type = 'personal'`,
      [ownerUserId],
    )
  ).rows[0];

  if (!row) throw new Error("fixture: no personal workspace for the owner");

  await db.query(
    `delete from public.workspace_skills where workspace_id = $1`,
    [row.id],
  );

  return row.id;
}

/** The installs of the read workspace, as sorted `skill_id`s, for the expectations. */
const EXPECTED_INSTALLS_FOR_OWNER = [
  SYS_SKILL,
  COMMUNITY_SKILL,
  OWNER_SKILL,
  DISABLED_SKILL,
].sort();

const EXPECTED_INSTALLS_FOR_MEMBER = [
  SYS_SKILL,
  COMMUNITY_SKILL,
  MEMBER_SKILL,
  DISABLED_SKILL,
].sort();

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createSkillRepository({ getTransactionPool: () => pool });

  seededSkillIds = (
    await db.query<{ id: string }>(
      `select id from public.skills where slug in ('canvas-design', 'json-image-prompt')`,
    )
  ).rows.map((row) => row.id);

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity. Skill fixtures are then seeded as the database
  // owner, so the fixture itself is never gated by a policy.
  await createUser(db, OWNER_ID, "skill-repo-owner@hahart.test");
  await createUser(db, ADMIN_ID, "skill-repo-admin@hahart.test");
  await createUser(db, MEMBER_ID, "skill-repo-member@hahart.test");
  await createUser(db, OUTSIDER_ID, "skill-repo-outsider@hahart.test");

  teamWorkspaceId = await createTeamWorkspace(TEAM_NAME, OWNER_ID);
  // See `personalWorkspaceOf`: only one team workspace may exist database-wide, so
  // the WRITE cases use this personal workspace of OUTSIDER's.
  writeWorkspaceId = await personalWorkspaceOf(OUTSIDER_ID);

  // OWNER's member row in the TEAM workspace says `member` ON PURPOSE: only
  // `workspaces.owner_user_id` can make them an administrator there. ADMIN is an
  // administrator through the OTHER branch. MEMBER is an ordinary member.
  // OUTSIDER is in neither workspace.
  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role)
     values ($1, $2, 'member'), ($1, $3, 'admin'), ($1, $4, 'member')`,
    [teamWorkspaceId, OWNER_ID, ADMIN_ID, MEMBER_ID],
  );

  // In the WRITE workspace the owner's own member row is DOWNGRADED to `member`, so
  // only `workspaces.owner_user_id` can authorise an install there. ADMIN is an
  // administrator through the member branch, MEMBER and OWNER are plain members.
  await db.query(
    `update public.workspace_members set role = 'member'
      where workspace_id = $1 and user_id = $2`,
    [writeWorkspaceId, OUTSIDER_ID],
  );
  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role)
     values ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`,
    [writeWorkspaceId, ADMIN_ID, MEMBER_ID, OWNER_ID],
  );

  await insertSkill({
    id: SYS_SKILL,
    slug: "sys-skill",
    source: "system",
    createdBy: null,
  });
  await insertSkill({
    id: COMMUNITY_SKILL,
    slug: "community-skill",
    source: "community",
    createdBy: null,
  });
  await insertSkill({
    id: OWNER_SKILL,
    slug: "owner-skill",
    source: "user",
    createdBy: OWNER_ID,
  });
  await insertSkill({
    id: MEMBER_SKILL,
    slug: "member-skill",
    source: "user",
    createdBy: MEMBER_ID,
  });
  await insertSkill({
    id: OUTSIDER_SKILL,
    slug: "outsider-skill",
    source: "user",
    createdBy: OUTSIDER_ID,
  });
  await insertSkill({
    id: DISABLED_SKILL,
    slug: "disabled-skill",
    source: "system",
    createdBy: null,
  });

  // Targets for the WRITE cases. They are SYSTEM skills so that a non-admin's
  // refusal can only come from the workspace predicate, never from skill
  // visibility.
  for (const [index, id] of [
    OWNER_TARGET,
    ADMIN_TARGET,
    MEMBER_TARGET,
    DELETE_TARGET,
  ].entries()) {
    await insertSkill({
      id,
      slug: `write-target-${index + 1}`,
      source: "system",
      createdBy: null,
    });
  }

  // Distinct timestamps, so `order by installed_at desc` is deterministic.
  await installSkill(teamWorkspaceId, SYS_SKILL, true, "2026-10-01T00:00:01Z");
  await installSkill(
    teamWorkspaceId,
    COMMUNITY_SKILL,
    true,
    "2026-10-01T00:00:02Z",
  );
  await installSkill(teamWorkspaceId, OWNER_SKILL, true, "2026-10-01T00:00:03Z");
  await installSkill(teamWorkspaceId, MEMBER_SKILL, true, "2026-10-01T00:00:04Z");
  await installSkill(
    teamWorkspaceId,
    OUTSIDER_SKILL,
    true,
    "2026-10-01T00:00:05Z",
  );
  await installSkill(
    teamWorkspaceId,
    DISABLED_SKILL,
    false,
    "2026-10-01T00:00:06Z",
  );

  await insertSkillFile(SYS_SKILL, "scripts/analyze.py", "print('sys')\n");
  await insertSkillFile(COMMUNITY_SKILL, "references/guide.md", "# guide\n");
  await insertSkillFile(OWNER_SKILL, "assets/logo.png", "png-bytes");
  await insertSkillFile(OUTSIDER_SKILL, "scripts/private.py", "print('private')\n");

  // One pre-installed row in the WRITE workspace, so "a member cannot uninstall"
  // is a question about a row that really exists.
  await installSkill(
    writeWorkspaceId,
    DELETE_TARGET,
    true,
    "2026-10-02T00:00:00Z",
  );
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("skill repository: the fixture the matrix runs against", () => {
  it("case 1: six installs in the read workspace (one disabled), four files, three memberships", async () => {
    const counts = (
      await db.query<{ installs: number; files: number }>(
        `select
           (select count(*)::int from public.workspace_skills where workspace_id = $1) as installs,
           (select count(*)::int from public.skill_files) as files`,
        [teamWorkspaceId],
      )
    ).rows[0];

    expect(counts).toEqual({ installs: 6, files: 4 });

    const members = (
      await db.query<{ user_id: string; role: string }>(
        `select user_id, role from public.workspace_members
          where workspace_id = $1 order by user_id`,
        [teamWorkspaceId],
      )
    ).rows;

    expect(members).toEqual([
      { user_id: OWNER_ID, role: "member" },
      { user_id: ADMIN_ID, role: "admin" },
      { user_id: MEMBER_ID, role: "member" },
    ]);
  });
});

describe("skill repository: the visible catalogue", () => {
  it("case 2: shared skills are public, a user skill only to its author — repository and policy agree", async () => {
    // Every `system` / `community` row — the two the migrations seed, and the four
    // write targets — is shared.
    const shared = [
      ...seededSkillIds,
      SYS_SKILL,
      COMMUNITY_SKILL,
      DISABLED_SKILL,
      OWNER_TARGET,
      ADMIN_TARGET,
      MEMBER_TARGET,
      DELETE_TARGET,
    ].sort();

    expect(seededSkillIds).toHaveLength(2);

    // OWNER sees the shared rows and their own user skill.
    await expectSkillsFor(OWNER_ID, [...shared, OWNER_SKILL].sort());
    await expectSkillsFor(MEMBER_ID, [...shared, MEMBER_SKILL].sort());
    await expectSkillsFor(ADMIN_ID, [...shared].sort());
    // OUTSIDER sees the shared ones plus their own private skill.
    await expectSkillsFor(OUTSIDER_ID, [...shared, OUTSIDER_SKILL].sort());

    // A membership does NOT make another member's private skill readable.
    expect(
      (await skillsViaRepository(MEMBER_ID)).some((row) => row.id === OWNER_SKILL),
    ).toBe(false);
    expect(
      (await skillsViaRepository(OWNER_ID)).some((row) => row.id === OUTSIDER_SKILL),
    ).toBe(false);
  });

  it("case 3: findVisibleSkill answers null for somebody else's private skill through all three reads", async () => {
    // OWNER's own skill: all three agree it exists.
    expect((await findViaRepository(OWNER_ID, OWNER_SKILL))?.id).toBe(
      OWNER_SKILL,
    );
    expect((await findViaPolicy(OWNER_ID, OWNER_SKILL))?.id).toBe(OWNER_SKILL);
    expect((await findViaRlsOnly(OWNER_ID, OWNER_SKILL))?.id).toBe(OWNER_SKILL);

    // MEMBER may not see it: the repository, the filtered read and the unfiltered
    // read all answer "nothing".
    await expect(findViaRepository(MEMBER_ID, OWNER_SKILL)).resolves.toBeNull();
    await expect(findViaPolicy(MEMBER_ID, OWNER_SKILL)).resolves.toBeNull();
    await expect(findViaRlsOnly(MEMBER_ID, OWNER_SKILL)).resolves.toBeNull();

    // A shared skill is visible to everybody.
    for (const actorId of [OWNER_ID, ADMIN_ID, MEMBER_ID, OUTSIDER_ID]) {
      expect((await findViaRepository(actorId, SYS_SKILL))?.id).toBe(SYS_SKILL);
    }
  });

  it("case 4: skill files follow skill visibility, not membership", async () => {
    const expectedSharedFiles = ["scripts/analyze.py"];

    await expect(filesViaRepository(OWNER_ID, SYS_SKILL)).resolves.toEqual(
      expectedSharedFiles,
    );
    await expect(filesViaPolicy(OWNER_ID, SYS_SKILL)).resolves.toEqual(
      expectedSharedFiles,
    );
    await expect(filesViaRlsOnly(OWNER_ID, SYS_SKILL)).resolves.toEqual(
      expectedSharedFiles,
    );

    // The OWNER's private file: the owner reads it through all three, a member
    // reads it through none.
    for (const read of [filesViaRepository, filesViaPolicy, filesViaRlsOnly]) {
      await expect(read(OWNER_ID, OWNER_SKILL)).resolves.toEqual([
        "assets/logo.png",
      ]);
      await expect(read(MEMBER_ID, OWNER_SKILL)).resolves.toEqual([]);
    }

    // An invisible skill answers `[]`, never an error: that is what the route
    // publishes for "not yours", with 200.
    await expect(
      repository.listVisibleSkillFiles(MEMBER_ID, OUTSIDER_SKILL),
    ).resolves.toEqual([]);
  });
});

describe("skill repository: workspace installs", () => {
  it("case 5: members read the installs including the DISABLED one, filtered to skills they may see", async () => {
    const forOwner = await installsViaRepository(OWNER_ID);
    const forMember = await installsViaRepository(MEMBER_ID);
    const forOutsider = await installsViaRepository(OUTSIDER_ID);

    // `installed_at desc`, and OUTSIDER's private install is filtered out of the
    // OWNER's answer by the skill-visibility half of the join, as is MEMBER's.
    expect(forOwner.map((row) => row.id)).toEqual([
      DISABLED_SKILL,
      OWNER_SKILL,
      COMMUNITY_SKILL,
      SYS_SKILL,
    ]);
    expect(forOwner.map((row) => row.id).sort()).toEqual(
      EXPECTED_INSTALLS_FOR_OWNER,
    );

    // MEMBER sees the same installs minus the OWNER's private skill, plus their own.
    expect(forMember.map((row) => row.id)).toEqual([
      DISABLED_SKILL,
      MEMBER_SKILL,
      COMMUNITY_SKILL,
      SYS_SKILL,
    ]);
    expect(forMember.map((row) => row.id).sort()).toEqual(
      EXPECTED_INSTALLS_FOR_MEMBER,
    );

    // Not a member: nothing, not even the shared system skills.
    expect(forOutsider).toEqual([]);

    // The disabled install is published with its flag.
    expect(forOwner.find((row) => row.id === DISABLED_SKILL)?.enabled).toBe(
      false,
    );
    // INSTALLED_AT is an ISO string with an offset, which is what the response
    // schema accepts (`::text` would have rendered a space instead of `T`).
    for (const row of forOwner) {
      expect(row.installed_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }
  });

  it("case 6: the three reads agree row for row, disabled install included", async () => {
    for (const actorId of [OWNER_ID, MEMBER_ID]) {
      const byRepository = (await installsViaRepository(actorId)).map((row) => ({
        skill_id: row.id,
        enabled: row.enabled,
      }));
      const byPolicy = await installsViaPolicy(actorId);
      const byRlsOnly = await installsViaRlsOnly(actorId);

      const sorted = [...byRepository].sort((left, right) =>
        left.skill_id.localeCompare(right.skill_id),
      );

      expect(byPolicy).toEqual(sorted);
      expect(byRlsOnly).toEqual(sorted);
    }

    // A non-member reads nothing through all three.
    await expect(installsViaPolicy(OUTSIDER_ID)).resolves.toEqual([]);
    await expect(installsViaRlsOnly(OUTSIDER_ID)).resolves.toEqual([]);
  });
});

describe("skill repository: who may install and uninstall", () => {
  it("case 7: the OWNER_USER_ID branch — a member row that says `member` still installs, because the workspace owner is on `workspaces`", async () => {
    // OUTSIDER owns this personal workspace. Their member row says `member`, so the
    // member branch of `is_workspace_admin_or_owner` cannot admit them: only the
    // `workspaces.owner_user_id` branch can.
    const before = await installsViaRepository(OUTSIDER_ID, writeWorkspaceId);
    expect(before.map((row) => row.id)).toEqual([DELETE_TARGET]);

    // The policy really does allow it: the same identity inserts the same row
    // under `asUser()`.
    await asUser(db, OUTSIDER_ID, async (tx) => {
      await tx.query(
        `insert into public.workspace_skills (workspace_id, skill_id, enabled, installed_by)
         values ($1, $2, true, $3)`,
        [writeWorkspaceId, OWNER_TARGET, OWNER_ID],
      );
    });

    const afterPolicy = await installsViaRepository(
      OUTSIDER_ID,
      writeWorkspaceId,
    );
    expect(afterPolicy.map((row) => row.id).sort()).toEqual(
      [OWNER_TARGET, DELETE_TARGET].sort(),
    );

    // Remove that row again and let the REPOSITORY install it: same answer.
    await db.query(
      `delete from public.workspace_skills where workspace_id = $1 and skill_id = $2`,
      [writeWorkspaceId, OWNER_TARGET],
    );

    await repository.upsertWorkspaceSkill(
      OUTSIDER_ID,
      writeWorkspaceId,
      OWNER_TARGET,
      true,
    );

    const row = (
      await db.query<{ enabled: boolean; installed_by: string; installed_at: Date }>(
        `select enabled, installed_by, installed_at from public.workspace_skills
          where workspace_id = $1 and skill_id = $2`,
        [writeWorkspaceId, OWNER_TARGET],
      )
    ).rows[0];

    expect(row?.enabled).toBe(true);
    expect(row?.installed_by).toBe(OUTSIDER_ID);

    // And the repository may uninstall it again: `{deleted: 1}`.
    await expect(
      repository.deleteWorkspaceSkill(
        OUTSIDER_ID,
        writeWorkspaceId,
        OWNER_TARGET,
      ),
    ).resolves.toEqual({ deleted: 1 });

    await expect(
      installsViaRepository(OUTSIDER_ID, writeWorkspaceId),
    ).resolves.toEqual([expect.objectContaining({ id: DELETE_TARGET })]);

    // The member branch is genuinely unavailable to them: downgrading the role in
    // the fixture is what makes this case meaningful rather than a role check that
    // would have passed either way.
    const role = (
      await db.query<{ role: string }>(
        `select role from public.workspace_members
          where workspace_id = $1 and user_id = $2`,
        [writeWorkspaceId, OUTSIDER_ID],
      )
    ).rows[0];
    expect(role?.role).toBe("member");
  });

  it("case 8: the ADMIN branch, and a toggle that overwrites `enabled` and `installed_by` without touching `installed_at`", async () => {
    // The row exists already, installed by somebody else at a known time, so the
    // conflict path has something to preserve.
    await db.query(
      `insert into public.workspace_skills (workspace_id, skill_id, enabled, installed_by, installed_at)
       values ($1, $2, true, $3, '2026-10-03T00:00:00Z')`,
      [writeWorkspaceId, ADMIN_TARGET, MEMBER_ID],
    );

    const installed = (
      await db.query<{ installed_at: Date; installed_by: string }>(
        `select installed_at, installed_by from public.workspace_skills
          where workspace_id = $1 and skill_id = $2`,
        [writeWorkspaceId, ADMIN_TARGET],
      )
    ).rows[0];

    expect(installed?.installed_by).toBe(MEMBER_ID);

    // The conflict path overwrites the flag and the installer, and keeps the
    // original timestamp — this is the removed upsert's answer, `installed_at` is
    // deliberately absent from its SET list.
    await repository.upsertWorkspaceSkill(
      ADMIN_ID,
      writeWorkspaceId,
      ADMIN_TARGET,
      false,
    );

    const toggled = (
      await db.query<{ enabled: boolean; installed_at: Date; installed_by: string }>(
        `select enabled, installed_at, installed_by from public.workspace_skills
          where workspace_id = $1 and skill_id = $2`,
        [writeWorkspaceId, ADMIN_TARGET],
      )
    ).rows[0];

    expect(toggled?.enabled).toBe(false);
    expect(toggled?.installed_at).toEqual(installed?.installed_at);
    expect(toggled?.installed_by).toBe(ADMIN_ID);

    // The policy agrees that an admin may toggle: `asUser()` updates the same row.
    await asUser(db, ADMIN_ID, async (tx) => {
      await tx.query(
        `update public.workspace_skills set enabled = true
          where workspace_id = $1 and skill_id = $2`,
        [writeWorkspaceId, ADMIN_TARGET],
      );
    });

    const afterPolicy = (
      await db.query<{ enabled: boolean }>(
        `select enabled from public.workspace_skills
          where workspace_id = $1 and skill_id = $2`,
        [writeWorkspaceId, ADMIN_TARGET],
      )
    ).rows[0];
    expect(afterPolicy?.enabled).toBe(true);
  });

  it("case 9: an ordinary MEMBER is refused by the repository AND by the policy, and the data does not change", async () => {
    const error = await repository
      .upsertWorkspaceSkill(MEMBER_ID, writeWorkspaceId, MEMBER_TARGET, true)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SkillRepositoryError);
    expect((error as SkillRepositoryError).message).toBe(
      "skill repository failed (upsertWorkspaceSkill)",
    );

    // The policy refuses it too — that is what makes the repository throw rather
    // than silently report an install: `ws_skills_insert`'s WITH CHECK fails.
    const policyError = await asUser(db, MEMBER_ID, async (tx) => {
      await tx.query(
        `insert into public.workspace_skills (workspace_id, skill_id, enabled, installed_by)
         values ($1, $2, true, $3)`,
        [writeWorkspaceId, MEMBER_TARGET, MEMBER_ID],
      );
    }).catch((reason: unknown) => reason);

    expect(policyError).toBeInstanceOf(Error);
    expect(String((policyError as Error).message)).toMatch(
      /row-level security|violates row-level security policy/i,
    );

    const count = (
      await db.query<{ rows: number }>(
        `select count(*)::int as rows from public.workspace_skills
          where workspace_id = $1 and skill_id = $2`,
        [writeWorkspaceId, MEMBER_TARGET],
      )
    ).rows[0];
    expect(count?.rows).toBe(0);
  });

  it("case 10: a MEMBER uninstall deletes ZERO rows, so the route answers 404 — never 403", async () => {
    await expect(
      repository.deleteWorkspaceSkill(MEMBER_ID, writeWorkspaceId, DELETE_TARGET),
    ).resolves.toEqual({ deleted: 0 });

    // The policy answers the same way: a DELETE whose USING fails affects no row
    // and raises nothing, which is exactly why the route publishes 404 and not 403.
    await asUser(db, MEMBER_ID, async (tx) => {
      await tx.query(
        `delete from public.workspace_skills
          where workspace_id = $1 and skill_id = $2`,
        [writeWorkspaceId, DELETE_TARGET],
      );
    });

    // The row is still there, so neither delete removed anything.
    const rows = (
      await db.query<{ skill_id: string }>(
        `select skill_id from public.workspace_skills
          where workspace_id = $1 and skill_id = $2`,
        [writeWorkspaceId, DELETE_TARGET],
      )
    ).rows;
    expect(rows).toHaveLength(1);
  });
});

describe("skill repository: skill writes", () => {
  it("case 11: insertOwnSkill writes a user skill of the actor, and the policy agrees about `created_by`", async () => {
    const created = await repository.insertOwnSkill(MEMBER_ID, {
      name: "Member Imported Skill",
      slug: "member-imported-skill",
      description: "Created by the repository",
      category: "custom",
      skillContent: "# imported",
      metadata: { source_url: "https://example.test/pkg", package_name: "pkg" },
      author: "unknown",
      version: "1.0",
      license: null,
      iconName: null,
    });

    expect(created.source).toBe("user");
    expect(created.created_by).toBe(MEMBER_ID);
    expect(created.metadata).toEqual({
      source_url: "https://example.test/pkg",
      package_name: "pkg",
    });

    // The policy's WITH CHECK is `source = 'user' and created_by = auth.uid()`, so
    // the same insert under `asUser()` succeeds…
    await asUser(db, MEMBER_ID, async (tx) => {
      await tx.query(
        `insert into public.skills (name, slug, description, source, created_by, skill_content)
         values ('Policy Skill', 'policy-skill', '', 'user', $1, 'x')`,
        [MEMBER_ID],
      );
    });

    // …and the same insert NAMING SOMEBODY ELSE is refused. That is the half the
    // repository hardcodes, and the half a caller must not be able to widen.
    const refused = await asUser(db, MEMBER_ID, async (tx) => {
      await tx.query(
        `insert into public.skills (name, slug, description, source, created_by, skill_content)
         values ('Forged Skill', 'forged-skill', '', 'user', $1, 'x')`,
        [OWNER_ID],
      );
    }).catch((reason: unknown) => reason);

    expect(refused).toBeInstanceOf(Error);
    expect(String((refused as Error).message)).toMatch(/row-level security/i);
  });

  it("case 12: a duplicate slug is SQLSTATE 23505 on insert, exactly like the unique index", async () => {
    const error = await repository
      .insertOwnSkill(MEMBER_ID, {
        name: "Duplicate",
        slug: "sys-skill",
        description: "",
        category: "custom",
        skillContent: "x",
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SkillRepositoryError);
    expect((error as SkillRepositoryError).sqlstate).toBe("23505");

    // Independent of the repository: the constraint really is the source.
    const direct = await db
      .query(
        `insert into public.skills (name, slug, skill_content) values ('D', 'sys-skill', 'x')`,
      )
      .catch((reason: unknown) => reason);
    expect(String((direct as Error).message)).toMatch(/duplicate key value/);
  });

  it("case 13: updateOwnSkill only reaches the actor's own skill, and the policy agrees", async () => {
    // Somebody else's skill: null, and the row is untouched.
    await expect(
      repository.updateOwnSkill(MEMBER_ID, OWNER_SKILL, {
        description: "hijacked",
      }),
    ).resolves.toBeNull();

    const untouched = (
      await db.query<{ description: string }>(
        `select description from public.skills where id = $1`,
        [OWNER_SKILL],
      )
    ).rows[0];
    expect(untouched?.description).toBe("Description of owner-skill");

    // The policy's USING clause refuses the same UPDATE: the row keeps its value.
    await asUser(db, MEMBER_ID, async (tx) => {
      await tx.query(
        `update public.skills set description = 'hijacked' where id = $1`,
        [OWNER_SKILL],
      );
    });

    const stillUntouched = (
      await db.query<{ description: string }>(
        `select description from public.skills where id = $1`,
        [OWNER_SKILL],
      )
    ).rows[0];
    expect(stillUntouched?.description).toBe("Description of owner-skill");

    // The actor's OWN skill: updated, with the shared name/slug flag rewriting both.
    const updated = await repository.updateOwnSkill(MEMBER_ID, MEMBER_SKILL, {
      name: "Renamed By Member",
      slug: "renamed-by-member",
    });
    expect(updated?.name).toBe("Renamed By Member");
    expect(updated?.slug).toBe("renamed-by-member");
    // The BEFORE UPDATE trigger still owns `updated_at`, so it never runs behind
    // `created_at`.
    expect(new Date(updated?.updated_at ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(updated?.created_at ?? 0).getTime(),
    );

    // A partial patch leaves the other columns alone.
    const partial = await repository.updateOwnSkill(MEMBER_ID, MEMBER_SKILL, {
      category: "writing",
    });
    expect(partial?.category).toBe("writing");
    expect(partial?.name).toBe("Renamed By Member");
  });

  it("case 14: a batch file insert is gated by the owner-only policy, and a bad path fails the WHOLE batch", async () => {
    // Another user's private skill: zero rows, not an error.
    await expect(
      repository.insertOwnSkillFiles(MEMBER_ID, OWNER_SKILL, [
        { filePath: "scripts/x.py", content: "x" },
      ]),
    ).resolves.toEqual({ inserted: 0 });

    const blocked = (
      await db.query<{ rows: number }>(
        `select count(*)::int as rows from public.skill_files where skill_id = $1`,
        [OWNER_SKILL],
      )
    ).rows[0];
    expect(blocked?.rows).toBe(1);

    // The actor's own skill: the whole batch lands in one statement.
    const created = await repository.insertOwnSkill(MEMBER_ID, {
      name: "Batch Skill",
      slug: "batch-skill",
      description: "",
      category: "custom",
      skillContent: "x",
    });

    await expect(
      repository.insertOwnSkillFiles(MEMBER_ID, created.id, [
        { filePath: "scripts/a.py", content: "print(1)\n" },
        // No mime type: the column DEFAULT 'text/plain' applies.
        { filePath: "references/b.md", content: "# b\n" },
      ]),
    ).resolves.toEqual({ inserted: 2 });

    const stored = (
      await db.query<{ file_path: string; mime_type: string }>(
        `select file_path, mime_type from public.skill_files
          where skill_id = $1 order by file_path`,
        [created.id],
      )
    ).rows;
    expect(stored).toEqual([
      { file_path: "references/b.md", mime_type: "text/plain" },
      { file_path: "scripts/a.py", mime_type: "text/plain" },
    ]);

    // `CHECK (file_path ~ '^(scripts|references|assets)/')` rejects the bad row and
    // therefore the WHOLE batch — nothing half-written, exactly as the removed
    // multi-row insert behaved.
    const error = await repository
      .insertOwnSkillFiles(MEMBER_ID, created.id, [
        { filePath: "scripts/good.py", content: "ok" },
        { filePath: "not-allowed/bad.py", content: "no" },
      ])
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SkillRepositoryError);
    expect((error as SkillRepositoryError).sqlstate).toBe("23514");

    const afterFailure = (
      await db.query<{ rows: number }>(
        `select count(*)::int as rows from public.skill_files where skill_id = $1`,
        [created.id],
      )
    ).rows[0];
    expect(afterFailure?.rows).toBe(2);
  });

  it("case 15: deleteOwnSkill removes the skill and cascades its files and installs", async () => {
    const created = await repository.insertOwnSkill(MEMBER_ID, {
      name: "Doomed Skill",
      slug: "doomed-skill",
      description: "",
      category: "custom",
      skillContent: "x",
    });
    await repository.insertOwnSkillFiles(MEMBER_ID, created.id, [
      { filePath: "scripts/doomed.py", content: "x" },
    ]);
    // An administrator of the write workspace installs it, so the cascade has an
    // install row to remove.
    await repository.upsertWorkspaceSkill(
      ADMIN_ID,
      writeWorkspaceId,
      created.id,
      true,
    );

    // Somebody else's skill: zero rows, and the row survives.
    await expect(
      repository.deleteOwnSkill(OWNER_ID, created.id),
    ).resolves.toEqual({ deleted: 0 });

    await expect(
      repository.deleteOwnSkill(MEMBER_ID, created.id),
    ).resolves.toEqual({ deleted: 1 });

    const remaining = (
      await db.query<{ skills: number; files: number; installs: number }>(
        `select
           (select count(*)::int from public.skills where id = $1) as skills,
           (select count(*)::int from public.skill_files where skill_id = $1) as files,
           (select count(*)::int from public.workspace_skills where skill_id = $1) as installs`,
        [created.id],
      )
    ).rows[0];

    expect(remaining).toEqual({ skills: 0, files: 0, installs: 0 });
  });
});

describe("skill repository: bad binds", () => {
  it("case 16: a malformed uuid is a real SQL error (22P02) on every read, and the pool reads again afterwards", async () => {
    const calls = [
      () => repository.findVisibleSkill(MEMBER_ID, INVALID_ID),
      () => repository.listVisibleSkillFiles(MEMBER_ID, INVALID_ID),
      () => repository.deleteOwnSkill(MEMBER_ID, INVALID_ID),
      () => repository.updateOwnSkill(MEMBER_ID, INVALID_ID, { description: "x" }),
      () =>
        repository.deleteWorkspaceSkill(MEMBER_ID, writeWorkspaceId, INVALID_ID),
    ];

    for (const call of calls) {
      const error = await call().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(SkillRepositoryError);
      expect((error as SkillRepositoryError).sqlstate).toBe("22P02");
    }

    // ROLLBACK plus release left the connection usable for the next read.
    await expectSkillsFor(
      OWNER_ID,
      [
        ...seededSkillIds,
        SYS_SKILL,
        COMMUNITY_SKILL,
        DISABLED_SKILL,
        OWNER_TARGET,
        ADMIN_TARGET,
        MEMBER_TARGET,
        DELETE_TARGET,
        OWNER_SKILL,
      ].sort(),
    );
  });
});
