/**
 * Workspace settings write repository (workorder 21E1, ADR-0001 migration step 2).
 *
 * ONE PostgREST write moves here, and only this one: the single-key
 * `workspace_settings.default_model` upsert behind `PUT /api/workspace/settings`.
 * Workorder 21E0 measured what the database accepts today before anything moved,
 * and this module has to keep that whole answer — not a subset of it.
 *
 * Rules this module keeps:
 *
 * - `upsertDefaultModel` is the entire interface. There is no access token, no
 *   table name, no arbitrary column, no generic patch object and no second
 *   workspace-addressed operation, so a caller cannot widen the write: the only
 *   row this module can ever touch is `workspace_id = workspaceId`, and the only
 *   column it ever sets is `default_model`. `workspace_id` is never assigned —
 *   it is the conflict target.
 * - Every value is a bind parameter (`$1`, `$2`, `$3`), each bound with an
 *   explicit cast, so a malformed uuid fails as a real SQL error (SQLSTATE
 *   22P02) inside the transaction instead of silently matching something else.
 * - The statement runs through workorder 19's transaction entry point in
 *   `privileged` mode. The pool's role owns `workspace_settings` and bypasses
 *   RLS, which is exactly why the authorisation rule has to be the statement's
 *   OWN predicate — see the SQL below.
 * - ONE statement, so there is no read-then-write window: the membership test and
 *   the upsert are evaluated in the same snapshot by the same statement. A
 *   separate `SELECT` first (21E0 lists it as an excluded design) would let the
 *   membership disappear between the check and the write, or the row appear.
 * - Zero rows is NOT a legal answer. The upsert only produces a row when the
 *   caller is an owner/admin member of that workspace, so zero rows means
 *   "refused or nothing to write to" and the caller must not be told the write
 *   happened. It is reported through the same fixed error as a SQL failure, so
 *   the HTTP layer's single 500 projection stays honest and neither membership
 *   nor workspace existence leaks. 21E0 measured the two database-level shapes
 *   this collapses — an RLS `42501` on the conflict branch and a USING-filtered
 *   UPDATE reporting zero rows — and neither may reach a client.
 * - A connect, SQL, timeout, zero-row or row-shape failure throws
 *   `WorkspaceSettingsWriteError`, whose own message is fixed text: no SQL, no
 *   host, no connection string, no workspace id. The driver's own error rides
 *   along as `cause` so a caller can classify it without the driver's message
 *   reaching a log line or an HTTP body.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a write failure on the call, never a silent fallback:
 *   nothing in this module can reach PostgREST.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * The settings row as this module reports it: what `RETURNING` answered, and
 * nothing else. `created_at` / `updated_at` are columns this write never names,
 * and both fields below are non-null because the statement just wrote them, so
 * a NULL there is a contract violation, not a value.
 */
export type WorkspaceSettingsWriteRow = {
  workspaceId: string;
  defaultModel: string;
};

export type WorkspaceSettingsWriteRepository = {
  upsertDefaultModel(input: {
    actorId: string;
    workspaceId: string;
    defaultModel: string;
  }): Promise<WorkspaceSettingsWriteRow>;
};

export const UPSERT_DEFAULT_MODEL = "upsertDefaultModel";

export type WorkspaceSettingsWriteOperation = typeof UPSERT_DEFAULT_MODEL;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class WorkspaceSettingsWriteError extends Error {
  readonly operation: WorkspaceSettingsWriteOperation;

  constructor(operation: WorkspaceSettingsWriteOperation, cause: unknown) {
    super(
      `workspace settings write failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "WorkspaceSettingsWriteError";
    this.operation = operation;
  }
}

/**
 * The one statement this module can issue.
 *
 * The membership gate is INSIDE the statement, as the source of the row the
 * `INSERT` is allowed to write: `select $2::uuid, $3::text where exists (...)`
 * produces a row only when the actor is an owner or admin member of the target
 * workspace, so the `INSERT` is simply skipped otherwise. The predicate is the
 * one workorder 21E0 froze as the accepted set — it reads
 * `workspace_members.role`, never `workspaces.owner_user_id`, and it is exactly
 * the `INSERT`/`UPDATE` policy expression of
 * `20260323000005_workspace_settings.sql`. Personal-workspace owners, team
 * owners and team admins are therefore all still accepted; members,
 * non-members and an `owner_user_id` with no membership row are still refused.
 * A privileged connection bypasses RLS, so this predicate is the only gate
 * there is.
 *
 * `on conflict (workspace_id) do update set default_model = excluded.default_model`
 * is the production upsert shape 21E0 froze: the conflict target is the primary
 * key, `workspace_id` is never in the SET list (the row cannot be retargeted),
 * and `created_at` is untouched. Only the conflict branch loses the
 * `select ... where exists` source — a row can only be in conflict if the
 * `select` produced one, which it only does for an allowed member.
 *
 * `returning workspace_id, default_model` names the two columns the answer is
 * projected from. A zero-row result is not an error to PostgreSQL; it is this
 * module's refusal (see the header) and is raised by the caller below.
 */
const UPSERT_DEFAULT_MODEL_SQL = `
insert into public.workspace_settings (workspace_id, default_model)
select $2::uuid, $3::text
 where exists (
   select 1
     from public.workspace_members wm
    where wm.workspace_id = $2::uuid
      and wm.user_id = $1::uuid
      and wm.role in ('owner', 'admin')
 )
on conflict (workspace_id) do update
   set default_model = excluded.default_model
returning
  workspace_id, default_model
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `WorkspaceSettingsWriteError` on an actual
 * write.
 *
 * There is no fallback path. A caller that was handed this repository either
 * writes through it or fails.
 */
export function createWorkspaceSettingsWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): WorkspaceSettingsWriteRepository {
  return {
    async upsertDefaultModel(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const actorId = requireWriteArgument(input.actorId, "actorId");
      const workspaceId = requireWriteArgument(input.workspaceId, "workspaceId");
      const defaultModel = requireWriteArgument(
        input.defaultModel,
        "defaultModel",
      );

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // The transaction context carries WHO asked and WHICH workspace the
          // write was about, so the audit trail of a privileged write is not
          // anonymous. It grants nothing: the statement's own predicate above is
          // the authorisation rule.
          { userId: actorId, workspaceId },
          async (client) => {
            const result = await client.query(UPSERT_DEFAULT_MODEL_SQL, [
              actorId,
              workspaceId,
              defaultModel,
            ]);

            // `workspace_id` is the primary key, so the statement is at most one
            // row. Zero rows is the refusal described in the header: the caller
            // is not an owner/admin member of that workspace, or that workspace
            // does not exist, and either way the write did not happen. More than
            // one row is impossible for the same reason and is treated as a
            // statement/mapper disagreement rather than a value.
            if (result.rows.length !== 1) {
              throw new Error("workspace settings write updated no row");
            }

            return mapSettingsRow(result.rows[0]);
          },
        );
      } catch (error) {
        throw new WorkspaceSettingsWriteError(UPSERT_DEFAULT_MODEL, error);
      }
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
 * The model string is held to the same rule because `default_model` is NOT NULL
 * and what the rest of the system reads back. Trimming is the caller's decision
 * and is NOT repeated in this module — the route's Zod schema
 * (`workspaceSettingsUpdateRequestSchema`) already decided, and doing it twice
 * would make the stored value depend on which layer ran.
 */
function requireWriteArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceSettingsWriteError(
      UPSERT_DEFAULT_MODEL,
      new Error(`workspace settings write needs a non-empty "${field}"`),
    );
  }

  return value;
}

function mapSettingsRow(row: unknown): WorkspaceSettingsWriteRow {
  const record = asWriteRow(row);

  return {
    workspaceId: requireRowText(record, "workspace_id"),
    defaultModel: requireRowText(record, "default_model"),
  };
}

function asWriteRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "workspace settings write returned a row that is not an object",
    );
  }

  return value as Record<string, unknown>;
}

/**
 * A column this statement always writes to a non-empty value.
 *
 * An empty or missing value fails here rather than travelling on: the response
 * contract cannot describe a settings row without a model, and the shape check is
 * the one place that can still tell "the database answered something unusable"
 * from "the caller asked for it". `Object.prototype.hasOwnProperty` semantics are
 * not needed for a required column — an inherited key would still have to be a
 * non-empty string to pass — and a column dropped from `RETURNING` answers
 * `undefined`, which fails here.
 */
function requireRowText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`workspace settings write returned no usable "${field}"`);
  }

  return value;
}
