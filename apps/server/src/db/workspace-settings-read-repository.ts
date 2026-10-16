/**
 * Workspace settings read repository (workorder 21L, ADR-0001 migration step 2).
 *
 * ONE PostgREST read moves here, and only this one: the single-row
 * `workspace_settings.default_model` lookup behind `GET /api/workspace/settings`,
 * which the agent runtime (`http/runs.ts`) and the websocket handler
 * (`ws/handler.ts`) also use to pick the model an agent run starts on.
 *
 * That read used to run on the caller's own user-scoped PostgREST client, where
 * ROW LEVEL SECURITY decided which row was visible:
 *
 *   CREATE POLICY workspace_settings_select ON public.workspace_settings
 *     FOR SELECT USING (
 *       EXISTS (SELECT 1 FROM public.workspace_members wm
 *                WHERE wm.workspace_id = workspace_settings.workspace_id
 *                  AND wm.user_id = auth.uid()))
 *
 * Read access is therefore MEMBERSHIP, at any role. This repository runs
 * privileged (the pool's role bypasses RLS), so that policy is no longer the
 * gate — the statement's OWN predicate is, and it is that expression translated
 * into SQL verbatim. Two facts the translation must not lose:
 *
 * - Every member reads, whatever the role: there is NO `role in (...)` clause.
 *   The role condition belongs to the INSERT / UPDATE policies, which workorder
 *   21E1 translated for the WRITE. Neither ACL may be derived from the other.
 * - `workspaces.owner_user_id` is not a read rule. Workorder 21E0 froze that: a
 *   workspace that names the caller as its owner but has no membership row for
 *   anyone is invisible to them, and this statement reproduces that.
 *
 * `readDefaultModel` is the entire interface. There is no access token, no table
 * name, no column list and no second workspace-addressed read, so a caller
 * cannot widen it: the only row it can ever answer with is
 * `workspace_id = $2::uuid`, and the only column it reads is `default_model`.
 *
 * Zero rows is a LEGAL answer, and it is the same answer for two situations this
 * module deliberately cannot tell apart — the caller is not a member of that
 * workspace, or that workspace has no settings row. The read it replaces had the
 * same shape: RLS filtered a non-member's row away, `maybeSingle()` answered
 * `null`, and the caller fell back to its default model. So this is NOT an error
 * and NOT a 403. A non-member must keep being served the default model, because
 * `/api/agent/runs` and the websocket handler start agent runs through this read.
 *
 * More than one row is impossible (`workspace_id` is the primary key) and is
 * reported as a fixed failure rather than as a first row. Every failure — a
 * connect, SQL, timeout or row-shape failure — throws
 * `WorkspaceSettingsReadError`, whose own message is fixed text: no SQL, no
 * host, no connection string, no workspace id. The driver's own error rides
 * along as `cause` so a caller can classify it without the driver's message
 * reaching a log line or an HTTP body.
 *
 * The pool is reached through a getter, so importing or wiring this module never
 * reads `DATABASE_URL`, never connects and never fails at build time. A missing
 * pool is a read failure on the call, never a silent fallback: nothing in this
 * module can reach PostgREST.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type WorkspaceSettingsReadRepository = {
  /**
   * The stored model of `workspaceId` as `actorId` is allowed to see it, or
   * `null` when there is nothing they may see — see the header: "not a member"
   * and "no settings row" are the same answer on purpose.
   */
  readDefaultModel(input: {
    actorId: string;
    workspaceId: string;
  }): Promise<string | null>;
};

export const READ_DEFAULT_MODEL = "readDefaultModel";

export type WorkspaceSettingsReadOperation = typeof READ_DEFAULT_MODEL;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class WorkspaceSettingsReadError extends Error {
  readonly operation: WorkspaceSettingsReadOperation;

  constructor(operation: WorkspaceSettingsReadOperation, cause: unknown) {
    super(
      `workspace settings read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "WorkspaceSettingsReadError";
    this.operation = operation;
  }
}

/**
 * The one statement this module can issue.
 *
 * The `exists` clause is the SELECT policy above, translated literally: the row
 * is answered only when a `workspace_members` row ties the caller to the row's
 * own workspace. It is deliberately the READ half of the ACL — no role filter,
 * which is what the policy says — and it reads `workspace_members`, never
 * `workspaces.owner_user_id`.
 *
 * `s.workspace_id = $2::uuid` is the primary key, so the statement is at most
 * one row. Both ids are bind parameters with an explicit `::uuid` cast, so a
 * malformed id fails as a real SQL error (SQLSTATE 22P02) inside the transaction
 * instead of silently matching something else.
 *
 * A privileged connection bypasses RLS, so this predicate is the only gate there
 * is; that is exactly why it has to be written out here rather than inherited
 * from a policy that no longer runs.
 */
const READ_DEFAULT_MODEL_SQL = `
select s.default_model
  from public.workspace_settings s
 where s.workspace_id = $2::uuid
   and exists (
     select 1
       from public.workspace_members wm
      where wm.workspace_id = s.workspace_id
        and wm.user_id = $1::uuid
   )
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `WorkspaceSettingsReadError` on an actual
 * read.
 *
 * There is no fallback path. A caller that was handed this repository either
 * reads through it or fails.
 */
export function createWorkspaceSettingsReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): WorkspaceSettingsReadRepository {
  return {
    async readDefaultModel(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const actorId = requireReadArgument(input.actorId, "actorId");
      const workspaceId = requireReadArgument(input.workspaceId, "workspaceId");

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // The transaction context carries WHO asked and WHICH workspace the
          // read was about, so a privileged read is not anonymous in a log or an
          // audit trail. It grants nothing: the statement's own predicate above
          // is the authorisation rule.
          { userId: actorId, workspaceId },
          async (client) => {
            const result = await client.query(READ_DEFAULT_MODEL_SQL, [
              actorId,
              workspaceId,
            ]);

            // Zero rows: no member row for this actor in that workspace, or no
            // settings row in it. Both are `null` — see the header.
            if (result.rows.length === 0) return null;

            // `workspace_id` is the primary key, so a second row is impossible
            // and is treated as a statement/mapper disagreement rather than a
            // value to choose from.
            if (result.rows.length > 1) {
              throw new Error("workspace settings read returned more than one row");
            }

            return mapDefaultModel(result.rows[0]);
          },
        );
      } catch (error) {
        throw new WorkspaceSettingsReadError(READ_DEFAULT_MODEL, error);
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
 */
function requireReadArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceSettingsReadError(
      READ_DEFAULT_MODEL,
      new Error(`workspace settings read needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * `default_model` is `text NOT NULL` (migration 20260323000005), so the column
 * always answers a string. A number, a boolean, a NULL or a column dropped from
 * the statement is drift and fails here rather than travelling on as a model id
 * the rest of the system would try to run.
 *
 * An EMPTY string is a string and is returned unchanged. The read this replaces
 * projected `data?.default_model ?? fallback`, and `??` only replaces
 * null/undefined — so an empty stored value used to be published as `""` and
 * still is. Tightening that here would be a silent behaviour change this
 * workorder does not own.
 */
function mapDefaultModel(row: unknown): string {
  const record = asReadRow(row);
  const value = record["default_model"];

  if (typeof value !== "string") {
    throw new Error('workspace settings read returned no usable "default_model"');
  }

  return value;
}

function asReadRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workspace settings read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}
