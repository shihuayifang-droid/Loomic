/**
 * OP-11 / workorder 45CB: the retention sweep over `public.background_jobs`.
 *
 * The table grows by one row per job and never shrinks: a job is a record of
 * something that happened, not a thing a user reads back after it finished, so
 * everything older than the approved window is history nobody will look at
 * again. The approved rule (U-26) is exactly three sentences, and this module is
 * their whole implementation:
 *
 *   1. 180 DAYS. `JOB_RETENTION_DAYS` is the window; a row is a candidate when
 *      its last terminal instant is older than `now - retentionDays`.
 *   2. TERMINAL ROWS ONLY. `succeeded`, `failed`, `canceled` and the legacy
 *      `dead_letter` are outcomes. `queued`, `running` and `retrying` are jobs
 *      that still have an owner — deleting one would strand a refund, a running
 *      executor or a message that is still on the queue, so the sweep never
 *      names them. The set is spelled out in the SQL of every statement rather
 *      than passed in: a caller cannot widen it by mistake.
 *   3. DRY RUN BY DEFAULT. `dryRun` defaults to `true`, and in that mode the
 *      only statement this module issues is a `count(*)`. Deleting is an
 *      explicit act (`dryRun: false`), which is what the CLI's `--apply` and the
 *      worker's `HAHART_JOB_RETENTION_APPLY=true` spell out.
 *
 * WHY BATCHES
 * A single unbounded `delete` over a large table takes one long lock and one
 * long transaction, and a sweep is not urgent enough to pay for that. Each
 * statement deletes at most `batchSize` ids chosen by their own sub-select, and
 * the loop stops as soon as a batch comes back short — so the number of
 * statements is proportional to the work, not to the size of the table, and the
 * default `batchSize` (5000) makes the lock footprint of one pass small.
 *
 * WHY NOT `select *`
 * `payload` and `result` are `jsonb`. Nothing in the decision needs them, so no
 * statement here reads or returns a row — the sub-select carries `id` only.
 *
 * The pool is a structural one-method type (`query`), so the sweep works against
 * the real `pg` pool in production and against a recording fake in the tests,
 * without this module importing `pg`.
 */

/** U-26, approved: how long a finished job row is kept. */
export const JOB_RETENTION_DAYS = 180;

/**
 * The terminal statuses, from `public.background_job_status`
 * (`packages/shared/src/job-contracts.ts`, and the same seven values the
 * database enum reports). The three non-terminal ones — `queued`, `running`,
 * `retrying` — are deliberately absent: see the module comment.
 */
export const TERMINAL_JOB_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
  "dead_letter",
] as const;

/** The default `LIMIT` of one delete batch. */
export const DEFAULT_JOB_RETENTION_BATCH_SIZE = 5000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `status in ('succeeded', 'failed', 'canceled', 'dead_letter')`, built from the
 * constant above so the list exists once. These are code constants, never
 * caller input, so interpolating them is not a parameterisation hole.
 */
const TERMINAL_STATUS_LIST_SQL = TERMINAL_JOB_STATUSES.map(
  (status) => `'${status}'`,
).join(", ");

/**
 * The last instant a job was known to be finished. `completed_at` / `failed_at`
 * / `canceled_at` are the outcome stamps; `created_at` is the fallback for a row
 * whose terminal stamp is missing (older rows, and the legacy `dead_letter`),
 * so such a row ages out instead of becoming immortal.
 */
const FINISHED_AT_SQL =
  "coalesce(completed_at, failed_at, canceled_at, created_at)";

/** The `where` every statement here shares: terminal AND older than the cutoff. */
const CANDIDATE_WHERE_SQL = `
  where status in (${TERMINAL_STATUS_LIST_SQL})
    and ${FINISHED_AT_SQL} < $1
`;

const COUNT_CANDIDATES_SQL = `
  select count(*) as candidates
  from public.background_jobs
  ${CANDIDATE_WHERE_SQL}
`;

const DELETE_BATCH_SQL = `
  delete from public.background_jobs
  where id in (
    select id
    from public.background_jobs
    ${CANDIDATE_WHERE_SQL}
    order by id
    limit $2
  )
`;

/** The one method this module needs from a pool. */
export type JobRetentionPool = {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly unknown[]; rowCount?: number | null }>;
};

export type JobRetentionOptions = {
  /** The window; defaults to `JOB_RETENTION_DAYS`. */
  retentionDays?: number;
  /** The instant the window is measured from; defaults to `new Date()`. */
  now?: Date;
  /** The `LIMIT` of one delete batch; defaults to `DEFAULT_JOB_RETENTION_BATCH_SIZE`. */
  batchSize?: number;
  /** `true` counts and writes nothing; defaults to `true`. */
  dryRun?: boolean;
};

export type JobRetentionResult = {
  /** Whether this pass wrote anything. */
  dryRun: boolean;
  retentionDays: number;
  /** `now - retentionDays`, as an ISO instant — the exact boundary that was used. */
  cutoff: string;
  /** Rows matched by the candidate `where` at the moment the pass counted. */
  candidates: number;
  /** Rows actually deleted; always 0 in a dry run. */
  deleted: number;
  /** Delete statements issued; always 0 in a dry run. */
  batches: number;
};

/**
 * Count (and, unless `dryRun`, delete) the finished jobs older than the window.
 *
 * Returns the numbers the run really produced — `candidates` from the `count(*)`,
 * `deleted` from the sum of the batch `rowCount`s — so a caller can report a dry
 * run and an applied run with the same shape.
 */
export async function pruneFinishedJobs(
  pool: JobRetentionPool,
  options: JobRetentionOptions = {},
): Promise<JobRetentionResult> {
  const retentionDays = options.retentionDays ?? JOB_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? true;
  const batchSize = options.batchSize ?? DEFAULT_JOB_RETENTION_BATCH_SIZE;

  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(`retentionDays must be a non-negative number, got ${retentionDays}`);
  }
  // A batch of 0 would loop forever on a `rowCount` that never shrinks, and a
  // negative LIMIT is not the same statement. Fail loud instead of sweeping.
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
  }

  const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);
  const cutoffIso = cutoff.toISOString();

  const counted = await pool.query(COUNT_CANDIDATES_SQL, [cutoffIso]);
  const countRow = counted.rows[0] as { candidates?: unknown } | undefined;
  const candidates = Number(countRow?.candidates ?? 0);

  if (dryRun) {
    // Property 3: in a dry run this is the last statement. Nothing was written.
    return {
      dryRun: true,
      retentionDays,
      cutoff: cutoffIso,
      candidates,
      deleted: 0,
      batches: 0,
    };
  }

  let deleted = 0;
  let batches = 0;
  for (;;) {
    const batch = await pool.query(DELETE_BATCH_SQL, [cutoffIso, batchSize]);
    batches += 1;
    const removed = batch.rowCount ?? 0;
    deleted += removed;
    // A short batch means the candidates are exhausted: the next `select` would
    // return nothing, so there is no reason to issue it.
    if (removed < batchSize) break;
  }

  return {
    dryRun: false,
    retentionDays,
    cutoff: cutoffIso,
    candidates,
    deleted,
    batches,
  };
}
