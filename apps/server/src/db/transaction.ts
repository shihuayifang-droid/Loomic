/**
 * PostgreSQL transaction + session-context foundation (ADR-0001, step 1).
 *
 * Every transaction is opened through `withTransaction`, which
 *
 * 1. takes one client from the pool,
 * 2. runs `BEGIN`,
 * 3. sets the HaHart session context as transaction-local settings
 *    (`set_config(name, value, true)`), parameterised — values are never
 *    concatenated into SQL. Three of them are the actor; the fourth
 *    (`app.execution_mode`) is a diagnostic label that grants nothing,
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
 *
 * `app.execution_mode` is a DIAGNOSTIC label only ("user" or "privileged"). It
 * records how the transaction was opened so logs and audit trails can tell the
 * two apart. It is NOT an authorization switch: no RLS policy and no
 * authorization function may grant access because this setting says
 * "privileged". Real database privileges are expressed by the dedicated
 * database role / connection a later ticket introduces, never by a GUC value a
 * caller can set.
 */
export const TRANSACTION_SETTING_NAMES = {
  userId: "app.user_id",
  workspaceId: "app.workspace_id",
  role: "app.role",
  executionMode: "app.execution_mode",
} as const;

export type TransactionSettingName =
  (typeof TRANSACTION_SETTING_NAMES)[keyof typeof TRANSACTION_SETTING_NAMES];

/**
 * Ordered context tuple. Order is part of the contract: index 0 userId,
 * 1 workspaceId, 2 role, 3 executionMode.
 */
export const TRANSACTION_SETTING_ORDER: readonly TransactionSettingName[] = [
  TRANSACTION_SETTING_NAMES.userId,
  TRANSACTION_SETTING_NAMES.workspaceId,
  TRANSACTION_SETTING_NAMES.role,
  TRANSACTION_SETTING_NAMES.executionMode,
];

export const TRANSACTION_STATEMENTS = {
  begin: "BEGIN",
  commit: "COMMIT",
  rollback: "ROLLBACK",
  /**
   * All four settings in ONE statement. The settings themselves are unchanged —
   * each is still `set_config(name, value, true)`, i.e. transaction-local, and
   * every name and value stays a bind parameter.
   *
   * Why: each statement is a full network round trip, so the previous
   * one-setting-per-statement form cost four of them. Against a database that is
   * a few hundred milliseconds away (the Supabase pooler here is ~252 ms per
   * statement) those three extra round trips made every repository read ~765 ms
   * slower than it needed to be, and a page load issues several.
   */
  setLocalSetting: [
    "select",
    "  set_config($1, $2, true),",
    "  set_config($3, $4, true),",
    "  set_config($5, $6, true),",
    "  set_config($7, $8, true)",
  ].join("\n"),
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
 * A caller that wants privileged database access must say so.
 *
 * The mode is carried into the transaction as the diagnostic
 * `app.execution_mode` setting. It does not by itself grant anything, and it is
 * orthogonal to the actor: an administrator acting through a privileged
 * connection still reports userId/workspaceId/role so the operation stays
 * auditable, while a system task runs privileged with a null actor.
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

/** Diagnostic labels for `app.execution_mode`; never an authorization token. */
const EXECUTION_MODE_SETTING_VALUES: Record<TransactionMode, string> = {
  user: "user",
  privileged: "privileged",
};

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

    // One statement, not four: see TRANSACTION_STATEMENTS.setLocalSetting.
    // The parameter list is [name, value] repeated in TRANSACTION_SETTING_ORDER,
    // so the tuple below is the single source of both the names and the order.
    const settingParams = TRANSACTION_SETTING_ORDER.flatMap((name, index) => [
      name,
      context[index] ?? "",
    ]);
    await client.query(TRANSACTION_STATEMENTS.setLocalSetting, settingParams);

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
 * `withTransaction(pool, actor, run, { mode: "privileged" })` and provided so
 * privileged work never has to be expressed by omitting an actor.
 *
 * Privileged work is not anonymous work: pass the acting administrator so the
 * three actor settings are still written, or `null` for a system task that
 * genuinely has no actor.
 */
export async function withPrivilegedTransaction<T>(
  pool: TransactionPool,
  actor: ActorContext | null,
  run: (client: TransactionConnection) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return withTransaction(pool, actor, run, {
    ...options,
    mode: "privileged",
  });
}

/**
 * Build the four settings in `TRANSACTION_SETTING_ORDER`. The actor fields are
 * written in both modes; only the diagnostic execution mode differs, and it is
 * always explicit (`mode` defaults to the non-privileged "user").
 */
export function buildContextValues(
  actor: ActorContext | null | undefined,
  mode: TransactionMode = "user",
): readonly [string, string, string, string] {
  return [
    normalizeActorValue(actor?.userId),
    normalizeActorValue(actor?.workspaceId),
    normalizeActorValue(actor?.role),
    EXECUTION_MODE_SETTING_VALUES[mode],
  ];
}

function normalizeActorValue(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value;
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
