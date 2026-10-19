/**
 * Project write repository (workorder 21AA, ADR-0001 migration step).
 *
 * The THREE PostgREST writes that used to run inside
 * `features/projects/project-service.ts` — archive, the thumbnail reference, and
 * the name / brand-kit patch — now run here as three named statements. Nothing
 * about the published behaviour moves with them: the service keeps every error
 * code, HTTP status and message it had, including all three places that answer
 * success when the statement touched zero rows.
 *
 * Rules this module keeps, and why each one matters:
 *
 * - The interface is CLOSED: three methods, each with one fixed statement. There
 *   is no access token, no table name, no arbitrary column and no generic
 *   `patch(table, fields)`, so a caller cannot widen a write by naming a column
 *   this module never writes.
 * - Every statement runs through workorder 19's transaction entry point with the
 *   actor in the context. The pool's role owns the table and therefore bypasses
 *   row level security, which is exactly why the authorisation rule has to be the
 *   statement's OWN predicate, and why the context is only ever an audit trail —
 *   it grants nothing.
 * - The ACL is `projects_update_owner` of
 *   `supabase/migrations/20260929000001_hahart_team_workspace_private_rls.sql`
 *   translated verbatim, and nothing else:
 *
 *       using (created_by = auth.uid()
 *              and private.is_workspace_member(workspace_id))
 *
 *   The policy has the SAME expression in `with check`, so the one predicate is
 *   both "which rows may be touched" and "which rows may result". `$1::uuid` is
 *   `auth.uid()`; `created_by = $1::uuid` is the author half; the membership half
 *   is the body of `private.is_workspace_member` with the argument bound to this
 *   row's `workspace_id`, and it is written ONCE in
 *   `MEMBER_OF_PROJECT_WORKSPACE` below so the three statements cannot drift
 *   apart. That fragment is the same predicate `db/project-read-repository.ts`
 *   already carries in `READABLE_PROJECT_WORKSPACE_FOR_MUTATION_SQL`
 *   (`m.workspace_id = p.workspace_id and m.user_id = $1`), written as the
 *   `exists` the policy function itself uses.
 * - NO archive filter. `projects_update_owner` has no `archived_at` term, so an
 *   archived project stays writable. Adding one here would silently change what
 *   the three flows can do (workorder 21V: a predicate the policy does not have
 *   is not to be invented).
 * - NO administrator escape. `admin`/`owner` widen the READ policy, not this one:
 *   an administrator can see a project they did not create and still cannot write
 *   it. That asymmetry is the published contract and this migration must not
 *   start granting the write.
 * - Zero rows is an ANSWER, not an error: `{updated: 0}`. The removed PostgREST
 *   writes did not treat it as a failure either (an update behind `USING` that
 *   matched nothing answers 204 as well), and turning it into a throw here would
 *   change the status a caller sees.
 * - `archived_at` is `now()` in the statement, not a JavaScript timestamp. The
 *   removed write computed `new Date().toISOString()` and bound it; the only
 *   place that value was ever read is this one column (workorder 21AA §3.1
 *   verified it is not echoed in any response), so the database clock means the
 *   same thing with one less clock skew. `updated_at` is never written: the table
 *   has a `BEFORE UPDATE` `set_updated_at()` trigger, which fires under a
 *   privileged connection too.
 * - The UPDATE uses FLAG PARAMETERS instead of a dynamic SET list:
 *   `set name = case when $3::boolean then $4::text else p.name end`. The SQL text
 *   is therefore byte-identical whatever the patch contains, and only the
 *   parameters differ. A flag that is false assigns the column its own value,
 *   which is a no-op write PostgreSQL still evaluates — so the trigger fires for
 *   the same reason it fired for the removed update of that column.
 * - Every value is a bind parameter with an explicit cast, so a malformed uuid
 *   fails as a real SQL error (SQLSTATE 22P02) inside the transaction and rolls
 *   it back.
 * - An unusable argument (a non-empty string is required) throws
 *   `ProjectWriteError` WITHOUT opening a connection: there is no statement to
 *   send, and a connect attempt for a request that cannot be expressed is a round
 *   trip this workorder does not own.
 * - A connect, SQL, timeout or row-shape failure throws `ProjectWriteError`,
 *   whose own message is fixed text naming only the operation: no SQL, no host,
 *   no connection string and no project id. The driver's own error rides along as
 *   `cause` so a caller can classify it without the driver's message reaching a
 *   log line or an HTTP body.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a write failure on the call, never a silent fallback: nothing
 *   in this module can reach PostgREST.
 */

import {
  withPrivilegedTransaction,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * The two columns `updateOwnProject` may set. An ABSENT key means "leave this
 * column alone"; `brand_kit_id` present with `null` means "clear the binding",
 * which is a value the column really can hold. `name` is a `NOT NULL` column, so
 * the only way it can be absent is to be absent from the patch.
 */
export type ProjectWritePatch = {
  name?: string;
  brand_kit_id?: string | null;
};

export type ProjectWriteRepository = {
  /**
   * Set `archived_at` on the actor's own project. `updated` is 0 when the project
   * does not exist, belongs to somebody else, or sits in a workspace the actor is
   * not a member of — never an error.
   */
  archiveOwnProject(input: {
    actorId: string;
    projectId: string;
  }): Promise<{ updated: number }>;

  /**
   * Save the thumbnail reference on the actor's own project. Same zero-row rule.
   */
  setOwnProjectThumbnail(input: {
    actorId: string;
    projectId: string;
    thumbnailPath: string;
  }): Promise<{ updated: number }>;

  /**
   * Apply `patch` to the actor's own project. Columns missing from the patch are
   * left untouched. Same zero-row rule.
   */
  updateOwnProject(input: {
    actorId: string;
    projectId: string;
    patch: ProjectWritePatch;
  }): Promise<{ updated: number }>;
};

export const ARCHIVE_OWN_PROJECT = "archiveOwnProject";
export const SET_OWN_PROJECT_THUMBNAIL = "setOwnProjectThumbnail";
export const UPDATE_OWN_PROJECT = "updateOwnProject";

export type ProjectWriteOperation =
  | typeof ARCHIVE_OWN_PROJECT
  | typeof SET_OWN_PROJECT_THUMBNAIL
  | typeof UPDATE_OWN_PROJECT;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class ProjectWriteError extends Error {
  readonly operation: ProjectWriteOperation;

  constructor(operation: ProjectWriteOperation, cause: unknown) {
    super(
      `project write failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "ProjectWriteError";
    this.operation = operation;
  }
}

/**
 * The membership half of `projects_update_owner`, written as the `exists` the
 * policy's own `private.is_workspace_member` body uses:
 *
 *     exists (select 1 from public.workspace_members wm
 *              where wm.workspace_id = p_workspace_id
 *                and wm.user_id = auth.uid())
 *
 * `$1::uuid` is the actor and `p.workspace_id` is the row's workspace. It is
 * interpolated into all three statements from THIS one constant so the three
 * cannot disagree about what membership means — a divergence here is a silent
 * ACL fork. `workspace_members` is keyed by (workspace_id, user_id), so the
 * subquery is at most one row and cannot multiply the updated rows.
 */
const MEMBER_OF_PROJECT_WORKSPACE = `exists (select 1 from public.workspace_members m
                where m.workspace_id = p.workspace_id
                  and m.user_id = $1::uuid)`;

/**
 * `archiveOwnProject`: the write behind `DELETE /api/projects/:projectId`, which
 * archives rather than deletes.
 *
 * The service resolves the caller's visibility first (a READ, which filters
 * `archived_at` and admits administrators) and only then calls this. The two are
 * deliberately NOT merged into one statement: the removed code issued a lookup and
 * an update, and merging them would change which of the two answers 404.
 *
 * Note what is absent: `archived_at is null`. The policy has no such term, so
 * re-archiving an already archived project is a one-row update, not a no-op.
 */
const ARCHIVE_OWN_PROJECT_SQL = `
update public.projects p
   set archived_at = now()
 where p.id = $2::uuid
   and p.created_by = $1::uuid
   and ${MEMBER_OF_PROJECT_WORKSPACE}
returning p.id
`;

/**
 * `setOwnProjectThumbnail`: the reference write at the end of
 * `PUT /api/projects/:projectId/thumbnail`, after the object is uploaded and the
 * asset row is recorded through `record_project_asset`.
 *
 * `thumbnail_path` is bound as `$3::text`. The order of the three side effects is
 * the existing contract and stays in the service: object, metadata row, then this
 * reference.
 */
const SET_OWN_PROJECT_THUMBNAIL_SQL = `
update public.projects p
   set thumbnail_path = $3::text
 where p.id = $2::uuid
   and p.created_by = $1::uuid
   and ${MEMBER_OF_PROJECT_WORKSPACE}
returning p.id
`;

/**
 * `updateOwnProject`: ONE statement for every possible patch, behind
 * `PATCH /api/projects/:projectId`.
 *
 * Two flag/value pairs, one per writable column, so the SQL text never depends on
 * WHICH keys the patch happens to carry:
 *
 *     $3 boolean / $4 text  -> name
 *     $5 boolean / $6 uuid  -> brand_kit_id
 *
 * `$6::uuid` accepts NULL, which is how the binding is cleared — the removed
 * update bound the same null in the same way. The service returns before calling
 * this when the patch carries no key, so a both-flags-false call is unreachable in
 * production; the statement is still a well-defined no-op write if it happens.
 */
const UPDATE_OWN_PROJECT_SQL = `
update public.projects p
   set name = case when $3::boolean then $4::text else p.name end,
       brand_kit_id = case when $5::boolean then $6::uuid else p.brand_kit_id end
 where p.id = $2::uuid
   and p.created_by = $1::uuid
   and ${MEMBER_OF_PROJECT_WORKSPACE}
returning p.id
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `ProjectWriteError` on an actual write.
 *
 * There is no fallback path. A caller that was handed this repository either
 * writes through it or fails.
 */
export function createProjectWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): ProjectWriteRepository {
  /**
   * The one privileged transaction every method runs in, with the failure
   * classification every method shares: anything that escapes the callback becomes
   * a `ProjectWriteError` naming ITS operation, and the driver's own error rides
   * along as `cause` only.
   */
  async function write<T>(
    operation: ProjectWriteOperation,
    actorId: string,
    run: (client: TransactionConnection) => Promise<T>,
  ): Promise<T> {
    try {
      const pool = options.getTransactionPool();

      return await withPrivilegedTransaction(
        pool,
        // The context carries WHO asked, so a privileged write is not anonymous in
        // a log or an audit trail. It grants nothing: `$1::uuid` in the statement's
        // own predicate is the authorisation rule.
        { userId: actorId },
        run,
      );
    } catch (error) {
      throw new ProjectWriteError(operation, error);
    }
  }

  /** The shared body of the three writes: one statement, one row count. */
  async function writeCounted(
    operation: ProjectWriteOperation,
    actorId: string,
    sql: string,
    params: readonly unknown[],
  ): Promise<{ updated: number }> {
    return write(operation, actorId, async (client) => {
      const result = await client.query(sql, params);

      // `returning p.id` is the row count. Zero is a legitimate answer — the
      // predicate refused the row — and the callers map it onto their existing
      // success, never onto a 404 the removed code could not produce either.
      return { updated: result.rows.length };
    });
  }

  return {
    async archiveOwnProject(input) {
      const actorId = requireWriteArgument(
        input.actorId,
        "actorId",
        ARCHIVE_OWN_PROJECT,
      );
      const projectId = requireWriteArgument(
        input.projectId,
        "projectId",
        ARCHIVE_OWN_PROJECT,
      );

      return writeCounted(ARCHIVE_OWN_PROJECT, actorId, ARCHIVE_OWN_PROJECT_SQL, [
        actorId,
        projectId,
      ]);
    },

    async setOwnProjectThumbnail(input) {
      const actorId = requireWriteArgument(
        input.actorId,
        "actorId",
        SET_OWN_PROJECT_THUMBNAIL,
      );
      const projectId = requireWriteArgument(
        input.projectId,
        "projectId",
        SET_OWN_PROJECT_THUMBNAIL,
      );
      const thumbnailPath = requireWriteArgument(
        input.thumbnailPath,
        "thumbnailPath",
        SET_OWN_PROJECT_THUMBNAIL,
      );

      return writeCounted(
        SET_OWN_PROJECT_THUMBNAIL,
        actorId,
        SET_OWN_PROJECT_THUMBNAIL_SQL,
        [actorId, projectId, thumbnailPath],
      );
    },

    async updateOwnProject(input) {
      const actorId = requireWriteArgument(
        input.actorId,
        "actorId",
        UPDATE_OWN_PROJECT,
      );
      const projectId = requireWriteArgument(
        input.projectId,
        "projectId",
        UPDATE_OWN_PROJECT,
      );
      const patch = input.patch ?? {};

      // The flags are decided HERE, from whether the key is present, and the
      // statement never changes shape because of them.
      const hasName = patch.name !== undefined;
      const hasBrandKit = patch.brand_kit_id !== undefined;

      const name = hasName
        ? requireWriteArgument(patch.name, "name", UPDATE_OWN_PROJECT)
        : null;
      // `null` here CLEARS the binding; the flag is what tells the statement to do
      // it, so "clear" and "leave alone" stay distinguishable.
      const brandKitId = hasBrandKit
        ? requireNullableWriteText(
            patch.brand_kit_id,
            "brand_kit_id",
            UPDATE_OWN_PROJECT,
          )
        : null;

      return writeCounted(UPDATE_OWN_PROJECT, actorId, UPDATE_OWN_PROJECT_SQL, [
        actorId,
        projectId,
        hasName,
        name,
        hasBrandKit,
        brandKitId,
      ]);
    },
  };
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable. Pre-validating it here
 * would hide that path instead of exercising it.
 *
 * Trimming is the caller's decision and is NOT repeated in this module: the
 * service already decided what the stored value is, and doing it twice would make
 * that depend on which layer ran.
 */
function requireWriteArgument(
  value: unknown,
  field: string,
  operation: ProjectWriteOperation,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectWriteError(
      operation,
      new Error(`project write needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * A nullable text column: either a string (empty included — it is a legal column
 * value this module has no mandate to reject) or `null`.
 */
function requireNullableWriteText(
  value: unknown,
  field: string,
  operation: ProjectWriteOperation,
): string | null {
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new ProjectWriteError(
      operation,
      new Error(`project write needs a nullable string "${field}"`),
    );
  }

  return value;
}
