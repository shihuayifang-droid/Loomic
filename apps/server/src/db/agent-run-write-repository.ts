/**
 * Agent run metadata write repository (workorder 21G, ADR-0001 migration step 2).
 *
 * TWO server-only PostgREST writes move here, and only these two: the
 * `agent_runs` INSERT behind `AgentRunMetadataService.createAcceptedRun` and the
 * `agent_runs` UPDATE behind `AgentRunMetadataService.updateRun`. Both ran on the
 * service-role admin client, both are bookkeeping for a LangGraph run rather than
 * a user's own content, and no other table and no other statement is reachable
 * from this module.
 *
 * Rules this module keeps:
 *
 * - `createAcceptedRun` and `updateRun` are the entire interface. There is no
 *   access token, no actor, no workspace id, no table name and no generic patch
 *   object, so a caller cannot widen the write: the insert can only ever produce
 *   one `public.agent_runs` row carrying the caller's id and
 *   `status = 'accepted'`, and the update can only ever name `status` plus the
 *   three optional columns of `OPTIONAL_UPDATE_COLUMNS` below, on the single row
 *   `id = runId`.
 * - Every value is a bind parameter (`$n`), each bound with an explicit cast, so
 *   a malformed uuid fails as a real SQL error (SQLSTATE 22P02) inside the
 *   transaction instead of silently matching something else. The ONLY statement
 *   text this module builds is the UPDATE's assignment list, and both the column
 *   names and the casts in it come from the fixed table
 *   `OPTIONAL_UPDATE_COLUMNS` — never from a caller's value. A value carrying SQL
 *   can therefore only ever be a (malformed) bind.
 * - Both statements run through workorder 19's transaction entry point in
 *   `privileged` mode with a NULL actor. These rows record a run, not a person
 *   acting on it, and the actor settings this writes are transaction-local; the
 *   `privileged` mode is a diagnostic label, never a grant. The pool's role owns
 *   `agent_runs` and bypasses RLS, so each statement's OWN predicate is the only
 *   thing selecting a row.
 * - The accepted insert carries NO conflict clause and NO generated id. The id is
 *   the CALLER's, so a replayed insert — the service retries a lost response, see
 *   its use of `withTransportRetry` — that finds the row already present must fail
 *   with a real primary-key error (SQLSTATE 23505) instead of reporting success a
 *   second time. `on conflict do nothing` would erase exactly the signal the
 *   replay is there to produce, so it is deliberately absent: a duplicate runId is
 *   a real error, not a no-op.
 * - The update carries NO status predicate and no transition rule. `where` names
 *   `id` alone, so a run that is already terminal can still be moved and a run
 *   that never existed matches nothing; narrowing the row set (`and status in
 *   (...)`) would be a behaviour change smuggled in under a migration, because
 *   the superseded statement had no such rule and the caller owns the state
 *   machine.
 * - Zero rows means two DIFFERENT things here, and each keeps the answer the
 *   superseded statement gave:
 *     updateRun          zero rows is a LEGAL answer. The replaced PostgREST chain
 *                        selected nothing back, so "nothing matched" and "one row
 *                        matched" were indistinguishable to the caller and both
 *                        resolved. This module still resolves, and the transaction
 *                        still COMMITs. Turning it into a failure would be a new
 *                        refusal the caller never had.
 *     createAcceptedRun  zero rows is IMPOSSIBLE for a successful INSERT ...
 *                        RETURNING, so it is treated as a statement/mapper
 *                        disagreement (the row shape below) rather than as a
 *                        value, and no caller is told the run was accepted.
 * - A connect, SQL, row-shape or argument failure throws `AgentRunWriteError`,
 *   whose own message is fixed text: no SQL, no host, no connection string, no
 *   run id. The driver's own error rides along as `cause` so a caller can classify
 *   it — `isTransportFailure` reads that cause — without the driver's message
 *   reaching a log line or an HTTP body.
 * - The pool is reached through a getter, so importing or wiring this module never
 *   reads `DATABASE_URL`, never connects and never fails at build time. A missing
 *   pool is a write failure on the call, never a silent fallback: nothing in this
 *   module can reach PostgREST.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * The four states the `agent_runs.status` CHECK constraint accepts. It is
 * mirrored here as a TYPE, not as a rule this module enforces: the union keeps a
 * typed caller honest, and the database CHECK stays the only authority on which
 * values are legal (a caller that bypasses the type is rejected by PostgreSQL
 * with SQLSTATE 23514, exactly as before this migration).
 */
export type AgentRunWriteStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed";

/**
 * The accepted-run row as the caller describes it. `runId` is supplied by the
 * caller on purpose: it is the primary key, which is what makes the service's
 * replay of a lost response land on that key instead of creating a second run.
 * `model` is the only nullable field — `agent_runs.model` has no NOT NULL.
 */
export type CreateAcceptedAgentRunWriteInput = {
  model?: string | null;
  runId: string;
  sessionId: string;
  threadId: string;
};

/**
 * The update as the caller describes it. The three optional fields are omitted
 * (or empty) when the caller has nothing to say about them, which is the rule the
 * superseded patch object expressed with a truthiness spread — see
 * `buildUpdateRunStatement`, which keeps it.
 */
export type UpdateAgentRunWriteInput = {
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  runId: string;
  status: AgentRunWriteStatus;
};

export type AgentRunWriteRepository = {
  /**
   * Write the `accepted` row for a run. A duplicate `runId` is a real error, not
   * a silent no-op.
   */
  createAcceptedRun(input: CreateAcceptedAgentRunWriteInput): Promise<void>;

  /**
   * Move a run's `status` and whichever optional metadata the caller supplied.
   * An unknown `runId` updates zero rows and still resolves.
   */
  updateRun(input: UpdateAgentRunWriteInput): Promise<void>;
};

export const CREATE_ACCEPTED_RUN = "createAcceptedRun";
export const UPDATE_RUN = "updateRun";

export type AgentRunWriteOperation =
  | typeof CREATE_ACCEPTED_RUN
  | typeof UPDATE_RUN;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class AgentRunWriteError extends Error {
  readonly operation: AgentRunWriteOperation;

  constructor(operation: AgentRunWriteOperation, cause: unknown) {
    super(
      `agent run write failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "AgentRunWriteError";
    this.operation = operation;
  }
}

/**
 * The accepted insert, and the whole of it.
 *
 * The five column names are literally the five keys of the superseded insert
 * object (`id, model, session_id, status, thread_id`), and `'accepted'` is the
 * literal that object carried — not a bind, so no caller can steer this statement
 * to another status. `created_at` is not named: it keeps its `now()` default.
 *
 * There is deliberately no `on conflict`: see the header. `returning id` names the
 * one column whose presence proves a row was written; a zero-row answer is
 * impossible for this statement and is raised below as a disagreement rather than
 * folded into a success.
 */
const INSERT_ACCEPTED_RUN_SQL = `
insert into public.agent_runs (id, model, session_id, status, thread_id)
values ($1::uuid, $2::text, $3::uuid, 'accepted'::text, $4::text)
returning id
`;

/**
 * The optional columns the update may name, in the order the superseded patch
 * object built them (`completed_at`, `error_code`, `error_message`).
 *
 * Each entry pairs the caller-visible field with the column it may write and the
 * cast its bind parameter carries. This table is the ONLY source of a column name
 * in the generated assignment list, which is what keeps the construction below
 * out of the caller's reach: an input value can be a bind, never a column.
 *
 * `status` is not in this table because it is never optional — the superseded
 * patch always set it.
 */
const OPTIONAL_UPDATE_COLUMNS: ReadonlyArray<{
  field: "completedAt" | "errorCode" | "errorMessage";
  column: string;
  cast: string;
}> = [
  { field: "completedAt", column: "completed_at", cast: "timestamptz" },
  { field: "errorCode", column: "error_code", cast: "text" },
  { field: "errorMessage", column: "error_message", cast: "text" },
];

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as an `AgentRunWriteError` on an actual write.
 *
 * There is no fallback path. A caller that was handed this repository either
 * writes through it or fails.
 */
export function createAgentRunWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): AgentRunWriteRepository {
  return {
    async createAcceptedRun(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const runId = requireWriteArgument(
        input.runId,
        "runId",
        CREATE_ACCEPTED_RUN,
      );
      const sessionId = requireWriteArgument(
        input.sessionId,
        "sessionId",
        CREATE_ACCEPTED_RUN,
      );
      const threadId = requireWriteArgument(
        input.threadId,
        "threadId",
        CREATE_ACCEPTED_RUN,
      );
      // The ONLY field that may be absent: `model` has no NOT NULL, and the
      // superseded insert sent `?? null`, so an absent model stores NULL while an
      // empty string stays an empty string.
      const model = nullableWriteArgument(
        input.model,
        "model",
        CREATE_ACCEPTED_RUN,
      );

      try {
        const pool = options.getTransactionPool();

        await withPrivilegedTransaction(
          pool,
          // System bookkeeping for a run: the row records the run, not a person
          // acting on it, so the context is explicitly empty rather than borrowed
          // from a caller. It grants nothing — the statement's own columns are
          // the rule.
          null,
          async (client) => {
            const result = await client.query(INSERT_ACCEPTED_RUN_SQL, [
              runId,
              model,
              sessionId,
              threadId,
            ]);

            // A successful INSERT ... RETURNING answers exactly one row, so
            // anything else is a statement/mapper disagreement rather than a
            // value, and the run must not be reported as accepted. A duplicate id
            // never reaches this line: PostgreSQL rejects the statement itself
            // (SQLSTATE 23505) and the transaction rolls back.
            if (result.rows.length !== 1) {
              throw new Error("agent run write inserted no row");
            }
          },
        );
      } catch (error) {
        throw new AgentRunWriteError(CREATE_ACCEPTED_RUN, error);
      }
    },

    async updateRun(input) {
      // Arguments first, as above. The statement is built here as well, so an
      // unusable status or optional field is refused before a connection is
      // opened.
      const statement = buildUpdateRunStatement(input);

      try {
        const pool = options.getTransactionPool();

        await withPrivilegedTransaction(pool, null, async (client) => {
          // Zero rows is a LEGAL answer and is not inspected: the replaced
          // PostgREST chain asked for no row back, so "nothing matched" and "one
          // row matched" reached the caller as the same resolved promise, and
          // narrowing that here would be a new refusal. The transaction COMMITs
          // either way.
          await client.query(statement.sql, statement.params);
        });
      } catch (error) {
        throw new AgentRunWriteError(UPDATE_RUN, error);
      }
    },
  };
}

/**
 * The update statement, built from the input's own fields.
 *
 * The assignment list is the superseded patch object, one column per key:
 * `status` is always assigned, and each optional column is assigned only when the
 * caller supplied a usable value for it. A column that is not named cannot be
 * cleared — that is the whole point, and it is why an absent field is NOT sent as
 * a bind of `null` (which would wipe the column).
 *
 * `where id = $1::uuid` is the ONLY predicate: `$1` is always the run id, so the
 * parameter numbering of the assignments starts at `$2` however many of them
 * there are. There is no status predicate, no workspace predicate and no second
 * statement.
 */
function buildUpdateRunStatement(input: UpdateAgentRunWriteInput): {
  sql: string;
  params: unknown[];
} {
  const runId = requireWriteArgument(input.runId, "runId", UPDATE_RUN);
  const status = requireWriteArgument(input.status, "status", UPDATE_RUN);

  const params: unknown[] = [runId, status];
  const assignments: string[] = [`status = $2::text`];

  for (const entry of OPTIONAL_UPDATE_COLUMNS) {
    const value = optionalWriteArgument(input[entry.field], entry.field);

    if (value === null) continue;

    params.push(value);
    assignments.push(`${entry.column} = $${params.length}::${entry.cast}`);
  }

  const sql = [
    "update public.agent_runs",
    `   set ${assignments.join(",\n       ")}`,
    " where id = $1::uuid",
    "",
  ].join("\n");

  return { sql, params };
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable. Pre-validating it here
 * would hide that path instead of exercising it.
 *
 * The status is held to the same rule and to nothing more: this module does NOT
 * check it against the four legal states. The database CHECK is that rule, and
 * enforcing it here would mean an illegal status never reached PostgreSQL — the
 * one place the constraint can still be observed working.
 */
function requireWriteArgument(
  value: unknown,
  field: string,
  operation: AgentRunWriteOperation,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentRunWriteError(
      operation,
      new Error(`agent run write needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * A nullable column: absent and NULL mean the same thing, an empty string does
 * not.
 *
 * `agent_runs.model` is the only field this module writes that may be NULL, and
 * the superseded insert used `input.model ?? null`, so `undefined`/`null` store
 * NULL while `''` is stored as an empty string. Anything that is neither — a
 * number, an object — is refused instead of being handed to the driver, which
 * would only turn it into a type error further from its cause.
 */
function nullableWriteArgument(
  value: unknown,
  field: string,
  operation: AgentRunWriteOperation,
): string | null {
  if (value === undefined || value === null) return null;

  if (typeof value !== "string") {
    throw new AgentRunWriteError(
      operation,
      new Error(`agent run write needs a string or null "${field}"`),
    );
  }

  return value;
}

/**
 * The optional-field rule of the superseded patch object, kept exactly.
 *
 * That object spread a key in only when its value was truthy
 * (`...(input.errorCode ? { error_code: input.errorCode } : {})`), so for the
 * declared string fields the only two ways to say nothing were "absent" and "the
 * empty string" — and both meant "leave the column alone". That is what `null`
 * answers here, and the builder skips the column entirely.
 *
 * A NON-string is refused rather than treated as "says nothing": a number or an
 * object in one of these fields is a caller contract violation, and binding it
 * would push the failure into the driver, further from its cause.
 */
function optionalWriteArgument(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value !== "string") {
    throw new AgentRunWriteError(
      UPDATE_RUN,
      new Error(`agent run write needs a string "${field}"`),
    );
  }

  return value;
}
