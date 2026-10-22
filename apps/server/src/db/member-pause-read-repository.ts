/**
 * Read-only member generation-pause repository (workorder 39P, AD-01 / BL-21
 * step 3).
 *
 * Workorder 39N created the state (`member_generation_pauses`) and the write
 * (`set_member_generation_paused`); this module answers the ONE question the
 * charge path has to ask before it quotes or creates anything:
 *
 *   "is this user's generation paused, in any team workspace?"
 *
 * It is deliberately a single `select exists (...)`, and it is deliberately
 * keyed by `user_id` alone: the pause is a property of the MEMBER, not of the
 * request that happens to be in flight. A member paused by the administrator of
 * their team must not be able to keep generating by submitting through a route
 * that names a different workspace (a personal workspace, or the team the charge
 * would draw from), so the caller is not asked to supply a workspace at all and
 * there is nothing it could pass to widen or narrow the answer.
 *
 * Rules this module keeps, the same ones `member-credit-read-repository.ts`
 * follows:
 *
 * - Nothing is written: the statement is a `select exists`, so a read opens a
 *   transaction, answers, and COMMITs with no row touched.
 * - `$1::uuid` is the only bind parameter, and the team predicate is SQL's
 *   (`w.type = 'team'`), not this process's: which workspaces count as teams is
 *   decided in the database, by the same rule `credit-pool-write-repository.ts`
 *   uses.
 * - The row is read by column name and a non-boolean answer is drift rather
 *   than "not paused": folding it into `false` would let a paused member
 *   generate, which is exactly what this module exists to prevent.
 * - The read runs through the privileged transaction entry point of workorder 19
 *   with a NULL actor: it is a system read whose authorization was decided
 *   above.
 * - A connect or SQL failure throws `MemberPauseReadError`, whose message is
 *   fixed text: no SQL, no host, no connection string and no id. The driver's
 *   own error rides along as `cause`. The caller must NOT treat that failure as
 *   "not paused" — see `with-billing.ts`, which lets it propagate.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export const IS_GENERATION_PAUSED = "isGenerationPaused";

export type MemberPauseReadOperation = typeof IS_GENERATION_PAUSED;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential or a user id must never reach a log line or an HTTP body through
 * us.
 */
export class MemberPauseReadError extends Error {
  readonly operation: MemberPauseReadOperation;

  constructor(operation: MemberPauseReadOperation, cause: unknown) {
    super(
      `member pause read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "MemberPauseReadError";
    this.operation = operation;
  }
}

export type MemberPauseReadRepository = {
  /** AD-01 / BL-21: whether this user's generation is paused in a team. */
  isGenerationPaused(input: { userId: string }): Promise<boolean>;
};

/** Fixed row-shape label: a refusal never carries SQL, a host or an id. */
const MEMBER_PAUSE_LABEL = "member pause read";

/**
 * The one statement.
 *
 * The join to `workspaces` is what makes the answer "paused in a TEAM": a pause
 * row written against a workspace that is not a team is not this gate's
 * business. `exists` always returns exactly one row, so an empty table is a
 * legal `false` rather than a missing row.
 */
const IS_GENERATION_PAUSED_SQL = `
select exists (
  select 1
    from public.member_generation_pauses p
    join public.workspaces w
      on w.id = p.workspace_id
   where w.type = 'team'
     and p.user_id = $1::uuid
) as paused
`;

/**
 * Build the PostgreSQL implementation over a pool GETTER. Nothing here
 * connects: the pool is the caller's, resolved per read, and a failure only
 * surfaces on an actual read, as a `MemberPauseReadError`.
 */
export function createMemberPauseReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): MemberPauseReadRepository {
  return {
    async isGenerationPaused(input) {
      // Arguments first: an unusable one must not open a connection, and it
      // must not be reported as a database failure either.
      const userId = requireReadArgument(input.userId);

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // System read on behalf of an already-authorised caller: the
          // statement's own predicate is the rule, so the context is
          // explicitly empty rather than borrowed from a caller.
          null,
          async (client) => {
            const result = await client.query(IS_GENERATION_PAUSED_SQL, [
              userId,
            ]);

            return readPausedFlag(result.rows[0]);
          },
        );
      } catch (error) {
        if (error instanceof MemberPauseReadError) throw error;
        throw new MemberPauseReadError(IS_GENERATION_PAUSED, error);
      }
    },
  };
}

/**
 * A bound id is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction,
 * the transaction rolls back and the connection stays usable.
 */
function requireReadArgument(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MemberPauseReadError(
      IS_GENERATION_PAUSED,
      new Error('member pause read needs a non-empty "userId"'),
    );
  }

  return value;
}

/**
 * `exists (...)` declares a boolean, so an ABSENT row, a missing column and a
 * value that is not a boolean are all drift rather than "not paused".
 */
function readPausedFlag(row: unknown): boolean {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${MEMBER_PAUSE_LABEL} returned a row that is not an object`);
  }

  const value = (row as Readonly<Record<string, unknown>>).paused;

  if (typeof value !== "boolean") {
    throw new Error(`${MEMBER_PAUSE_LABEL} returned no usable "paused"`);
  }

  return value;
}
