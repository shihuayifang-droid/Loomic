/**
 * The new-user initialisation write (workorder 44N, migration plan 25, OP-03).
 *
 * One statement: `public.bootstrap_viewer(p_user_id, p_email, p_user_meta)`. It
 * creates the profile, the personal workspace and the owner membership row, and
 * is idempotent (a second call adds nothing).
 *
 * Workorder 45CT (OP-21) put a cheap existence probe IN FRONT of it, in the same
 * transaction: an already-initialised user is answered by a read, so the write
 * (and its fsync) only happens on the visit that actually creates the
 * foundation. The statement itself is unchanged.
 *
 * It runs through the privileged
 * transaction entry point of workorder 19 with a NULL actor: the function takes
 * the user id as an argument, so the caller's identity is never read from the
 * session.
 *
 * A database error is NOT wrapped. It is thrown as it came; the viewer service
 * maps it to its one fixed 500. The transaction has rolled back by then, so a
 * failed call never leaves a half-created workspace.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type IdentityWriteRepository = {
  /** Create (or confirm) the profile, personal workspace and owner membership. Throws the database error as is. */
  bootstrapViewer(input: {
    userId: string;
    email: string | null;
    userMeta: unknown;
  }): Promise<void>;
};

const BOOTSTRAP_VIEWER_SQL =
  "select public.bootstrap_viewer($1::uuid, $2::text, $3::jsonb) as v";

/**
 * OP-21 "look before you write": the cheap existence probe that runs BEFORE the
 * initialisation statement (workorder 45CT).
 *
 * It asks the same question `private.bootstrap_user_foundation` answers by
 * writing: does this user already have the profile, the personal workspace and
 * the owner membership row? Those three tables are joined on primary keys
 * (`profiles.id`, `workspaces.owner_user_id`, `workspace_members`'s
 * `(workspace_id, user_id)` unique key), `select 1` projects nothing and
 * `limit 1` stops at the first row, so PostgreSQL can answer it from the
 * indexes alone.
 *
 * Any of the three missing -> zero rows -> the write runs and repairs the
 * partial foundation, exactly as before. All three present -> one row -> the
 * write is skipped, which is the whole point: a signed-in user's every page
 * load used to pay for a `bootstrap_viewer` (three upserts + an
 * `updated_at`), i.e. fsync and row locks, on a path that changes nothing.
 *
 * The probe and the possible write share ONE transaction (see below), so the
 * answer cannot go stale between the two: a concurrent creator is either seen
 * by the probe or serialised behind it.
 */
const EXISTING_PERSONAL_FOUNDATION_SQL = `
select 1
  from public.profiles p
  join public.workspaces w
    on w.owner_user_id = p.id
   and w.type = 'personal'
  join public.workspace_members m
    on m.workspace_id = w.id
   and m.user_id = p.id
 where p.id = $1::uuid
 limit 1
`;

export function createIdentityWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): IdentityWriteRepository {
  return {
    async bootstrapViewer(input) {
      await withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const existing = await client.query(EXISTING_PERSONAL_FOUNDATION_SQL, [
            input.userId,
          ]);

          // Already initialised: a read-only transaction that commits nothing.
          // First visit (or a partial foundation) still runs the write below.
          if (existing.rows.length > 0) return;

          await client.query(BOOTSTRAP_VIEWER_SQL, [
            input.userId,
            input.email,
            JSON.stringify(input.userMeta ?? {}),
          ]);
        },
      );
    },
  };
}
