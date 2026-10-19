/**
 * Workspace skill read repository (workorder 21AC, ADR-0001 migration step).
 *
 * The Agent run's two skill reads move here: the ENABLED skills installed in the
 * run's workspace (with the skill row joined in) and the bundled files of those
 * skills. Both used to be PostgREST reads on the caller's own user-scoped client,
 * where ROW LEVEL SECURITY decided what existed. The two policies are
 *
 *   -- supabase/migrations/20260331000000_skills_management.sql
 *   CREATE POLICY ws_skills_select ON public.workspace_skills
 *     FOR SELECT TO authenticated
 *     USING (private.is_workspace_member(workspace_id));
 *
 *   CREATE POLICY skills_select_all ON public.skills
 *     FOR SELECT TO authenticated
 *     USING (source IN ('system', 'community') OR created_by = auth.uid());
 *
 *   -- supabase/migrations/20260403100000_skill_files.sql
 *   CREATE POLICY skill_files_select ON public.skill_files
 *     FOR SELECT TO authenticated
 *     USING (EXISTS (
 *       SELECT 1 FROM public.skills s
 *       WHERE s.id = skill_files.skill_id
 *         AND (s.source IN ('system', 'community') OR s.created_by = auth.uid())));
 *
 * This repository runs privileged (the pool's role owns these tables and
 * bypasses RLS), so the policies above no longer run and each statement's OWN
 * predicates are the only gate there is. That is why both of them are written
 * out rather than inherited from something that is no longer evaluated:
 *
 * - the membership conjunct is the body of `private.is_workspace_member` with its
 *   argument bound (`auth.uid() is not null` is implied, because a non-empty
 *   actor is a precondition of every call here);
 * - the skill-visibility conjunct is `skills_select_all` / `skill_files_select`
 *   translated verbatim, carried on the skill JOIN so a skill the actor may not
 *   see cannot contribute a row at all.
 *
 * The join form is exactly what PostgREST's embedded resource produced: an
 * embedded skill the caller could not see came back as `null` and the loader
 * dropped that row, which is the same answer an inner join gives. It is an INNER
 * join on purpose — `workspace_skills.skill_id` is NOT NULL with a foreign key,
 * so there is no "installed row with no skill" to preserve.
 *
 * Two consequences of the old shape are deliberately NOT reproduced here:
 *
 * - statement 1 has NO `order by`. The removed read had none either, so the row
 *   order it produced was never part of any contract. Adding one would make the
 *   skills prompt deterministic in a way nothing asked for;
 * - statement 1 answers the SKILL columns and nothing else. `workspace_skills`
 *   carries `config` / `installed_at` / `installed_by`, none of which the loader
 *   ever read.
 *
 * Every failure — a bad argument, a connect, SQL, timeout or row-shape failure —
 * throws `WorkspaceSkillReadError`, whose own message is fixed text naming only
 * the operation: no SQL, no host, no connection string and no workspace, skill or
 * file id. The driver's own error rides along as `cause`.
 *
 * The pool is reached through a getter, so importing or wiring this module never
 * reads `DATABASE_URL`, never connects and never fails at build time. A missing
 * pool is a read failure on the call, never a silent fallback: nothing in this
 * module can reach PostgREST.
 */

import {
  withPrivilegedTransaction,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/** A `public.skills` row as the loader consumes it, in the statement's order. */
export type WorkspaceSkillRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** `text not null` in the table, but the loader skips an empty one — see below. */
  skill_content: string | null;
  /** `jsonb DEFAULT '{}'`, nullable: SQL NULL is an answer, not a shape error. */
  metadata: Record<string, unknown> | null;
};

/** One `public.skill_files` row of a skill the actor may see. */
export type SkillFileRow = {
  skill_id: string;
  file_path: string;
  content: string;
};

export type WorkspaceSkillReadRepository = {
  /**
   * The ENABLED skills installed in `workspaceId` that `actorId` is allowed to
   * see, joined to their skill row. Empty when the workspace has none enabled,
   * when the actor is not a member, or when every installed skill is a user
   * skill of somebody else.
   */
  listEnabledWorkspaceSkills(input: {
    actorId: string;
    workspaceId: string;
  }): Promise<WorkspaceSkillRow[]>;

  /**
   * The bundled files of `skillIds`, filtered to the skills `actorId` may see.
   * An empty `skillIds` is the answer `[]` and issues no SQL at all — see the
   * note on the statement below.
   */
  listSkillFiles(input: {
    actorId: string;
    skillIds: readonly string[];
  }): Promise<SkillFileRow[]>;
};

export const LIST_ENABLED_WORKSPACE_SKILLS = "listEnabledWorkspaceSkills";
export const LIST_SKILL_FILES = "listSkillFiles";

export type WorkspaceSkillReadOperation =
  | typeof LIST_ENABLED_WORKSPACE_SKILLS
  | typeof LIST_SKILL_FILES;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line through us.
 */
export class WorkspaceSkillReadError extends Error {
  readonly operation: WorkspaceSkillReadOperation;

  constructor(operation: WorkspaceSkillReadOperation, cause: unknown) {
    super(
      `workspace skill read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "WorkspaceSkillReadError";
    this.operation = operation;
  }
}

/**
 * Statement 1: the enabled skills of one workspace, `ws_skills_select` and
 * `skills_select_all` translated verbatim.
 *
 * `ws.workspace_id = $2::uuid and ws.enabled = true` is the question the removed
 * read asked (`.eq("workspace_id", …).eq("enabled", true)`), and the two clauses
 * after it are the two policies: the membership `exists` is
 * `private.is_workspace_member(ws.workspace_id)` with its argument bound, and the
 * `and (s.source in … or s.created_by = …)` half of the JOIN is
 * `skills_select_all`. Both are needed and neither is redundant — the
 * membership clause alone would expose another member's private user skills, and
 * the visibility clause alone would expose the workspace's skills to a
 * non-member.
 *
 * The ids are bound with explicit `::uuid` casts, so a malformed one fails as a
 * real SQL error (SQLSTATE 22P02) inside the transaction instead of silently
 * matching something else.
 *
 * `s.metadata` is published as it arrived — an object or SQL NULL — because the
 * loader never reads it; it is in the projection only because the removed read
 * selected it.
 */
const LIST_ENABLED_WORKSPACE_SKILLS_SQL = `
select s.id, s.slug, s.name, s.description, s.skill_content, s.metadata
  from public.workspace_skills ws
  join public.skills s
    on s.id = ws.skill_id
   and (s.source in ('system', 'community') or s.created_by = $1::uuid)
 where ws.workspace_id = $2::uuid
   and ws.enabled = true
   and exists (select 1 from public.workspace_members m
                where m.workspace_id = ws.workspace_id
                  and m.user_id = $1::uuid)
`;

/**
 * Statement 2: the files of the given skills, `skill_files_select` verbatim.
 *
 * The `exists` clause IS the policy. It is kept even though every id in `$2` came
 * from statement 1 — a repository whose authorisation is "the caller passed the
 * right ids" has no authorisation of its own, and this statement has to refuse a
 * skill the actor may not see if one is ever bound to it.
 *
 * There is deliberately no ORDER BY: the removed read had none, and the loader
 * groups by `skill_id` into a list whose order was never promised.
 */
const LIST_SKILL_FILES_SQL = `
select f.skill_id, f.file_path, f.content
  from public.skill_files f
  join public.skills s
    on s.id = f.skill_id
   and (s.source in ('system', 'community') or s.created_by = $1::uuid)
 where f.skill_id = any($2::uuid[])
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `WorkspaceSkillReadError` on an actual read.
 *
 * There is no fallback path. A caller that was handed this repository either
 * reads through it or fails.
 */
export function createWorkspaceSkillReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): WorkspaceSkillReadRepository {
  /**
   * The one privileged transaction every method runs in, with the failure
   * classification every method shares: anything that escapes the callback
   * becomes a `WorkspaceSkillReadError` naming ITS operation, and the driver's
   * own error rides along as `cause` only.
   */
  async function read<T>(
    operation: WorkspaceSkillReadOperation,
    actor: { userId: string; workspaceId?: string },
    run: (client: TransactionConnection) => Promise<T>,
  ): Promise<T> {
    try {
      const pool = options.getTransactionPool();

      return await withPrivilegedTransaction(
        pool,
        // The transaction context carries WHO asked and, for the workspace read,
        // WHICH workspace, so a privileged read is not anonymous in a log or an
        // audit trail. It grants nothing: the statements' own predicates above
        // are the authorisation rule.
        actor,
        run,
      );
    } catch (error) {
      throw new WorkspaceSkillReadError(operation, error);
    }
  }

  return {
    async listEnabledWorkspaceSkills(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const actorId = requireReadArgument(
        input.actorId,
        "actorId",
        LIST_ENABLED_WORKSPACE_SKILLS,
      );
      const workspaceId = requireReadArgument(
        input.workspaceId,
        "workspaceId",
        LIST_ENABLED_WORKSPACE_SKILLS,
      );

      return read(
        LIST_ENABLED_WORKSPACE_SKILLS,
        { userId: actorId, workspaceId },
        async (client) => {
          const result = await client.query(LIST_ENABLED_WORKSPACE_SKILLS_SQL, [
            actorId,
            workspaceId,
          ]);

          return result.rows.map(mapWorkspaceSkillRow);
        },
      );
    },

    async listSkillFiles(input) {
      const actorId = requireReadArgument(
        input.actorId,
        "actorId",
        LIST_SKILL_FILES,
      );

      // "No skills" is not a query that returns nothing, it is the answer: skip
      // the pool entirely, so an empty id list cannot open a connection, and so
      // a pointless `any('{}')` never reaches the wire. The removed read had the
      // same shortcut at its call site.
      if (input.skillIds.length === 0) return [];

      const skillIds = requireSkillIdList(input.skillIds, LIST_SKILL_FILES);

      return read(LIST_SKILL_FILES, { userId: actorId }, async (client) => {
        const result = await client.query(LIST_SKILL_FILES_SQL, [
          actorId,
          skillIds,
        ]);

        return result.rows.map(mapSkillFileRow);
      });
    },
  };
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable.
 */
function requireReadArgument(
  value: unknown,
  field: string,
  operation: WorkspaceSkillReadOperation,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceSkillReadError(
      operation,
      new Error(`workspace skill read needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * `any($2::uuid[])` needs every element to be a usable value, and the array
 * itself is a fresh copy so a caller cannot mutate the bind list mid-flight.
 * A half-formed id is a caller bug, not "no rows": it fails before the pool is
 * touched rather than as a 22P02 that looks like the caller's id was fine.
 */
function requireSkillIdList(
  value: readonly unknown[],
  operation: WorkspaceSkillReadOperation,
): string[] {
  const ids: string[] = [];

  for (const candidate of value) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new WorkspaceSkillReadError(
        operation,
        new Error('workspace skill read needs a non-empty "skillId"'),
      );
    }
    ids.push(candidate);
  }

  return ids;
}

/**
 * Statement 1's row, mapped strictly. `id`, `slug`, `name` and `description` are
 * declared columns with a type the loader consumes; `skill_content` and
 * `metadata` are the two the loader tolerates as absent, so SQL NULL there is an
 * ANSWER rather than a shape problem.
 */
function mapWorkspaceSkillRow(row: unknown): WorkspaceSkillRow {
  const record = asReadRow(row);

  return {
    id: requireString(record, "id"),
    slug: requireString(record, "slug"),
    name: requireText(record, "name"),
    description: requireText(record, "description"),
    skill_content: requireNullableString(record, "skill_content"),
    metadata: requireMetadata(record, "metadata"),
  };
}

/** Statement 2's row: three non-null text columns, none of them optional. */
function mapSkillFileRow(row: unknown): SkillFileRow {
  const record = asReadRow(row);

  return {
    skill_id: requireString(record, "skill_id"),
    file_path: requireString(record, "file_path"),
    // Content is `text not null` and an EMPTY file is a real file: the loader
    // publishes it as-is, so only the type is checked.
    content: requireText(record, "content"),
  };
}

function asReadRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workspace skill read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

function requireString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`workspace skill read returned no usable "${field}"`);
  }

  return value;
}

/**
 * `name` and `description` are `text not null` with a default, and an EMPTY
 * description is reachable in the column today (`description text NOT NULL DEFAULT
 * ''`). The read this replaces published it unchanged — the loader only ever
 * prints it — so tightening that here would be a silent behaviour change.
 */
function requireText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`workspace skill read returned an unusable "${field}"`);
  }

  return value;
}

/**
 * `skill_content` is `text not null` in the table, but the loader has always
 * treated an empty one as "skip this skill and warn", so NULL and `""` both stay
 * in the accepted set: this module must not decide that a skill without content
 * is a repository failure.
 */
function requireNullableString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;

  if (typeof value !== "string") {
    throw new Error(`workspace skill read returned an unusable "${field}"`);
  }

  return value;
}

/**
 * `metadata` is `JSONB DEFAULT '{}'` and NULLABLE. An OBJECT or SQL NULL is the
 * whole accepted set; anything else (an array, a scalar) is drift.
 */
function requireMetadata(
  row: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> | null {
  const value = row[field];
  if (value === null || value === undefined) return null;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`workspace skill read returned an unusable "${field}"`);
  }

  return value as Record<string, unknown>;
}
