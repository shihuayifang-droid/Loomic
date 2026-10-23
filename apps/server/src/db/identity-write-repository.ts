/**
 * The new-user initialisation write (workorder 44N, migration plan 25, OP-03).
 *
 * One statement: `public.bootstrap_viewer(p_user_id, p_email, p_user_meta)`. It
 * creates the profile, the personal workspace and the owner membership row, and
 * is idempotent (a second call adds nothing). It runs through the privileged
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

export function createIdentityWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): IdentityWriteRepository {
  return {
    async bootstrapViewer(input) {
      await withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
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
