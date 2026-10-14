/**
 * PostgreSQL transaction + session-context foundation (ADR-0001, step 1).
 *
 * Every transaction is opened through `withTransaction`, which
 *
 * 1. takes one client from the pool,
 * 2. runs `BEGIN`,
 * 3. sets the HaHart session context as transaction-local settings
 *    (`set_config(name, value, true)`), parameterised — values are never
 *    concatenated into SQL,
 * 4. runs the caller's callback, and
 * 5. runs `COMMIT`.
 *
 * Failures always run `ROLLBACK` and re-throw the ORIGINAL error, so callers
 * keep the error they can actually attribute. The client is always released.
 *
 * This module deliberately does not import `pg`: it works against the minimal
 * structural pool type below, which keeps it unit testable without a database.
 * `src/db/pool.ts` provides the bridge to a real `pg.Pool`.
 */

/**
 * Session settings written on every transaction. The names are the database
 * side of the identity contract and must not change shape per call site.
 */
export const TRANSACTION_SETTING_NAMES = {
  userId: "app.user_id",
  workspaceId: "app.workspace_id",
  role: "app.role",
  privileged: "app.privileged",
} as const;

export type TransactionSettingName =
  (typeof TRANSACTION_SETTING_NAMES)[keyof typeof TRANSACTION_SETTING_NAMES];

/**
 * Ordered context tuple. Order is part of the contract: index 0 userId,
 * 1 workspaceId, 2 role, 3 privileged.
 */
export const TRANSACTION_SETTING_ORDER: readonly TransactionSettingName[] = [
  TRANSACTION_SETTING_NAMES.userId,
  TRANSACTION_SETTING_NAMES.workspaceId,
  TRANSACTION_SETTING_NAMES.role,
  TRANSACTION_SETTING_NAMES.privileged,
];

export const TRANSACTION_STATEMENTS = {
  begin: "BEGIN",
  commit: "COMMIT",
  rollback: "ROLLBACK",
  setLocalSetting: "select set_config($1, $2, true)",
} as const;

/**
 * Actor fields are explicitly nullable. `null` and `undefined` both normalise
 * to the empty string: every transaction writes the same four settings with a
 * text value, and no field is ever sent as SQL NULL.
 */
export type ActorContext = {
  userId?: string | null;
  workspaceId?: string | null;
  role?: string | null;
};

/**
 * Privileged access is an explicit mode, never implied by an empty userId.
 * A caller that wants database-level privileged access must say so.
 */
export type TransactionMode = "user" | "privileged";

export type TransactionConnection = {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[] }>;
  release(err?: Error | boolean): void;
};

export type TransactionPool = {
  connect(): Promise<TransactionConnection>;
};

export type TransactionOptions = {
  mode?: TransactionMode;
};

const PRIVILEGED_SETTING_VALUE = "on";
const USER_SETTING_VALUE = "off";

export async function withTransaction<T>(
  pool: TransactionPool,
  actor: ActorContext | null,
  run: (client: TransactionConnection) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const mode = options.mode ?? "user";
  const context = buildContextValues(actor, mode);

  // No client, nothing to release: a connect failure propagates untouched.
  const client = await pool.connect();

  let beginIssued = false;
  let destroyClient = false;

  try {
    await client.query(TRANSACTION_STATEMENTS.begin);
    beginIssued = true;

    for (const [index, name] of TRANSACTION_SETTING_ORDER.entries()) {
      await client.query(TRANSACTION_STATEMENTS.setLocalSetting, [
        name,
        context[index] ?? "",
      ]);
    }

    const result = await run(client);
    await client.query(TRANSACTION_STATEMENTS.commit);
    return result;
  } catch (error) {
    if (!beginIssued) {
      // BEGIN never succeeded: connection state is unknown, destroy it.
      destroyClient = true;
    } else {
      try {
        await client.query(TRANSACTION_STATEMENTS.rollback);
      } catch (rollbackError) {
        // The original error keeps priority; the rollback failure rides along
        // as a diagnostic and the connection is destroyed rather than reused.
        destroyClient = true;
        attachRollbackError(error, rollbackError);
      }
    }

    throw error;
  } finally {
    client.release(destroyClient ? true : undefined);
  }
}

/**
 * Explicit privileged entry point. Equivalent to
 * `withTransaction(pool, null, run, { mode: "privileged" })` and provided so
 * privileged work never has to be expressed by omitting an actor.
 */
export async function withPrivilegedTransaction<T>(
  pool: TransactionPool,
  run: (client: TransactionConnection) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return withTransaction(pool, null, run, {
    ...options,
    mode: "privileged",
  });
}

export function buildContextValues(
  actor: ActorContext | null | undefined,
  mode: TransactionMode = "user",
): readonly [string, string, string, string] {
  if (mode === "privileged" && hasActorIdentity(actor)) {
    throw new Error(
      "Privileged transaction mode cannot carry an actor identity " +
        "(userId/workspaceId/role must be empty). Pass an explicit actor with " +
        "mode \"user\" instead.",
    );
  }

  return [
    normalizeActorValue(actor?.userId),
    normalizeActorValue(actor?.workspaceId),
    normalizeActorValue(actor?.role),
    mode === "privileged" ? PRIVILEGED_SETTING_VALUE : USER_SETTING_VALUE,
  ];
}

function normalizeActorValue(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value;
}

function hasActorIdentity(actor: ActorContext | null | undefined): boolean {
  if (!actor) return false;

  return [actor.userId, actor.workspaceId, actor.role].some(
    (value) => typeof value === "string" && value.trim() !== "",
  );
}

function attachRollbackError(error: unknown, rollbackError: unknown): void {
  if (typeof error !== "object" || error === null) return;

  try {
    Object.defineProperty(error, "rollbackError", {
      value: rollbackError,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen error objects are not worth masking the original failure for.
  }
}
