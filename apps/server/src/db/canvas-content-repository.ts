/**
 * Canvas content read / conditional write as repository SQL (workorder 44T,
 * migration plan 25, canvas-version 1/4).
 *
 * `features/canvas/canvas-version.ts` used to read and write `canvases` through
 * the CALLER's user-scoped client, so the retired row-level-security policies
 * decided who could do what. The new database has no such policies, which means
 * the ACL has to live in the statement. Each statement below reproduces ONE old
 * policy verbatim:
 *
 * - READ  = `canvases_select_project_reader` = `private.can_read_project`:
 *   the project's author who is still a member of the project's workspace, OR any
 *   `admin` / `owner` of that workspace. There is deliberately NO `archived_at`
 *   filter: the policy has none, so the author of an archived project must still
 *   be able to open (and restore from) its canvas. Adding one here would turn a
 *   migration into a silent behaviour change.
 * - WRITE = `canvases_update_project_owner` = `private.can_write_project`:
 *   only the project's author who is a member of the workspace. `admin` / `owner`
 *   are NOT admitted: they may read somebody else's canvas but never overwrite
 *   it. Widening the write to match the read would let an administrator clobber a
 *   member's work.
 *
 * Answers:
 *
 * - `readCanvasRow` returns `null` both when the canvas does not exist and when
 *   the caller may not read it, exactly like "0 rows" under RLS.
 * - `writeIfUnchanged` returns `null` both when the version has moved on and when
 *   the caller may not write: a caller treats either as a conflict, as it did when
 *   RLS silently filtered the update to 0 rows.
 * - A database error is rethrown as it came; nothing here wraps or swallows it.
 *
 * Every statement runs inside `withPrivilegedTransaction`, carrying the actor.
 * `app.execution_mode` is a label and is never consulted for authorization.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type CanvasContentRow = {
  id: string;
  name: string;
  project_id: string;
  content: unknown;
  version: number;
};

export type CanvasContentRepository = {
  /** 读者可读时返回整行，不可读或不存在都返回 null（与 RLS 下 0 行一致）。 */
  readCanvasRow(input: {
    actorId: string;
    canvasId: string;
  }): Promise<CanvasContentRow | null>;
  /** 作者可写且版本仍是 expected 时写入并返回新版本；否则 null。 */
  writeIfUnchanged(input: {
    actorId: string;
    canvasId: string;
    content: unknown;
    expectedVersion: number;
  }): Promise<{ version: number } | null>;
};

/**
 * `can_read_project` expanded: `$1` is the actor, used once to require a
 * membership row in the project's workspace and once to recognise the author.
 * No `archived_at` filter, on purpose (see the header).
 */
const READ_CANVAS_ROW_SQL = `
select c.id, c.name, c.project_id, c.content, c.version
  from public.canvases c
  join public.projects p on p.id = c.project_id
  join public.workspace_members m
    on m.workspace_id = p.workspace_id
   and m.user_id = $1::uuid
 where c.id = $2::uuid
   and (p.created_by = $1::uuid or m.role in ('admin', 'owner'))
`;

/**
 * `can_write_project` expanded: the author who is a workspace member, and
 * nothing else. The version guard makes the update compare-and-set.
 */
const WRITE_IF_UNCHANGED_SQL = `
update public.canvases c
   set content = $3::jsonb,
       version = $4::int + 1
 where c.id = $2::uuid
   and c.version = $4::int
   and exists (
     select 1
       from public.projects p
       join public.workspace_members m
         on m.workspace_id = p.workspace_id
        and m.user_id = $1::uuid
      where p.id = c.project_id
        and p.created_by = $1::uuid
   )
returning c.version
`;

export function createCanvasContentRepository(options: {
  getTransactionPool: () => TransactionPool;
}): CanvasContentRepository {
  return {
    async readCanvasRow({ actorId, canvasId }) {
      const rows = await withPrivilegedTransaction(
        options.getTransactionPool(),
        { userId: actorId },
        async (client) => (await client.query(READ_CANVAS_ROW_SQL, [actorId, canvasId])).rows,
      );

      const row = rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return null;

      return {
        id: String(row["id"]),
        name: String(row["name"]),
        project_id: String(row["project_id"]),
        content: row["content"] ?? null,
        version: typeof row["version"] === "number" ? row["version"] : 0,
      };
    },

    async writeIfUnchanged({ actorId, canvasId, content, expectedVersion }) {
      const rows = await withPrivilegedTransaction(
        options.getTransactionPool(),
        { userId: actorId },
        async (client) =>
          (
            await client.query(WRITE_IF_UNCHANGED_SQL, [
              actorId,
              canvasId,
              JSON.stringify(content ?? null),
              expectedVersion,
            ])
          ).rows,
      );

      const row = rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return null;

      return { version: Number(row["version"]) };
    },
  };
}
