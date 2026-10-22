/**
 * The two admin credit writes (workorder 37V, BL-12 / BL-01).
 *
 * `public.admin_adjust_topup` (37U) adds or removes top-up credits for one
 * member and writes the `admin_adjustment` ledger row that carries the
 * operator and the reason. `public.set_personal_cap` (37U) upserts one month's
 * `personal_cap` for one member and leaves `used` alone. Both are
 * service-role-only `security definer` functions, so the authorization this
 * repository relies on was decided above it, by the route.
 *
 * Two rules this module keeps, both borrowed from the pool grant write beside
 * it (`pool-grant-write-repository.ts`):
 *
 * - The writes run through the privileged transaction entry point of workorder
 *   19. Unlike the system grants they DO have an actor — the administrator that
 *   the route authenticated — so it is passed in and the three actor settings
 *   record who made the change.
 * - A driver error is re-thrown UNCHANGED, not wrapped. That is deliberate and
 *   is the difference from `PoolGrantWriteError`: SQLSTATE and the `detail`
 *   field are the contract here. `P0405` is the refusal 「最多可减 N」 and its
 *   `detail` is the number the route has to repeat to the member; `22023` is a
 *   rejected argument. Wrapping them would need a translation table that could
 *   only lose information.
 *
 * Which workspace is charged is NOT decided here: the route reads it from the
 * administrator's team membership and passes it, because the two functions take
 * it as an argument.
 */

import {
  withPrivilegedTransaction,
  type ActorContext,
  type TransactionPool,
} from "./transaction.js";

export type AdminCreditWriteRepository = {
  /** BL-12: adjust one member's top-up credits. Returns the ledger row id. */
  adjustTopup(input: {
    workspaceId: string;
    userId: string;
    operatorId: string;
    delta: number;
    reason: string;
  }): Promise<string>;
  /**
   * BL-01: set one member's monthly personal cap. Returns the stored cap.
   *
   * AD-01 / workorder 39O: `operatorId` is OPTIONAL on purpose. With it the
   * write goes through `public.admin_set_personal_cap`, which performs the same
   * change and also writes the `admin_audit_log` row naming the administrator;
   * without it the pre-39O statement runs verbatim, so every existing caller and
   * test keeps the behaviour (and the shape) it had. The routes always pass it.
   */
  setPersonalCap(input: {
    workspaceId: string;
    userId: string;
    cap: number;
    operatorId?: string;
  }): Promise<number>;
  /**
   * BL-44 / 38N: set this month's team pool limit. The change is effective
   * immediately and returns the stored limit.
   */
  setTeamPoolLimit(input: {
    workspaceId: string;
    limit: number;
    operatorId: string;
  }): Promise<number>;
  /** BL-01 / 37Y: store one template in the workspace. Returns the stored row. */
  createCapTemplate(input: {
    workspaceId: string;
    name: string;
    cap: number;
  }): Promise<AdminCreditCapTemplate>;
  /** BL-01 / 37Y: the workspace's templates, largest cap first. */
  listCapTemplates(input: {
    workspaceId: string;
  }): Promise<AdminCreditCapTemplate[]>;
  /**
   * BL-01 / 37Y: apply one template to the given members. Members whose cap was
   * set by hand are skipped inside the function, so the returned count is how
   * many were actually changed.
   */
  applyCapTemplate(input: {
    workspaceId: string;
    templateId: string;
    userIds: string[];
    /** AD-01 / 39O: same optional-operator rule as `setPersonalCap`. */
    operatorId?: string;
  }): Promise<number>;
  /**
   * AD-01 / BL-21 / 39O: pause or resume one member's generation in this
   * workspace. Returns whether the state actually changed.
   *
   * `22023` (an empty reason while pausing, a NULL `paused` flag, a NULL
   * operator) is re-thrown UNCHANGED like every other driver error here, so the
   * route can turn exactly that SQLSTATE into a 400 and nothing else.
   */
  setGenerationPaused(input: {
    workspaceId: string;
    userId: string;
    operatorId: string;
    paused: boolean;
    reason: string | null;
  }): Promise<boolean>;
};

/** One stored template, as the routes publish it. */
export type AdminCreditCapTemplate = {
  id: string;
  name: string;
  cap: number;
};

/** Fixed row-shape label: a shape failure never carries a statement or an id. */
const ADMIN_CREDIT_LABEL = "admin credit write";

/**
 * The one statement of the adjustment. Every argument is a bind parameter with
 * an explicit cast: no value a caller passes becomes SQL text, and a malformed
 * one fails as a real SQL error inside the transaction (which rolls back).
 */
const ADJUST_TOPUP_SQL = `
select public.admin_adjust_topup(
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::integer,
  $5::text
) as transaction_id
`;

/**
 * The one statement of the personal cap. The function's fourth argument is the
 * month, which defaults to the current Beijing month; leaving it out is what
 * makes this call mean "this month" without the process deciding a timezone.
 */
const SET_PERSONAL_CAP_SQL = `
select public.set_personal_cap($1::uuid, $2::uuid, $3::integer) as cap
`;

/**
 * AD-01 / 39O: the same cap change, wrapped so it also writes the audit row.
 * `p_operator_id` is NOT NULL-checked inside the function (`22023`), which is
 * why an empty operator is never bound here — it selects the older statement
 * above instead.
 */
const ADMIN_SET_PERSONAL_CAP_SQL = `
select public.admin_set_personal_cap($1::uuid, $2::uuid, $3::uuid, $4::integer) as cap
`;

/**
 * AD-01 / BL-21 / 39O: pause (`paused = true`, a non-empty reason required) or
 * resume (`paused = false`, the row is deleted) and write the audit row in the
 * same statement. `returns boolean` = did the state actually change.
 */
const SET_GENERATION_PAUSED_SQL = `
select public.set_member_generation_paused(
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::boolean,
  $5::text
) as changed
`;

/** BL-44 / 38N: the one statement of the pool limit change. */
const SET_TEAM_POOL_LIMIT_SQL = `
select public.set_team_pool_limit($1::uuid, $2::int, $3::uuid) as pool_limit
`;

/**
 * Insert one template. The unique index on (workspace_id, name) is the only
 * duplicate guard, and its `23505` is re-thrown unchanged so the route can turn
 * that one SQLSTATE into 「已有同名模板」 and nothing else.
 */
const CREATE_CAP_TEMPLATE_SQL = `
insert into public.credit_cap_templates (workspace_id, name, cap)
values ($1::uuid, $2::text, $3::integer)
returning id::text as id, name, cap
`;

/**
 * The workspace's templates. Ordered by the stored cap, largest first, then by
 * name — the order the admin surface shows, decided in one place rather than by
 * the caller.
 */
const LIST_CAP_TEMPLATES_SQL = `
select id::text as id, name, cap
from public.credit_cap_templates
where workspace_id = $1::uuid
order by cap desc, name asc
`;

/**
 * Apply one template. The function decides who is skipped (a cap set by hand is
 * never overwritten) and returns how many members it changed; a template from
 * another workspace is refused with `22023`.
 */
const APPLY_CAP_TEMPLATE_SQL = `
select public.apply_cap_template($1::uuid, $2::uuid, $3::uuid[]) as applied
`;

/** AD-01 / 39O: the same apply, wrapped so it also writes the audit row. */
const ADMIN_APPLY_CAP_TEMPLATE_SQL = `
select public.admin_apply_cap_template($1::uuid, $2::uuid, $3::uuid[], $4::uuid) as applied
`;

/**
 * Build the PostgreSQL implementation over a pool getter. Nothing here
 * connects: the getter is called per write, so a process that never adjusts
 * credits never opens a connection for this module, and a missing
 * `DATABASE_URL` surfaces on the write rather than at startup.
 */
export function createAdminCreditWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): AdminCreditWriteRepository {
  return {
    async adjustTopup(input) {
      const workspaceId = requireArgument(input.workspaceId, "workspaceId");
      const userId = requireArgument(input.userId, "userId");
      const operatorId = requireArgument(input.operatorId, "operatorId");
      const reason = requireArgument(input.reason, "reason");

      const transactionId = await withPrivilegedTransaction(
        options.getTransactionPool(),
        // The acting administrator: privileged access, but an auditable actor.
        { userId: operatorId, workspaceId, role: "admin" },
        async (client) => {
          const result = await client.query(ADJUST_TOPUP_SQL, [
            workspaceId,
            userId,
            operatorId,
            input.delta,
            reason,
          ]);

          if (result.rows.length !== 1) {
            throw new Error(
              `${ADMIN_CREDIT_LABEL} returned ${result.rows.length} rows instead of one`,
            );
          }

          return mapTransactionIdRow(result.rows[0]);
        },
      );

      // A missing id would publish "adjusted" without a row to point at.
      if (typeof transactionId !== "string" || transactionId.length === 0) {
        throw new Error(`${ADMIN_CREDIT_LABEL} returned no usable "transaction_id"`);
      }

      return transactionId;
    },

    async setPersonalCap(input) {
      const workspaceId = requireArgument(input.workspaceId, "workspaceId");
      const userId = requireArgument(input.userId, "userId");
      // AD-01 / 39O: an operator selects the auditing wrapper; its absence keeps
      // the pre-39O statement and the pre-39O transaction context, so nothing a
      // caller that never heard of 39O does can change.
      const operatorId = readOptionalOperator(input.operatorId);

      return await withPrivilegedTransaction(
        options.getTransactionPool(),
        operatorId === null ? { workspaceId } : actorContext(operatorId, workspaceId),
        async (client) => {
          const result =
            operatorId === null
              ? await client.query(SET_PERSONAL_CAP_SQL, [
                  workspaceId,
                  userId,
                  input.cap,
                ])
              : await client.query(ADMIN_SET_PERSONAL_CAP_SQL, [
                  workspaceId,
                  userId,
                  operatorId,
                  input.cap,
                ]);

          if (result.rows.length !== 1) {
            throw new Error(
              `${ADMIN_CREDIT_LABEL} returned ${result.rows.length} rows instead of one`,
            );
          }

          return mapCapRow(result.rows[0]);
        },
      );
    },

    async setGenerationPaused(input) {
      const workspaceId = requireArgument(input.workspaceId, "workspaceId");
      const userId = requireArgument(input.userId, "userId");
      const operatorId = requireArgument(input.operatorId, "operatorId");

      return await withPrivilegedTransaction(
        options.getTransactionPool(),
        actorContext(operatorId, workspaceId),
        async (client) => {
          const result = await client.query(SET_GENERATION_PAUSED_SQL, [
            workspaceId,
            userId,
            operatorId,
            input.paused,
            input.reason,
          ]);

          if (result.rows.length !== 1) {
            throw new Error(
              `${ADMIN_CREDIT_LABEL} returned ${result.rows.length} rows instead of one`,
            );
          }

          return mapChangedRow(result.rows[0]);
        },
      );
    },

    async setTeamPoolLimit(input) {
      const workspaceId = requireArgument(input.workspaceId, "workspaceId");
      const operatorId = requireArgument(input.operatorId, "operatorId");

      return await withPrivilegedTransaction(
        options.getTransactionPool(),
        { userId: operatorId, workspaceId, role: "admin" },
        async (client) => {
          const result = await client.query(SET_TEAM_POOL_LIMIT_SQL, [
            workspaceId,
            input.limit,
            operatorId,
          ]);

          if (result.rows.length !== 1) {
            throw new Error(
              `${ADMIN_CREDIT_LABEL} returned ${result.rows.length} rows instead of one`,
            );
          }

          return mapPoolLimitRow(result.rows[0]);
        },
      );
    },

    async createCapTemplate(input) {
      const workspaceId = requireArgument(input.workspaceId, "workspaceId");
      const name = requireArgument(input.name, "name");

      return await withPrivilegedTransaction(
        options.getTransactionPool(),
        { workspaceId },
        async (client) => {
          const result = await client.query(CREATE_CAP_TEMPLATE_SQL, [
            workspaceId,
            name,
            input.cap,
          ]);

          if (result.rows.length !== 1) {
            throw new Error(
              `${ADMIN_CREDIT_LABEL} returned ${result.rows.length} rows instead of one`,
            );
          }

          return mapTemplateRow(result.rows[0]);
        },
      );
    },

    async listCapTemplates(input) {
      const workspaceId = requireArgument(input.workspaceId, "workspaceId");

      return await withPrivilegedTransaction(
        options.getTransactionPool(),
        { workspaceId },
        async (client) => {
          const result = await client.query(LIST_CAP_TEMPLATES_SQL, [workspaceId]);

          return result.rows.map((row) => mapTemplateRow(row));
        },
      );
    },

    async applyCapTemplate(input) {
      const workspaceId = requireArgument(input.workspaceId, "workspaceId");
      const templateId = requireArgument(input.templateId, "templateId");
      const operatorId = readOptionalOperator(input.operatorId);

      if (!Array.isArray(input.userIds) || input.userIds.length === 0) {
        throw new Error(`${ADMIN_CREDIT_LABEL} needs at least one "userIds" member`);
      }

      return await withPrivilegedTransaction(
        options.getTransactionPool(),
        operatorId === null ? { workspaceId } : actorContext(operatorId, workspaceId),
        async (client) => {
          const result =
            operatorId === null
              ? await client.query(APPLY_CAP_TEMPLATE_SQL, [
                  workspaceId,
                  templateId,
                  [...input.userIds],
                ])
              : await client.query(ADMIN_APPLY_CAP_TEMPLATE_SQL, [
                  workspaceId,
                  templateId,
                  [...input.userIds],
                  operatorId,
                ]);

          if (result.rows.length !== 1) {
            throw new Error(
              `${ADMIN_CREDIT_LABEL} returned ${result.rows.length} rows instead of one`,
            );
          }

          return mapAppliedRow(result.rows[0]);
        },
      );
    },
  };
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction,
 * the transaction rolls back and the connection stays usable.
 */
function requireArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${ADMIN_CREDIT_LABEL} needs a non-empty "${field}"`);
  }

  return value;
}

/**
 * AD-01 / 39O: the optional operator, normalised once.
 *
 * `undefined` means "the caller has no operator" and selects the pre-39O
 * statement; a present but EMPTY operator is a programming error, not an
 * absence, so it is refused exactly like every other unusable argument rather
 * than silently falling back to the unaudited write.
 */
function readOptionalOperator(value: unknown): string | null {
  if (value === undefined) return null;

  return requireArgument(value, "operatorId");
}

/** The acting administrator: privileged access, but an auditable actor. */
function actorContext(operatorId: string, workspaceId: string): ActorContext {
  return { userId: operatorId, workspaceId, role: "admin" };
}

/**
 * `set_member_generation_paused` declares `returns boolean`, so a missing or
 * non-boolean `changed` is drift. Reporting it as `false` would say "pausing
 * changed nothing" about a call that may well have paused the member.
 */
function mapChangedRow(row: unknown): boolean {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned a row that is not an object`);
  }

  const value = (row as Readonly<Record<string, unknown>>).changed;
  if (typeof value !== "boolean") {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned no usable "changed"`);
  }

  return value;
}

/** The ledger row id: the function declares `returns uuid`. */
function mapTransactionIdRow(row: unknown): string {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned a row that is not an object`);
  }

  const value = (row as Readonly<Record<string, unknown>>).transaction_id;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned no usable "transaction_id"`);
  }

  return value;
}

/**
 * The stored cap. An ABSENT or non-numeric column is drift — the function
 * declares `returns integer` — and reporting it as 0 would say "the cap is now
 * zero" about a month nobody changed.
 */
function mapCapRow(row: unknown): number {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned a row that is not an object`);
  }

  const value = (row as Readonly<Record<string, unknown>>).cap;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned no usable "cap"`);
  }

  return Number(value);
}

/** The stored pool limit: the function declares `returns integer`. */
function mapPoolLimitRow(row: unknown): number {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned a row that is not an object`);
  }

  const value = (row as Readonly<Record<string, unknown>>).pool_limit;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned no usable "pool_limit"`);
  }

  return Number(value);
}

/**
 * One template row. Every column is checked: an id that is not a non-empty
 * string, or a cap that is not a finite number, is drift against the table's own
 * declaration, and publishing it as `""` / `0` would invent a template nobody
 * stored.
 */
function mapTemplateRow(row: unknown): AdminCreditCapTemplate {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned a row that is not an object`);
  }

  const record = row as Readonly<Record<string, unknown>>;
  const id = record.id;
  const name = record.name;
  const cap = record.cap;

  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned no usable template "id"`);
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned no usable template "name"`);
  }
  if (typeof cap !== "number" || !Number.isFinite(cap)) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned no usable template "cap"`);
  }

  return { id, name, cap: Number(cap) };
}

/**
 * `apply_cap_template` declares `returns integer`, so a missing or non-numeric
 * `applied` is drift. Reporting it as 0 would say "nobody was changed" about a
 * call that may well have changed people.
 */
function mapAppliedRow(row: unknown): number {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned a row that is not an object`);
  }

  const value = (row as Readonly<Record<string, unknown>>).applied;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${ADMIN_CREDIT_LABEL} returned no usable "applied"`);
  }

  return Number(value);
}
