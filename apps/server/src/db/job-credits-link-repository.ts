/**
 * Job credits link repository (workorder 21H2, ADR-0001 migration step 2).
 *
 * `withBilling` charges the workspace and then records WHICH transaction paid
 * for WHICH job. Those are two statements, and the second one can fail on its
 * own: the deduction is committed, the link is not, and the job keeps
 * `credits_cost IS NULL`. In that state the worker's billing gate defers the
 * job for ten minutes (workorder 21H1) and then fails it as
 * `billing_not_confirmed` — while `refundJob` can never give the money back,
 * because it only refunds a job that was billed. The charge would simply be
 * stranded (21H0 H13).
 *
 * This module is the write half of that gap. Three narrow statements, each of
 * which is the whole rule for one step of "claim it, refund it once, mark it":
 *
 * - `linkCredits` — the migrated `setCreditsInfo`. It writes the cost and the
 *   transaction onto the job, and it CHECKS the result: the caller learns
 *   whether the row was actually claimed instead of assuming it was.
 * - `claimUnlinkedCharge` — take ownership of a job whose charge never landed.
 *   This is the refund's authority: without it, two deliveries of the same
 *   charge (or a compensation pass racing the worker) could both refund, and
 *   `refund_credits` does NOT de-duplicate by job id (T-40).
 * - `markChargeRefunded` — record that the money went back, so a later
 *   compensation pass stops seeing the job as owing anything.
 *
 * Rules this module keeps:
 *
 * - Exactly three methods. There is no access token, no workspace id, no table
 *   name and no generic patch object, so a caller cannot widen any of them: the
 *   only row any statement can reach is `id = $1::uuid`.
 * - Every value is a bind parameter with an explicit cast, so a malformed job
 *   id fails as a real SQL error (SQLSTATE 22P02) inside the transaction
 *   instead of silently matching something else. The only literals in the
 *   statements are compile-time constants of this file (the two `error_code`
 *   values and their fixed messages), never a caller value.
 * - All three statements run through workorder 19's transaction entry point in
 *   `privileged` mode with a NULL actor. This is the server's own billing
 *   bookkeeping: there is no user behind it, and forging one would put a
 *   person's id on a row they had nothing to do with.
 * - Zero rows is a LEGAL answer for all three and is reported as `false`. It
 *   means the predicate did not match: the job was already billed, already
 *   claimed, already refunded, is in a state the step does not own, or does not
 *   exist. Folding that into an error would turn a normal race (the link landed
 *   while the compensation was deciding) into a failed request. The transaction
 *   still COMMITs.
 * - The predicates carry the atomicity, not a check in JavaScript:
 *   * `linkCredits` only matches `status in ('queued','retrying') AND
 *     credits_cost IS NULL`. The second half is what makes it exclusive with
 *     the worker's 21H1 timeout claim (`failUnbilledIfOverdue`, which matches
 *     exactly the same pair): whichever statement runs first, the other one
 *     answers zero rows. The first half is what keeps the money off a job that
 *     was already failed as `billing_not_confirmed`, where nobody would refund
 *     it. And it makes a repeated delivery idempotent — the second write cannot
 *     move a cost that is already recorded.
 *   * `claimUnlinkedCharge` flips `status` to `failed` with a CASE, never
 *     unconditionally: a `canceled` job must keep saying `canceled` (the user's
 *     own action is not rewritten by a compensation pass), and a terminal row
 *     keeps the status it already has. Only the two not-yet-started states are
 *     moved. `failed_at` follows the same CASE, so a terminal row's own
 *     timestamp is not replaced by this one.
 *   * `markChargeRefunded` only matches `error_code = 'credits_refund_pending'`
 *     and `credits_cost IS NULL`, so it can only ever confirm the state the
 *     claim wrote.
 * - A connect, SQL or row-shape failure throws `JobCreditsLinkError`, whose own
 *   message is fixed text built from the operation name: no SQL, no host, no
 *   connection string, no job id. The driver's own error rides along as `cause`
 *   so a caller can classify it without the driver's message reaching a log
 *   line or an HTTP body.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a failure on the call, never a silent fallback: nothing in
 *   this module can reach PostgREST.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * The `error_code` values this module writes. They are constants of this file,
 * which is what lets the statements hold them as SQL literals without ever
 * carrying a caller value into statement text. Exported because they are part
 * of the contract the compensation path reads back.
 */
export const CREDITS_REFUND_PENDING_ERROR_CODE = "credits_refund_pending";

export const CREDITS_REFUND_PENDING_MESSAGE =
  "Credits were charged but could not be linked to this job; a refund is pending";

export const CREDITS_LINK_REFUNDED_ERROR_CODE = "credits_link_refunded";

export const CREDITS_LINK_REFUNDED_MESSAGE =
  "Credits were refunded because the charge could not be linked to this job";

export type JobCreditsLinkInput = {
  jobId: string;
  /** The amount the workspace was charged. Must be a non-negative integer. */
  creditsCost: number;
  /** The deduction's transaction id, or `null` when none exists. */
  transactionId: string | null;
};

export type JobCreditsLinkJobInput = {
  jobId: string;
};

export type JobCreditsLinkRepository = {
  /**
   * Record which transaction paid for the job.
   *
   * `true` = this call wrote the row; `false` = the predicate matched nothing
   * (already billed, cancelled, terminal, or no such row). Neither answer is an
   * error. The caller must NOT assume `false` means "the write failed": it means
   * the row was not in a state this write owns.
   */
  linkCredits(input: JobCreditsLinkInput): Promise<boolean>;
  /**
   * Claim a job whose charge was never linked, so its refund is owned exactly
   * once.
   *
   * `true` = this call took ownership; `false` = somebody else already did, or
   * the job is in a state no compensation may touch (billed, running,
   * succeeded, or already terminal-with-a-code this module wrote).
   */
  claimUnlinkedCharge(input: JobCreditsLinkJobInput): Promise<boolean>;
  /**
   * Confirm that the claimed job's charge was refunded.
   *
   * `true` = the mark was written; `false` = the job is not `credits_refund_pending`
   * (or is no longer unbilled), so there is nothing to confirm.
   */
  markChargeRefunded(input: JobCreditsLinkJobInput): Promise<boolean>;
};

export const LINK_CREDITS = "linkCredits";
export const CLAIM_UNLINKED_CHARGE = "claimUnlinkedCharge";
export const MARK_CHARGE_REFUNDED = "markChargeRefunded";

export type JobCreditsLinkOperation =
  | typeof LINK_CREDITS
  | typeof CLAIM_UNLINKED_CHARGE
  | typeof MARK_CHARGE_REFUNDED;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line through us.
 */
export class JobCreditsLinkError extends Error {
  readonly operation: JobCreditsLinkOperation;

  constructor(operation: JobCreditsLinkOperation, cause: unknown) {
    super(
      `job credits link failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "JobCreditsLinkError";
    this.operation = operation;
  }
}

/**
 * The link statement — the migrated `setCreditsInfo`, with its result checked.
 *
 * `where ... and status in ('queued','retrying') and credits_cost is null` is
 * the whole rule:
 *
 * - `credits_cost is null` makes it exclusive with the worker's 21H1 timeout
 *   claim, which matches the same pair. Whichever statement runs first, the
 *   other answers zero rows; the money can never be recorded on a job that was
 *   already failed for being unbilled, and the worker can never fail a job
 *   whose charge just landed.
 * - `status in ('queued','retrying')` keeps the write off every row that has
 *   already left the pre-execution states. A `running` job was let through the
 *   gate, which means it was billed; a terminal one is somebody else's answer.
 *   This is also what makes a repeated call harmless: the second one changes
 *   nothing.
 *
 * `set` names exactly three columns. `payload`, `result`, every status column
 * and every transition stamp of the state machine are NOT reachable.
 */
const LINK_CREDITS_SQL = `
update public.background_jobs
   set credits_cost = $2::integer,
       credits_transaction_id = $3::uuid,
       updated_at = now()
 where id = $1::uuid
   and status in ('queued', 'retrying')
   and credits_cost is null
returning id
`;

/**
 * The claim statement.
 *
 * `status` and `failed_at` are written with a CASE rather than unconditionally:
 * the two not-yet-started states become a terminal failure, and every other
 * allowed state keeps exactly what it had. A `canceled` job must keep saying
 * `canceled` — the user's own action is not rewritten by a compensation pass —
 * and a row that already failed for its own reason keeps its own `failed_at`.
 * Both keep only the new `error_code`, which is the "a refund is owed" marker
 * the compensation path reads.
 *
 * The predicate is the ownership rule:
 *
 * - `credits_cost is null` — nothing was billed, so there is nothing the worker
 *   could refund; this module is the only possible refund owner.
 * - `status in (...)` — only a row that is not executing and not successfully
 *   finished. A `running` job is being executed on a charge that DID land (the
 *   21H1 gate); a `succeeded` job is the outcome somebody paid for.
 * - `error_code is distinct from ...` twice — the two markers this module
 *   writes stop it from claiming the same job again, which is what makes the
 *   refund one-shot.
 *
 * `set` names exactly five columns; `credits_cost` is only ever a predicate.
 */
const CLAIM_UNLINKED_CHARGE_SQL = `
update public.background_jobs
   set status = case when status in ('queued', 'retrying') then 'failed' else status end,
       failed_at = case when status in ('queued', 'retrying') then now() else failed_at end,
       error_code = 'credits_refund_pending',
       error_message = 'Credits were charged but could not be linked to this job; a refund is pending',
       updated_at = now()
 where id = $1::uuid
   and credits_cost is null
   and status in ('queued', 'retrying', 'canceled', 'failed', 'dead_letter')
   and error_code is distinct from 'credits_refund_pending'
   and error_code is distinct from 'credits_link_refunded'
returning id
`;

/**
 * The confirmation statement.
 *
 * It matches only the state `claimUnlinkedCharge` wrote — `credits_refund_pending`
 * on a still-unbilled row — so it can never mark a charge that was not claimed
 * and refunded by that path. The second run of the same compensation answers
 * zero rows, which is exactly what stops it from refunding a second time.
 */
const MARK_CHARGE_REFUNDED_SQL = `
update public.background_jobs
   set error_code = 'credits_link_refunded',
       error_message = 'Credits were refunded because the charge could not be linked to this job',
       updated_at = now()
 where id = $1::uuid
   and error_code = 'credits_refund_pending'
   and credits_cost is null
returning id
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `JobCreditsLinkError` on an actual call.
 *
 * There is no fallback path. A caller that was handed this repository either
 * writes through it or fails — and a failing write is a failure the caller can
 * see, unlike the silent PostgREST update this replaces.
 */
export function createJobCreditsLinkRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobCreditsLinkRepository {
  return {
    async linkCredits(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const jobId = requireJobId(LINK_CREDITS, input.jobId);
      const creditsCost = requireCreditsCost(LINK_CREDITS, input.creditsCost);
      const transactionId = requireTransactionId(
        LINK_CREDITS,
        input.transactionId,
      );

      return runWrite(LINK_CREDITS, options, LINK_CREDITS_SQL, [
        jobId,
        creditsCost,
        transactionId,
      ]);
    },

    async claimUnlinkedCharge(input) {
      const jobId = requireJobId(CLAIM_UNLINKED_CHARGE, input.jobId);

      return runWrite(CLAIM_UNLINKED_CHARGE, options, CLAIM_UNLINKED_CHARGE_SQL, [
        jobId,
      ]);
    },

    async markChargeRefunded(input) {
      const jobId = requireJobId(MARK_CHARGE_REFUNDED, input.jobId);

      return runWrite(MARK_CHARGE_REFUNDED, options, MARK_CHARGE_REFUNDED_SQL, [
        jobId,
      ]);
    },
  };
}

/**
 * One guarded write, one privileged transaction, one statement.
 *
 * Zero rows is the predicate answering "this step does not own that row" — a
 * legal `false` that COMMITs. More than one row is impossible for a statement
 * keyed on the primary key, so it is treated as a statement/mapper
 * disagreement rather than a value: a write that answered two rows has not
 * answered, and the transaction must roll back.
 */
async function runWrite(
  operation: JobCreditsLinkOperation,
  options: { getTransactionPool: () => TransactionPool },
  sql: string,
  params: readonly unknown[],
): Promise<boolean> {
  try {
    const pool = options.getTransactionPool();

    return await withPrivilegedTransaction(
      pool,
      // System bookkeeping: there is no acting user, so the context is
      // explicitly empty rather than borrowed from a caller. It grants nothing —
      // each statement's own `where id = $1::uuid` plus its predicate is the rule.
      null,
      async (client) => {
        const result = await client.query(sql, params);

        if (result.rows.length === 0) return false;

        if (result.rows.length !== 1) {
          throw new Error(
            `job credits link write updated more than one row (${operation})`,
          );
        }

        return true;
      },
    );
  } catch (error) {
    throw new JobCreditsLinkError(operation, error);
  }
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction,
 * the transaction rolls back and the connection stays usable. Pre-validating it
 * here would hide that path instead of exercising it.
 *
 * The refusal carries no value: the message names the FIELD, never the id.
 */
function requireJobId(
  operation: JobCreditsLinkOperation,
  value: unknown,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobCreditsLinkError(
      operation,
      new Error('job credits link needs a non-empty "jobId"'),
    );
  }

  return value;
}

/**
 * The cost is a whole, non-negative number of credits.
 *
 * A string, a fraction, a negative value or `NaN` is not an amount: it would
 * either be rejected by the driver at the far end of a round trip (an opaque
 * failure) or silently record something nobody was charged. The check is cheap,
 * local and has no side effect.
 */
function requireCreditsCost(
  operation: JobCreditsLinkOperation,
  value: unknown,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new JobCreditsLinkError(
      operation,
      new Error(
        'job credits link needs "creditsCost" as a whole non-negative number',
      ),
    );
  }

  return value;
}

/**
 * The transaction id is either a real transaction or the honest absence of one.
 *
 * `null` is a legal value on purpose: the free-model path records `(0, null)`
 * (workorder 21H1), because no transaction exists. An empty string is NOT that
 * value — it is a string that would be stored as a uuid-shaped hole and read
 * back as "a link was recorded", which is the ambiguity the pair exists to
 * avoid. Anything else is drift.
 */
function requireTransactionId(
  operation: JobCreditsLinkOperation,
  value: unknown,
): string | null {
  if (value === null) return null;

  if (typeof value !== "string" || value.length === 0) {
    throw new JobCreditsLinkError(
      operation,
      new Error(
        'job credits link needs "transactionId" as a non-empty string or null',
      ),
    );
  }

  return value;
}
