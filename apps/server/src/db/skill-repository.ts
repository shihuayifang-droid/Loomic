/**
 * Skill repository (workorder 21AE, ADR-0001 migration step).
 *
 * NINETEEN PostgREST table calls move here: the fifteen inside
 * `http/skills.ts` and the four inside `http/skills-marketplace.ts`. Both files
 * reached PostgREST through a local untyped-from wrapper — a `(client as any)`
 * cast whose call sites named the wrapper instead of the client — and workorder
 * 21AD taught the auditor to count those call sites (65 -> 84). This module
 * replaces all nineteen with ten named statements, which is why
 * `server.fromCalls` moves 84 -> 63: nineteen call sites plus the two wrapper
 * definition lines, whose own casts were the only part of those two files the
 * from-call rule could see.
 *
 * Nothing about the published behaviour moves with them. Every route keeps its
 * status code, error code, message and — for the six places that swallowed a
 * failure on purpose — its swallow. Workorder 21AE also freezes four
 * bug-level behaviours as T-61 (an empty slug for a pure-CJK name, the
 * marketplace writing `source_url` / `package_name` into `metadata` instead of
 * their own columns, a Zod error answered as 500 on the marketplace install, and
 * R9 answering 500 for a request with no body). None of them is fixed here.
 *
 * Rules this module keeps, and why each one matters:
 *
 * - The interface is CLOSED: ten methods, each with a fixed statement. There is
 *   no access token, no table name, no arbitrary column and no generic
 *   `patch(table, fields)`, so a caller cannot widen a write by naming a column
 *   this module never writes.
 * - Every statement runs through workorder 19's transaction entry point in
 *   `privileged` mode. The pool's role owns these tables and bypasses RLS, which
 *   is exactly why the authorisation rule has to be the statement's OWN
 *   predicate.
 * - The ACL is the two policies of
 *   `supabase/migrations/20260331000000_skills_management.sql` and the three of
 *   `supabase/migrations/20260403100000_skill_files.sql`, translated verbatim:
 *
 *       skills            select  source in ('system','community') or created_by = uid
 *                         insert  source = 'user' and created_by = uid
 *                         update  using/check created_by = uid
 *                         delete  created_by = uid
 *       workspace_skills  select  private.is_workspace_member(workspace_id)
 *                         insert/update/delete
 *                                 private.is_workspace_admin_or_owner(workspace_id)
 *       skill_files       select  exists (skills s where s.id = skill_id
 *                                  and (s.source in ('system','community')
 *                                       or s.created_by = uid))
 *                         insert/update/delete
 *                                 exists (skills s where s.id = skill_id
 *                                  and s.source = 'user' and s.created_by = uid)
 *
 *   `private.is_workspace_member` (migration 1, L186-200) is
 *   `exists (workspace_members wm where wm.workspace_id = p and wm.user_id = uid)`.
 *   `private.is_workspace_admin_or_owner` (migration 2, L4-27) has TWO branches and
 *   BOTH are translated, the `workspaces.owner_user_id` branch included:
 *   `exists (workspaces w where w.id = p and w.owner_user_id = uid)
 *    or exists (workspace_members wm where wm.workspace_id = p and wm.user_id = uid
 *               and wm.role in ('owner','admin'))`.
 *   Translating only the membership branch would lock out a workspace owner whose
 *   member row says something else, so both are written out in `upsertWorkspaceSkill`
 *   and `deleteWorkspaceSkill`.
 * - Reads that used to be authorised by RLS carry the same predicate as a JOIN
 *   condition or a WHERE clause, never as a caller-supplied id list: a repository
 *   whose authorisation is "the caller passed the right ids" has no
 *   authorisation of its own.
 * - `updateOwnSkill` uses FLAG PARAMETERS instead of a dynamic SET list, so the
 *   SQL text is byte-identical whatever the patch contains and only the
 *   parameters differ — the property the unit tests assert by comparing three
 *   different patches. `name` and `slug` share ONE flag because the removed write
 *   always recomputed the slug when it changed the name, and `slug` is NOT NULL.
 * - `insertOwnSkill` keeps ONE fixed statement for its two callers (the create
 *   route and the marketplace install) even though they supply different columns.
 *   The three columns only the marketplace fills in — `author`, `version`,
 *   `metadata` — are bound and fall back with `coalesce` to the DEFAULT of the
 *   migration above, which is exactly what PostgREST did when the value was
 *   absent from the payload: the column kept its default. No flag is needed for
 *   `license` or `icon_name` because their default IS NULL.
 * - `insertOwnSkillFiles` writes the whole batch in ONE statement through
 *   `jsonb_to_recordset`, gated by an `exists` clause that IS `skill_files_insert`.
 *   A batch whose `file_path` violates the table's CHECK therefore fails as a
 *   whole, exactly as the removed `.insert(rows)` did.
 * - Zero rows is not automatically an error, because the removed writes disagreed
 *   about it: `updateOwnSkill` answers `null`, `deleteOwnSkill` /
 *   `deleteWorkspaceSkill` answer `{deleted: 0}`, and `upsertWorkspaceSkill`
 *   THROWS when its `where` admitted nothing — that last one is what a non-admin
 *   install or toggle used to become (a 500), and the route still maps it there.
 * - Every value is a bind parameter with an explicit cast, so a malformed uuid
 *   fails as a real SQL error (SQLSTATE 22P02) inside the transaction. The
 *   routes map 22P02 onto the statuses they published before: 500 on the reads,
 *   the updates and the deletes, 404 on the two install/toggle lookups, which
 *   swallowed the error and answered "not found".
 * - Timestamps are published as `toISOString()`. `pg` hands a `timestamptz` back
 *   as a `Date`, while the HTTP contract is a string with an offset, so the mapper
 *   normalises it. `::text` is deliberately NOT used: PostgreSQL renders it with a
 *   space instead of `T`, which the response schema rejects.
 * - `skills.updated_at` and `skill_files.updated_at` are never written: both
 *   tables have a `BEFORE UPDATE` trigger (`update_skills_updated_at`), which fires
 *   under a privileged connection too.
 * - A connect, SQL, timeout or row-shape failure throws `SkillRepositoryError`,
 *   whose own message is fixed text naming only the operation: no SQL, no host,
 *   no connection string and no skill/user/workspace id. The driver's own error
 *   rides along as `cause`, and its `code` — a SQLSTATE for a PostgreSQL error —
 *   is exposed as `sqlstate` so a route can tell 23505 apart without reading the
 *   driver's message.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a failure on the call, never a silent fallback: nothing in
 *   this module can reach PostgREST.
 */

import {
  withPrivilegedTransaction,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * One `public.skills` row, in the order the projections below list it. Every
 * timestamp is an ISO-8601 string with an offset — the HTTP contract's shape —
 * never a `Date`.
 */
export type SkillRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  author: string;
  version: string;
  license: string | null;
  category: string;
  icon_name: string | null;
  source: string;
  skill_content: string;
  metadata: Record<string, unknown> | null;
  is_featured: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  source_url: string | null;
  package_name: string | null;
};

/** One `public.skill_files` row. `skill_id` is carried because the routes never read it. */
export type SkillFileRecord = {
  id: string;
  skill_id: string;
  file_path: string;
  content: string;
  mime_type: string;
  created_at: string;
  updated_at: string;
};

/**
 * A `workspace_skills` row joined to the skill it installs: the skill's own
 * columns plus the two install columns the workspace list publishes. `enabled`
 * and `installed_at` come from the INSTALL row, not from the skill.
 */
export type WorkspaceInstalledSkillRow = SkillRow & {
  enabled: boolean;
  installed_at: string;
};

/**
 * The column values `insertOwnSkill` accepts. `name`, `slug`, `description`,
 * `category` and `skill_content` are supplied by both callers; the rest are the
 * marketplace-only columns, and leaving them out keeps the column DEFAULT, which
 * is what the removed write did when the payload omitted them.
 */
export type SkillInsertFields = {
  name: string;
  slug: string;
  description: string;
  category: string;
  skillContent: string;
  iconName?: string | null;
  author?: string;
  version?: string;
  license?: string | null;
  metadata?: Record<string, unknown> | null;
  sourceUrl?: string | null;
  packageName?: string | null;
};

/** One file of a batch insert. `mimeType` absent keeps the column default. */
export type SkillFileInput = {
  filePath: string;
  content: string;
  mimeType?: string | null;
};

/**
 * The columns `updateOwnSkill` may set. An ABSENT key means "leave this column
 * alone"; `icon_name` present with `null` means "set it to NULL", which is a value
 * the column really can hold. `name` and `slug` are ONE flag and are supplied
 * together — see the header.
 */
export type SkillPatch = {
  name?: string;
  slug?: string;
  description?: string;
  category?: string;
  skill_content?: string;
  icon_name?: string | null;
};

export type SkillRepository = {
  /** Every skill the actor may see, featured first then by name. */
  listVisibleSkills(actorId: string): Promise<SkillRow[]>;

  /** One visible skill, or `null` when it does not exist or is not the actor's. */
  findVisibleSkill(actorId: string, skillId: string): Promise<SkillRow | null>;

  /** The files of a VISIBLE skill, by path. Empty when the skill is invisible. */
  listVisibleSkillFiles(
    actorId: string,
    skillId: string,
  ): Promise<SkillFileRecord[]>;

  /**
   * The skills installed in `workspaceId`, DISABLED ones included, joined to their
   * skill row. Empty when the actor is not a member of that workspace or when every
   * install is a private skill of somebody else.
   */
  listWorkspaceInstalledSkills(
    actorId: string,
    workspaceId: string,
  ): Promise<WorkspaceInstalledSkillRow[]>;

  /** Create a `source = 'user'` skill owned by the actor, and answer the row. */
  insertOwnSkill(actorId: string, fields: SkillInsertFields): Promise<SkillRow>;

  /**
   * Append a batch of files to the actor's OWN user skill, in one statement, and
   * answer how many rows were written. Zero when the skill is not theirs.
   */
  insertOwnSkillFiles(
    actorId: string,
    skillId: string,
    files: readonly SkillFileInput[],
  ): Promise<{ inserted: number }>;

  /**
   * Apply `patch` to the actor's own skill. `null` when the skill does not exist
   * or belongs to somebody else — not an error.
   */
  updateOwnSkill(
    actorId: string,
    skillId: string,
    patch: SkillPatch,
  ): Promise<SkillRow | null>;

  /** Delete the actor's own skill (its files and installs cascade). */
  deleteOwnSkill(actorId: string, skillId: string): Promise<{ deleted: number }>;

  /**
   * Install — or re-enable — a skill in a workspace the actor administers or owns.
   * THROWS when the actor is neither: the statement then admits no row, and the
   * removed upsert raised a policy error at exactly the same point. `installed_at`
   * is deliberately NOT touched on the conflict path, matching the removed write.
   */
  upsertWorkspaceSkill(
    actorId: string,
    workspaceId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<void>;

  /** Uninstall a skill from a workspace the actor administers or owns. */
  deleteWorkspaceSkill(
    actorId: string,
    workspaceId: string,
    skillId: string,
  ): Promise<{ deleted: number }>;
};

export const LIST_VISIBLE_SKILLS = "listVisibleSkills";
export const FIND_VISIBLE_SKILL = "findVisibleSkill";
export const LIST_VISIBLE_SKILL_FILES = "listVisibleSkillFiles";
export const LIST_WORKSPACE_INSTALLED_SKILLS = "listWorkspaceInstalledSkills";
export const INSERT_OWN_SKILL = "insertOwnSkill";
export const INSERT_OWN_SKILL_FILES = "insertOwnSkillFiles";
export const UPDATE_OWN_SKILL = "updateOwnSkill";
export const DELETE_OWN_SKILL = "deleteOwnSkill";
export const UPSERT_WORKSPACE_SKILL = "upsertWorkspaceSkill";
export const DELETE_WORKSPACE_SKILL = "deleteWorkspaceSkill";

export type SkillRepositoryOperation =
  | typeof LIST_VISIBLE_SKILLS
  | typeof FIND_VISIBLE_SKILL
  | typeof LIST_VISIBLE_SKILL_FILES
  | typeof LIST_WORKSPACE_INSTALLED_SKILLS
  | typeof INSERT_OWN_SKILL
  | typeof INSERT_OWN_SKILL_FILES
  | typeof UPDATE_OWN_SKILL
  | typeof DELETE_OWN_SKILL
  | typeof UPSERT_WORKSPACE_SKILL
  | typeof DELETE_WORKSPACE_SKILL;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 *
 * `sqlstate` is the driver's own `code`, which for a PostgreSQL error IS its
 * SQLSTATE (`23505` unique violation, `22P02` bad uuid, `23514` CHECK violation,
 * `42501` insufficient privilege). It is `null` for a socket code, for a shape
 * failure this module raised itself and for an unusable argument. The routes use
 * it to tell 23505 from everything else without reading the driver's message.
 */
export class SkillRepositoryError extends Error {
  readonly operation: SkillRepositoryOperation;
  readonly sqlstate: string | null;

  constructor(operation: SkillRepositoryOperation, cause: unknown) {
    super(
      `skill repository failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "SkillRepositoryError";
    this.operation = operation;
    this.sqlstate = readSqlstate(cause);
  }
}

/**
 * The driver's own code, when the failure carries one. A PostgreSQL error puts
 * its SQLSTATE here; a Node socket error puts e.g. `ECONNRESET`. Both are useful
 * to a caller that is CLASSIFYING a failure, and neither is published in the
 * message.
 */
function readSqlstate(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) return null;

  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * The published columns of `public.skills`, in the order `mapSkillRow` reads
 * them. Written once so the six projections cannot drift apart.
 */
const SKILL_COLUMNS = [
  "id",
  "name",
  "slug",
  "description",
  "author",
  "version",
  "license",
  "category",
  "icon_name",
  "source",
  "skill_content",
  "metadata",
  "is_featured",
  "created_by",
  "created_at",
  "updated_at",
  "source_url",
  "package_name",
] as const;

/** The published columns of `public.skill_files`. */
const SKILL_FILE_COLUMNS = [
  "id",
  "skill_id",
  "file_path",
  "content",
  "mime_type",
  "created_at",
  "updated_at",
] as const;

/** `a, b, c` with an optional table alias prefix, for the projections below. */
function columns(list: readonly string[], alias = ""): string {
  return list.map((column) => `${alias}${column}`).join(", ");
}

const SKILL_COLS = columns(SKILL_COLUMNS);
const SKILL_COLS_S = columns(SKILL_COLUMNS, "s.");
const SKILL_FILE_COLS = columns(SKILL_FILE_COLUMNS);
const SKILL_FILE_COLS_F = columns(SKILL_FILE_COLUMNS, "f.");

/** `skills_select_all` verbatim: shared skills are public, a user skill is its author's. */
const SKILL_VISIBILITY = "(s.source in ('system', 'community') or s.created_by = $1::uuid)";

/**
 * `private.is_workspace_member(workspace_id)`: the body of the function with its
 * argument bound. `auth.uid() is not null` is implied, because a non-empty actor
 * is a precondition of every call here.
 */
const WORKSPACE_MEMBER = `exists (select 1 from public.workspace_members m
                where m.workspace_id = $2::uuid
                  and m.user_id = $1::uuid)`;

/**
 * `private.is_workspace_admin_or_owner(workspace_id)`, both branches verbatim.
 * `$2` is the workspace id, `$1` the actor — the same parameter order the two
 * statements that use it already bind.
 */
const WORKSPACE_ADMIN_OR_OWNER = `(exists (select 1 from public.workspaces w
                            where w.id = $2::uuid
                              and w.owner_user_id = $1::uuid)
                    or exists (select 1 from public.workspace_members m
                            where m.workspace_id = $2::uuid
                              and m.user_id = $1::uuid
                              and m.role in ('owner', 'admin')))`;

/**
 * `listVisibleSkills`: the whole catalogue the actor may see, `skills_select_all`
 * as the only predicate.
 *
 * The order is what the removed read asked PostgREST for
 * (`.order("is_featured", desc).order("name", asc)`), and it is part of the
 * published answer: the registry list is rendered in this order.
 */
const LIST_VISIBLE_SKILLS_SQL = `
select ${SKILL_COLS_S}
  from public.skills s
 where ${SKILL_VISIBILITY}
 order by s.is_featured desc, s.name asc
`;

/**
 * `findVisibleSkill`: one skill, visible to the actor. The id is bound with
 * `::uuid`, so a malformed one fails as a real SQL error (SQLSTATE 22P02) instead
 * of silently matching nothing — the route answers 500 for that, exactly as the
 * removed read did.
 */
const FIND_VISIBLE_SKILL_SQL = `
select ${SKILL_COLS_S}
  from public.skills s
 where ${SKILL_VISIBILITY}
   and s.id = $2::uuid
`;

/**
 * `listVisibleSkillFiles`: the files of one VISIBLE skill, `skill_files_select`
 * translated into the JOIN condition.
 *
 * The join half is the policy itself; keeping it on the JOIN means an invisible
 * skill cannot contribute a file row at all, which is why the route answers
 * `{files: []}` — not 404 and not 403 — for somebody else's private skill.
 */
const LIST_VISIBLE_SKILL_FILES_SQL = `
select ${SKILL_FILE_COLS_F}
  from public.skill_files f
  join public.skills s
    on s.id = f.skill_id
   and ${SKILL_VISIBILITY}
 where f.skill_id = $2::uuid
 order by f.file_path asc
`;

/**
 * `listWorkspaceInstalledSkills`: the installs of one workspace joined to their
 * skill, `ws_skills_select` plus `skills_select_all`.
 *
 * Both predicates are needed and neither is redundant: the membership clause
 * alone would expose another member's private user skill, and the visibility
 * clause alone would expose the workspace's installs to a non-member.
 *
 * There is NO `enabled` filter — the route publishes disabled installs too, which
 * is what the removed read did. `installed_at` is the order because the workspace
 * skill list is rendered newest-first.
 */
const LIST_WORKSPACE_INSTALLED_SKILLS_SQL = `
select ${SKILL_COLS_S}, ws.enabled, ws.installed_at
  from public.workspace_skills ws
  join public.skills s
    on s.id = ws.skill_id
   and ${SKILL_VISIBILITY}
 where ws.workspace_id = $2::uuid
   and ${WORKSPACE_MEMBER}
 order by ws.installed_at desc
`;

/**
 * `insertOwnSkill`: the insert behind `POST /api/skills` and behind the
 * marketplace install.
 *
 * `source = 'user'` and `created_by = $1::uuid` are written as literals because
 * they ARE `skills_insert_user`'s WITH CHECK, and the policy does not run on a
 * privileged connection. `is_featured` keeps its `false` default (a created skill
 * is never featured), and `id` / `created_at` / `updated_at` keep theirs.
 *
 * The three `coalesce` calls are the defaults of
 * `20260331000000_skills_management.sql` written out, because an INSERT ... VALUES
 * expression cannot reference DEFAULT per column: `author text NOT NULL DEFAULT
 * 'system'`, `version text NOT NULL DEFAULT '1.0'`, `metadata jsonb DEFAULT '{}'`.
 * They are reached only when the caller leaves the field out — the create route
 * never supplies them, the marketplace install always does — which is precisely
 * the "absent key keeps the column default" behaviour the removed payload had.
 *
 * `source_url` / `package_name` (T-61 ②) are bound as `$12` / `$13` and a caller
 * that omits them writes NULL, which is what the create route wants: only the
 * marketplace install knows where a skill came from.
 */
const INSERT_OWN_SKILL_SQL = `
insert into public.skills
  (name, slug, description, author, version, license, category, icon_name,
   source, skill_content, metadata, source_url, package_name, created_by)
values ($2::text,
        $3::text,
        $4::text,
        coalesce($5::text, 'system'),
        coalesce($6::text, '1.0'),
        $7::text,
        $8::text,
        $9::text,
        'user',
        $10::text,
        coalesce($11::jsonb, '{}'::jsonb),
        $12::text,
        $13::text,
        $1::uuid)
returning ${SKILL_COLS}
`;

/**
 * `insertOwnSkillFiles`: the whole batch in ONE statement, exactly like the
 * removed `.insert(rows)`.
 *
 * `jsonb_to_recordset` turns the JSON array into rows; the `where exists (...)`
 * part IS `skill_files_insert` (the skill must be a `user` skill of the actor), so
 * a skill that is not theirs produces ZERO rows instead of raising, and the
 * caller answers `{inserted: 0}`.
 *
 * `mime_type` falls back to the column's DEFAULT `'text/plain'` when a file omits
 * it, which is what PostgREST did for an absent key.
 *
 * A batch whose `file_path` violates the table's
 * `CHECK (file_path ~ '^(scripts|references|assets)/')` fails as a WHOLE (SQLSTATE
 * 23514) and writes nothing — the same all-or-nothing answer the removed
 * multi-row insert gave.
 */
const INSERT_OWN_SKILL_FILES_SQL = `
insert into public.skill_files (skill_id, file_path, content, mime_type)
select $2::uuid,
       f.file_path,
       f.content,
       coalesce(f.mime_type, 'text/plain')
  from jsonb_to_recordset($3::jsonb) as f(file_path text, content text, mime_type text)
 where exists (select 1 from public.skills s
                where s.id = $2::uuid
                  and s.source = 'user'
                  and s.created_by = $1::uuid)
returning id
`;

/**
 * `updateOwnSkill`: one statement for every possible patch.
 *
 * Six flag/value pairs, so the SQL text never depends on WHICH keys the patch
 * happens to carry. `case when $3::boolean then $4::text else s.name end` is the
 * whole mechanism: when a flag is false the column is assigned its own value,
 * which is a no-op PostgreSQL still evaluates as a write, so the
 * `skills_updated_at` trigger fires exactly as it did for the removed update.
 *
 * `name` and `slug` share `$3` because they are one edit: the removed write always
 * recomputed the slug when it changed the name.
 *
 * `where s.id = $2::uuid and s.created_by = $1::uuid` is `skills_update_user`'s
 * USING clause verbatim. A skill that is not the actor's yields zero rows, and the
 * caller reports that as `null`.
 */
const UPDATE_OWN_SKILL_SQL = `
update public.skills s
   set name = case when $3::boolean then $4::text else s.name end,
       slug = case when $3::boolean then $5::text else s.slug end,
       description = case when $6::boolean then $7::text else s.description end,
       category = case when $8::boolean then $9::text else s.category end,
       skill_content = case when $10::boolean then $11::text else s.skill_content end,
       icon_name = case when $12::boolean then $13::text else s.icon_name end
 where s.id = $2::uuid
   and s.created_by = $1::uuid
returning ${SKILL_COLS_S}
`;

/**
 * `deleteOwnSkill`: `skills_delete_user` verbatim. The skill's files and its
 * workspace installs go with it through the two `ON DELETE CASCADE` foreign keys,
 * exactly as before.
 */
const DELETE_OWN_SKILL_SQL = `
delete from public.skills s
 where s.id = $2::uuid
   and s.created_by = $1::uuid
returning s.id
`;

/**
 * `upsertWorkspaceSkill`: install, or re-enable, a skill in one workspace.
 *
 * The `where` is `private.is_workspace_admin_or_owner` with both branches; when it
 * admits no row the insert writes nothing and the caller THROWS, which is the
 * answer a non-admin got from the removed upsert (a policy error the route mapped
 * onto 500). It is deliberately not turned into `{installed: 0}`: a silent success
 * would report an install that never happened.
 *
 * `on conflict (workspace_id, skill_id) do update set enabled = excluded.enabled,
 * installed_by = excluded.installed_by` is the removed upsert's
 * `{ onConflict: "workspace_id,skill_id" }`: `installed_at` is NOT in the SET list,
 * so re-installing keeps the original timestamp, and `enabled` is overwritten —
 * which is also what makes PATCH able to install a skill that was never installed.
 */
const UPSERT_WORKSPACE_SKILL_SQL = `
insert into public.workspace_skills (workspace_id, skill_id, enabled, installed_by)
select $2::uuid, $3::uuid, $4::boolean, $1::uuid
 where ${WORKSPACE_ADMIN_OR_OWNER}
on conflict (workspace_id, skill_id) do update
   set enabled = excluded.enabled,
       installed_by = excluded.installed_by
returning id
`;

/**
 * `deleteWorkspaceSkill`: `ws_skills_delete` verbatim, both branches of
 * `private.is_workspace_admin_or_owner` included.
 *
 * Deleting zero rows is not an error: the route answers 404 for it, which is what
 * a non-admin got before — the USING clause simply matched nothing, so the removed
 * delete reported a count of 0 rather than a 403.
 */
const DELETE_WORKSPACE_SKILL_SQL = `
delete from public.workspace_skills ws
 where ws.workspace_id = $2::uuid
   and ws.skill_id = $3::uuid
   and ${WORKSPACE_ADMIN_OR_OWNER}
returning ws.id
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing `DATABASE_URL`
 * only surfaces as a `SkillRepositoryError` on an actual call.
 *
 * There is no fallback path. A caller that was handed this repository either
 * reads/writes through it or fails.
 */
export function createSkillRepository(options: {
  getTransactionPool: () => TransactionPool;
}): SkillRepository {
  /**
   * The one privileged transaction every method runs in, with the failure
   * classification every method shares: anything that escapes the callback becomes
   * a `SkillRepositoryError` naming ITS operation, and the driver's own error rides
   * along as `cause` only.
   *
   * The transaction context carries WHO asked and, when the statement is about one
   * workspace, WHICH workspace, so a privileged statement is not anonymous in a
   * log or an audit trail. It grants nothing: the statement's own predicate is the
   * authorisation rule.
   */
  async function run<T>(
    operation: SkillRepositoryOperation,
    actor: { userId: string; workspaceId?: string },
    statement: (client: TransactionConnection) => Promise<T>,
  ): Promise<T> {
    try {
      const pool = options.getTransactionPool();

      return await withPrivilegedTransaction(pool, actor, statement);
    } catch (error) {
      throw new SkillRepositoryError(operation, error);
    }
  }

  return {
    async listVisibleSkills(actorId) {
      const actor = requireArgument(actorId, "actorId", LIST_VISIBLE_SKILLS);

      return run(LIST_VISIBLE_SKILLS, { userId: actor }, async (client) => {
        const result = await client.query(LIST_VISIBLE_SKILLS_SQL, [actor]);

        return result.rows.map(mapSkillRow);
      });
    },

    async findVisibleSkill(actorId, skillId) {
      const actor = requireArgument(actorId, "actorId", FIND_VISIBLE_SKILL);
      const id = requireArgument(skillId, "skillId", FIND_VISIBLE_SKILL);

      return run(FIND_VISIBLE_SKILL, { userId: actor }, async (client) => {
        const result = await client.query(FIND_VISIBLE_SKILL_SQL, [actor, id]);

        // `maybeSingle` semantics: no row is the answer `null`, more than one is a
        // statement/mapper disagreement (the id is the primary key).
        if (result.rows.length === 0) return null;
        if (result.rows.length > 1) {
          throw new Error("skill repository found more than one skill row");
        }

        return mapSkillRow(result.rows[0]);
      });
    },

    async listVisibleSkillFiles(actorId, skillId) {
      const actor = requireArgument(
        actorId,
        "actorId",
        LIST_VISIBLE_SKILL_FILES,
      );
      const id = requireArgument(skillId, "skillId", LIST_VISIBLE_SKILL_FILES);

      return run(LIST_VISIBLE_SKILL_FILES, { userId: actor }, async (client) => {
        const result = await client.query(LIST_VISIBLE_SKILL_FILES_SQL, [
          actor,
          id,
        ]);

        return result.rows.map(mapSkillFileRow);
      });
    },

    async listWorkspaceInstalledSkills(actorId, workspaceId) {
      const actor = requireArgument(
        actorId,
        "actorId",
        LIST_WORKSPACE_INSTALLED_SKILLS,
      );
      const workspace = requireArgument(
        workspaceId,
        "workspaceId",
        LIST_WORKSPACE_INSTALLED_SKILLS,
      );

      return run(
        LIST_WORKSPACE_INSTALLED_SKILLS,
        { userId: actor, workspaceId: workspace },
        async (client) => {
          const result = await client.query(
            LIST_WORKSPACE_INSTALLED_SKILLS_SQL,
            [actor, workspace],
          );

          return result.rows.map(mapWorkspaceInstalledSkillRow);
        },
      );
    },

    async insertOwnSkill(actorId, fields) {
      const actor = requireArgument(actorId, "actorId", INSERT_OWN_SKILL);
      const input = requireInsertFields(fields);

      return run(INSERT_OWN_SKILL, { userId: actor }, async (client) => {
        const result = await client.query(INSERT_OWN_SKILL_SQL, [
          actor,
          input.name,
          input.slug,
          input.description,
          input.author,
          input.version,
          input.license,
          input.category,
          input.iconName,
          input.skillContent,
          input.metadata === null ? null : JSON.stringify(input.metadata),
          input.sourceUrl,
          input.packageName,
        ]);

        // The insert has no `where`: it either produced the row or PostgreSQL
        // raised (23505 for a duplicate slug included).
        if (result.rows.length !== 1) {
          throw new Error("skill repository inserted no skill row");
        }

        return mapSkillRow(result.rows[0]);
      });
    },

    async insertOwnSkillFiles(actorId, skillId, files) {
      const actor = requireArgument(
        actorId,
        "actorId",
        INSERT_OWN_SKILL_FILES,
      );
      const id = requireArgument(skillId, "skillId", INSERT_OWN_SKILL_FILES);
      const batch = (files ?? []).map((file) => requireFileInput(file));

      // An empty batch is answered WITHOUT a connection: there is no statement to
      // send, and the removed write sent none either (both call sites guarded it
      // with a length check).
      if (batch.length === 0) return { inserted: 0 };

      return run(INSERT_OWN_SKILL_FILES, { userId: actor }, async (client) => {
        const result = await client.query(INSERT_OWN_SKILL_FILES_SQL, [
          actor,
          id,
          JSON.stringify(
            batch.map((file) => ({
              file_path: file.filePath,
              content: file.content,
              mime_type: file.mimeType,
            })),
          ),
        ]);

        return { inserted: result.rows.length };
      });
    },

    async updateOwnSkill(actorId, skillId, patch) {
      const actor = requireArgument(actorId, "actorId", UPDATE_OWN_SKILL);
      const id = requireArgument(skillId, "skillId", UPDATE_OWN_SKILL);
      const input = patch ?? {};

      // The flags are decided HERE, from whether the key is present, and the
      // statement never changes shape because of them. `name` and `slug` are one
      // flag: a rename always rewrites the slug.
      const hasName = input.name !== undefined || input.slug !== undefined;
      const hasDescription = input.description !== undefined;
      const hasCategory = input.category !== undefined;
      const hasSkillContent = input.skill_content !== undefined;
      const hasIconName = input.icon_name !== undefined;

      const name = hasName
        ? requireArgument(input.name, "name", UPDATE_OWN_SKILL)
        : null;
      const slug = hasName
        ? requireArgument(input.slug, "slug", UPDATE_OWN_SKILL)
        : null;
      const description = hasDescription
        ? requireTextArgument(input.description, "description", UPDATE_OWN_SKILL)
        : null;
      const category = hasCategory
        ? requireTextArgument(input.category, "category", UPDATE_OWN_SKILL)
        : null;
      const skillContent = hasSkillContent
        ? requireTextArgument(
            input.skill_content,
            "skill_content",
            UPDATE_OWN_SKILL,
          )
        : null;
      const iconName = hasIconName
        ? requireNullableTextArgument(
            input.icon_name,
            "icon_name",
            UPDATE_OWN_SKILL,
          )
        : null;

      return run(UPDATE_OWN_SKILL, { userId: actor }, async (client) => {
        const result = await client.query(UPDATE_OWN_SKILL_SQL, [
          actor,
          id,
          hasName,
          name,
          slug,
          hasDescription,
          description,
          hasCategory,
          category,
          hasSkillContent,
          skillContent,
          hasIconName,
          iconName,
        ]);

        // Zero rows means "not there, or not the actor's" — the route answers 404
        // for it, so it must NOT be an error here.
        if (result.rows.length === 0) return null;
        if (result.rows.length > 1) {
          throw new Error("skill repository updated more than one skill row");
        }

        return mapSkillRow(result.rows[0]);
      });
    },

    async deleteOwnSkill(actorId, skillId) {
      const actor = requireArgument(actorId, "actorId", DELETE_OWN_SKILL);
      const id = requireArgument(skillId, "skillId", DELETE_OWN_SKILL);

      return run(DELETE_OWN_SKILL, { userId: actor }, async (client) => {
        const result = await client.query(DELETE_OWN_SKILL_SQL, [actor, id]);

        return { deleted: result.rows.length };
      });
    },

    async upsertWorkspaceSkill(actorId, workspaceId, skillId, enabled) {
      const actor = requireArgument(actorId, "actorId", UPSERT_WORKSPACE_SKILL);
      const workspace = requireArgument(
        workspaceId,
        "workspaceId",
        UPSERT_WORKSPACE_SKILL,
      );
      const id = requireArgument(skillId, "skillId", UPSERT_WORKSPACE_SKILL);
      const flag = requireBooleanArgument(
        enabled,
        "enabled",
        UPSERT_WORKSPACE_SKILL,
      );

      await run(
        UPSERT_WORKSPACE_SKILL,
        { userId: actor, workspaceId: workspace },
        async (client) => {
          const result = await client.query(UPSERT_WORKSPACE_SKILL_SQL, [
            actor,
            workspace,
            id,
            flag,
          ]);

          // Neither branch of `is_workspace_admin_or_owner` admitted the actor, so
          // the insert wrote nothing. That is the exact point at which the removed
          // upsert raised a policy error, and the route turns both into a 500.
          if (result.rows.length === 0) {
            throw new Error(
              "workspace skill upsert is not permitted for this actor",
            );
          }
        },
      );
    },

    async deleteWorkspaceSkill(actorId, workspaceId, skillId) {
      const actor = requireArgument(actorId, "actorId", DELETE_WORKSPACE_SKILL);
      const workspace = requireArgument(
        workspaceId,
        "workspaceId",
        DELETE_WORKSPACE_SKILL,
      );
      const id = requireArgument(skillId, "skillId", DELETE_WORKSPACE_SKILL);

      return run(
        DELETE_WORKSPACE_SKILL,
        { userId: actor, workspaceId: workspace },
        async (client) => {
          const result = await client.query(DELETE_WORKSPACE_SKILL_SQL, [
            actor,
            workspace,
            id,
          ]);

          return { deleted: result.rows.length };
        },
      );
    },
  };
}

/** The values `insertOwnSkill` binds, normalised before the transaction opens. */
type NormalisedInsertFields = {
  name: string;
  slug: string;
  description: string;
  category: string;
  skillContent: string;
  iconName: string | null;
  author: string | null;
  version: string | null;
  license: string | null;
  metadata: Record<string, unknown> | null;
  sourceUrl: string | null;
  packageName: string | null;
};

function requireInsertFields(fields: unknown): NormalisedInsertFields {
  const record = asRecord(fields, INSERT_OWN_SKILL, "fields");

  return {
    name: requireArgument(record["name"], "name", INSERT_OWN_SKILL),
    // The empty slug for a pure-CJK name is a FROZEN behaviour (T-61), so the
    // column's value is passed through and only its TYPE is checked here.
    slug: requireTextArgument(record["slug"], "slug", INSERT_OWN_SKILL),
    description: requireTextArgument(
      record["description"],
      "description",
      INSERT_OWN_SKILL,
    ),
    category: requireArgument(record["category"], "category", INSERT_OWN_SKILL),
    skillContent: requireTextArgument(
      record["skillContent"],
      "skillContent",
      INSERT_OWN_SKILL,
    ),
    iconName: requireOptionalText(record["iconName"], "iconName"),
    author: requireOptionalText(record["author"], "author"),
    version: requireOptionalText(record["version"], "version"),
    license: requireOptionalText(record["license"], "license"),
    metadata: requireOptionalMetadata(record["metadata"]),
    sourceUrl: requireOptionalText(record["sourceUrl"], "sourceUrl"),
    packageName: requireOptionalText(record["packageName"], "packageName"),
  };
}

function requireFileInput(file: unknown): {
  filePath: string;
  content: string;
  mimeType: string | null;
} {
  const record = asRecord(file, INSERT_OWN_SKILL_FILES, "file");

  return {
    filePath: requireArgument(
      record["filePath"],
      "filePath",
      INSERT_OWN_SKILL_FILES,
    ),
    content: requireTextArgument(
      record["content"],
      "content",
      INSERT_OWN_SKILL_FILES,
    ),
    mimeType: requireOptionalText(record["mimeType"], "mimeType"),
  };
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable. Pre-validating it here
 * would hide that path instead of exercising it.
 *
 * Trimming is the caller's decision and is NOT repeated in this module.
 */
function requireArgument(
  value: unknown,
  field: string,
  operation: SkillRepositoryOperation,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SkillRepositoryError(
      operation,
      new Error(`skill repository needs a non-empty "${field}"`),
    );
  }

  return value;
}

/** A text column whose empty string is a legal value (`description`, `slug`, …). */
function requireTextArgument(
  value: unknown,
  field: string,
  operation: SkillRepositoryOperation,
): string {
  if (typeof value !== "string") {
    throw new SkillRepositoryError(
      operation,
      new Error(`skill repository needs a string "${field}"`),
    );
  }

  return value;
}

/** A nullable text column: a string (empty included) or `null`. */
function requireNullableTextArgument(
  value: unknown,
  field: string,
  operation: SkillRepositoryOperation,
): string | null {
  if (value === null || typeof value === "string") return value as string | null;

  throw new SkillRepositoryError(
    operation,
    new Error(`skill repository needs a nullable string "${field}"`),
  );
}

/**
 * An OPTIONAL column: `undefined` (leave the column default alone) or a string.
 * `null` is accepted as "not supplied" for the two columns whose default IS NULL,
 * and is rejected for `author` / `version` by `requireOptionalText`'s caller
 * (`insertOwnSkill` passes it straight into a `coalesce`, so a null there would
 * silently become the default — which is the same answer, so it is allowed).
 */
function requireOptionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;

  throw new SkillRepositoryError(
    INSERT_OWN_SKILL,
    new Error(`skill repository needs a string "${field}"`),
  );
}

function requireOptionalMetadata(
  value: unknown,
): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SkillRepositoryError(
      INSERT_OWN_SKILL,
      new Error('skill repository needs an object "metadata"'),
    );
  }

  return value as Record<string, unknown>;
}

function requireBooleanArgument(
  value: unknown,
  field: string,
  operation: SkillRepositoryOperation,
): boolean {
  if (typeof value !== "boolean") {
    throw new SkillRepositoryError(
      operation,
      new Error(`skill repository needs a boolean "${field}"`),
    );
  }

  return value;
}

function asRecord(
  value: unknown,
  operation: SkillRepositoryOperation,
  field: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillRepositoryError(
      operation,
      new Error(`skill repository needs an object "${field}"`),
    );
  }

  return value as Record<string, unknown>;
}

/** `public.skills`'s row, mapped strictly: a missing column is statement/mapper drift. */
export function mapSkillRow(row: unknown): SkillRow {
  const record = asRow(row);

  return {
    id: requireRowId(record, "id"),
    name: requireRowText(record, "name"),
    slug: requireRowText(record, "slug"),
    description: requireRowText(record, "description"),
    author: requireRowText(record, "author"),
    version: requireRowText(record, "version"),
    license: requireRowNullableText(record, "license"),
    category: requireRowText(record, "category"),
    icon_name: requireRowNullableText(record, "icon_name"),
    source: requireRowText(record, "source"),
    skill_content: requireRowText(record, "skill_content"),
    metadata: requireRowMetadata(record, "metadata"),
    is_featured: requireRowBoolean(record, "is_featured"),
    created_by: requireRowNullableText(record, "created_by"),
    created_at: requireRowTimestamp(record, "created_at"),
    updated_at: requireRowTimestamp(record, "updated_at"),
    source_url: requireRowNullableText(record, "source_url"),
    package_name: requireRowNullableText(record, "package_name"),
  };
}

function mapSkillFileRow(row: unknown): SkillFileRecord {
  const record = asRow(row);

  return {
    id: requireRowId(record, "id"),
    skill_id: requireRowId(record, "skill_id"),
    file_path: requireRowText(record, "file_path"),
    // Content is `text not null` and an EMPTY file is a real file.
    content: requireRowText(record, "content"),
    mime_type: requireRowText(record, "mime_type"),
    created_at: requireRowTimestamp(record, "created_at"),
    updated_at: requireRowTimestamp(record, "updated_at"),
  };
}

function mapWorkspaceInstalledSkillRow(row: unknown): WorkspaceInstalledSkillRow {
  // The skill half is mapped by the same function the other reads use, so the two
  // cannot disagree about a column.
  const skill = mapSkillRow(row);
  const record = asRow(row);

  return {
    ...skill,
    enabled: requireRowBoolean(record, "enabled"),
    installed_at: requireRowTimestamp(record, "installed_at"),
  };
}

function asRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("skill repository received a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/** `id` and `skill_id` are uuids; an empty one would be a mapper failure. */
function requireRowId(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`skill repository returned no usable "${field}"`);
  }

  return value;
}

/** `text NOT NULL` columns whose EMPTY string is a legal value. */
function requireRowText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`skill repository returned an unusable "${field}"`);
  }

  return value;
}

function requireRowNullableText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;

  if (typeof value !== "string") {
    throw new Error(`skill repository returned an unusable "${field}"`);
  }

  return value;
}

function requireRowBoolean(
  row: Readonly<Record<string, unknown>>,
  field: string,
): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new Error(`skill repository returned an unusable "${field}"`);
  }

  return value;
}

/** JSONB: an object or SQL NULL. Anything else (an array, a scalar) is drift. */
function requireRowMetadata(
  row: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> | null {
  const value = row[field];
  if (value === null || value === undefined) return null;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`skill repository returned an unusable "${field}"`);
  }

  return value as Record<string, unknown>;
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; the HTTP DTO is a string
 * with an offset. Both are accepted and normalised to `toISOString()`.
 *
 * This is the same rule the other repositories apply to the same column type. It
 * is duplicated rather than imported because those modules report failures as
 * their own error classes.
 */
function requireRowTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`skill repository returned an unusable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`skill repository returned no usable "${field}"`);
}
