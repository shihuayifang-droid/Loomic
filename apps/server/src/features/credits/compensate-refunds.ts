/**
 * One pass of the refund compensation queue (workorder 39L, BL-41 step 4).
 *
 * A refund that failed is recorded in `refund_compensations` (39J / 39K) and
 * this module is what turns one claimed batch of those rows back into money.
 * It is deliberately the whole policy, in one function, with every collaborator
 * injected:
 *
 *   1. CLAIM ONCE. `claimDue` takes up to `REFUND_COMPENSATION_BATCH` rows and
 *      counts one attempt on each. The claim is the only place that decides
 *      which rows this pass owns, so this function never selects anything
 *      itself and two workers cannot both claim the same row.
 *   2. PAY, THEN CLOSE. A row is only `finish`ed after its outcome is known:
 *      `ok: true` with the refund transaction id when the credits went back,
 *      `ok: false` with the error text when they did not. The finish is what
 *      pushes the row five minutes ahead, or closes it for good.
 *   3. GIVE UP OUT LOUD. When a failure exhausts the row (twelfth attempt), the
 *      row is finished first and then reported with the fixed
 *      `[ALERT]`-prefixed line below, because "we stopped trying" must never be
 *      a silent state. The external alerting channel is a separate decision
 *      (39J); a fixed log prefix is what the admin greps until then.
 *   4. ONE BAD ROW IS ONE BAD ROW. Every row is handled inside its own
 *      try/catch, including a `finish` that throws or a refund that explodes:
 *      the loop always moves to the next row and the function never rejects, so
 *      one poisoned row cannot stop the other nineteen from being retried.
 *   5. THE LINK MARK IS BEST EFFORT. `markLinkRefunded` writes bookkeeping on
 *      the job row for the unlinked-charge path. It runs only when the claimed
 *      row asks for it, and a failure there is logged and ignored: the money is
 *      already back, so a failed mark must not turn a successful refund into a
 *      "failed" attempt that pays out a second time next tick.
 *
 * Nothing here touches a database, a clock or a pool: `claimDue`, `refund`,
 * `finish` and the optional `markLinkRefunded` carry all of that, which is why
 * the whole policy is testable with plain functions.
 */

/** How many due rows one pass claims. Deliberately small: one pass, one batch. */
export const REFUND_COMPENSATION_BATCH = 20;

/**
 * The one line an operator alerting rule matches on when the queue gives up.
 * The job, workspace, amount and attempt count follow it, so the log line alone
 * names what has to be refunded by hand.
 */
export const REFUND_COMPENSATION_EXHAUSTED_LOG =
  "[ALERT] refund compensation exhausted";

/** One claimed row, as `claimDue` hands it over. */
export type DueRefundCompensationRow = {
  /** Row id of `refund_compensations`; what `finish` closes. */
  id: string;
  jobId: string;
  workspaceId: string;
  userId: string;
  amount: number;
  description: string;
  /** True when the job also has to be marked `credits_link_refunded`. */
  markLinkRefunded: boolean;
  /** Attempts including the one the claim just counted. */
  attempts: number;
  maxAttempts: number;
};

/** What closing one attempt answered. */
export type RefundCompensationStatus = "pending" | "done" | "exhausted";

export type CompensateRefundsDeps = {
  /** Take the rows that are due, counting one attempt on each. */
  claimDue(limit: number): Promise<DueRefundCompensationRow[]>;
  /** Pay the credits back; resolves with the refund transaction id. */
  refund(input: {
    workspaceId: string;
    userId: string;
    amount: number;
    jobId: string;
    description: string;
  }): Promise<string>;
  /** Best-effort bookkeeping mark; its failure never fails the row. */
  markLinkRefunded?(input: { jobId: string }): Promise<unknown>;
  /** Close one attempt and answer the row's resulting status. */
  finish(input: {
    id: string;
    ok: boolean;
    refundTransactionId: string | null;
    error: string | null;
  }): Promise<RefundCompensationStatus>;
  /** Where the two log lines go. Defaults to silence. */
  log?(m: string): void;
};

/** Plain counters; a pass reports what happened rather than throwing. */
export type CompensateRefundsResult = {
  /** Refunded and closed as done. */
  done: number;
  /** Still failing, row left pending for the next tick. */
  failed: number;
  /** Given up on; each one produced an `[ALERT]` line. */
  exhausted: number;
};

/**
 * Run one compensation pass: claim a batch, refund each row, close each row.
 * Never rejects; a row that cannot be finished counts as `failed`.
 */
export async function compensateRefunds(
  deps: CompensateRefundsDeps,
): Promise<CompensateRefundsResult> {
  const log = deps.log ?? (() => {});
  const result: CompensateRefundsResult = { done: 0, failed: 0, exhausted: 0 };

  // A claim that fails is a failed PASS, not a failed row: there is nothing to
  // finish and nothing to retry individually, so it propagates to the caller
  // (the schedule logs it and the next tick tries again).
  const rows = await deps.claimDue(REFUND_COMPENSATION_BATCH);

  for (const row of rows) {
    try {
      let refundTransactionId: string;

      try {
        refundTransactionId = await deps.refund({
          workspaceId: row.workspaceId,
          userId: row.userId,
          amount: row.amount,
          jobId: row.jobId,
          description: row.description,
        });
      } catch (error) {
        // The attempt failed. Close it first: the status the database answers
        // is what decides "try again in five minutes" vs "give up".
        const message = describeError(error);
        const status = await deps.finish({
          id: row.id,
          ok: false,
          refundTransactionId: null,
          error: message,
        });

        if (status === "exhausted") {
          result.exhausted += 1;
          safeLog(
            log,
            `${REFUND_COMPENSATION_EXHAUSTED_LOG} job=${row.jobId} ` +
              `workspace=${row.workspaceId} amount=${row.amount} ` +
              `attempts=${row.attempts}: ${message}`,
          );
        } else {
          result.failed += 1;
        }

        continue;
      }

      // The money is back. The optional link mark is bookkeeping only, so its
      // failure is reported and the row still closes as done.
      if (deps.markLinkRefunded && row.markLinkRefunded) {
        try {
          await deps.markLinkRefunded({ jobId: row.jobId });
        } catch (error) {
          safeLog(
            log,
            `refund compensation link mark failed: job=${row.jobId} ${describeError(error)}`,
          );
        }
      }

      await deps.finish({
        id: row.id,
        ok: true,
        refundTransactionId,
        error: null,
      });
      result.done += 1;
    } catch (error) {
      // Either the refund or the closing write blew up in a way the branches
      // above do not name. The row is not settled, so it counts as failed and
      // the loop keeps going.
      result.failed += 1;
      safeLog(
        log,
        `refund compensation row failed: job=${row.jobId} ${describeError(error)}`,
      );
    }
  }

  return result;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A throwing logger must not end the pass it is reporting on. */
function safeLog(log: (m: string) => void, message: string): void {
  try {
    log(message);
  } catch {
    // Reported nothing, changed nothing.
  }
}
