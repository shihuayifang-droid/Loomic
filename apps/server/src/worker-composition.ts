/**
 * Worker composition root (workorder 21X, ADR-0001 migration step 2).
 *
 * `worker.ts` used to build every collaborator of its polling loop inline in
 * `main()`: the job service with its three `pg` repositories, the credits
 * service, the read-only credits repository, the billing gate, the refund basis
 * repository and the refund function, and then the per-message base context.
 * That wiring had no test at all, and it could not have one where it lived: the
 * module boots global-agent, registers every executor and provider and calls
 * `main()` at import time. A single missing line there was also invisible to the
 * type checker — workorder 21N lost the worker's `jobAdminReadRepository`, which
 * is a perfectly legal options object, and every admin job read failed closed at
 * runtime instead.
 *
 * This module is that same wiring, moved here and behind a PURE function, so a
 * test can build the REAL composition and observe which collaborators each one
 * actually received.
 *
 * Rules this module keeps:
 *
 * - The assembly order, the arguments of every repository and the five keys of
 *   `baseCtx` are unchanged: this is a move, not a redesign.
 * - The six identical copies of the pool getter are ONE input
 *   (`getTransactionPool`). Every repository still receives a getter and still
 *   reaches the pool LAZILY, so building this composition opens no connection
 *   and touches no connection string; the worker passes the expression it always
 *   passed.
 * - Pure: no `process.env` read, no connection, no log line and no module-level
 *   side effect. Importing this module registers NO executor and NO provider —
 *   those registrations stay in `worker.ts`, where they already were.
 */

import { createJobService, type JobService } from "./features/jobs/job-service.js";
import { pruneFinishedJobs } from "./features/jobs/job-retention.js";
import {
  jobRetentionApplyEnabled,
  startJobRetentionSchedule,
} from "./features/jobs/job-retention-schedule.js";
import { reconcileCredits } from "./features/credits/daily-reconcile.js";
import { startDailyReconcileSchedule } from "./features/credits/daily-reconcile-schedule.js";
import { getDatabasePool } from "./db/pool.js";
import { createJobAttemptRepository } from "./db/job-attempt-repository.js";
import { createJobTransitionRepository } from "./db/job-transition-repository.js";
import {
  createJobBillingGateRepository,
  type JobBillingGateRepository,
} from "./db/job-billing-gate-repository.js";
import { createJobAdminReadRepository } from "./db/job-admin-read-repository.js";
import { createJobCreateRepository } from "./db/job-create-repository.js";
import {
  createAssetReadRepository,
  type AssetReadRepository,
} from "./db/asset-read-repository.js";
import { createJobRefundBasisRepository } from "./db/job-refund-basis-repository.js";
import { createRefundCompensationRepository } from "./db/refund-compensation-repository.js";
import {
  createCreditReadRepository,
  type CreditReadRepository,
} from "./db/credit-read-repository.js";
import {
  createAssetProvenanceRepository,
  type AssetProvenanceRepository,
} from "./db/asset-provenance-repository.js";
import {
  createAssetRecordRepository,
  type AssetRecordRepository,
} from "./db/asset-record-repository.js";
import { createRefundJob, type RefundJob } from "./features/jobs/refund-job.js";
import { createCreditService, type CreditService } from "./features/credits/credit-service.js";
import { createCreditLedgerFunctionRepository } from "./db/credit-ledger-function-repository.js";
import { createCreditPoolWriteRepository } from "./db/credit-pool-write-repository.js";
import { createPoolBalanceReadRepository } from "./db/pool-balance-read-repository.js";
import {
  creditPoolsEnabled,
  withCreditPools,
} from "./features/credits/credit-pools-billing.js";
import { createObjectStore } from "./features/storage/object-store-factory.js";
import type { ObjectStore } from "./features/storage/object-store.js";
import type { SupabaseStorageLike } from "./features/storage/supabase-object-store.js";
import type { ServerEnv } from "./config/env.js";
import type { PgmqClient } from "./queue/pgmq-client.js";
import type { AdminSupabaseClient } from "./supabase/admin.js";
import type { UserSupabaseClient } from "./supabase/user.js";
import type { TransactionPool } from "./db/transaction.js";

/**
 * Everything the composition needs from its caller. `env`, `pgmq`,
 * `createUserClient` and `getAdminClient` are the values `main()` already held;
 * `getTransactionPool` is the one thing this extraction changed shape, so the
 * six copies of the same expression live at ONE call site instead of six.
 */
export type WorkerCompositionInput = {
  env: ServerEnv;
  pgmq: PgmqClient;
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  /**
   * The lazily-resolved `pg` pool every repository below reads and writes
   * through. It is an input rather than something built here so the connection
   * string expression stays at the worker's own call site — and so a test can
   * hand in a recording pool with no database behind it.
   */
  getTransactionPool: () => TransactionPool;
};

/**
 * The per-message base context, exactly the five keys `worker.ts` spread into
 * every `ExecutorContext`. `jobService` and `creditReadRepository` are the SAME
 * instances the composition returns: nothing here re-wraps or re-builds them.
 */
export type WorkerBaseContext = {
  jobService: JobService;
  pgmq: PgmqClient;
  env: ServerEnv;
  creditReadRepository: CreditReadRepository;
  assetProvenanceRepository: AssetProvenanceRepository;
  assetReadRepository: AssetReadRepository;
  assetRecordRepository: AssetRecordRepository;
  /**
   * T-133 1c: the object storage the executors upload their output through.
   * Built here, once, and handed to every executor context.
   */
  objectStore: ObjectStore;
};

export type WorkerComposition = {
  jobService: JobService;
  creditService: CreditService;
  creditReadRepository: CreditReadRepository;
  billingGate: JobBillingGateRepository;
  refundJob: RefundJob;
  baseCtx: WorkerBaseContext;
};

/**
 * Build the worker's collaborators. Pure and synchronous: it constructs plain
 * objects and touches no pool, no queue and no environment variable, so the
 * first actual connection happens on the first call that genuinely reads or
 * writes.
 */
export function buildWorkerComposition(
  input: WorkerCompositionInput,
): WorkerComposition {
  const { env, pgmq, createUserClient, getAdminClient, getTransactionPool } = input;

  const jobService = createJobService({
    createUserClient,
    getAdminClient,
    pgmq,
    // ADR-0001 / workorder 21F: the atomic `attempt_count` move is the worker's
    // own write, so the worker builds the repository itself — lazily, against
    // `DATABASE_URL`, exactly as `app.ts` does. With no reachable pool the call
    // fails closed, `processJobMessage` leaves the message for a later retry and
    // nothing here can reach the old `increment_job_attempt` RPC.
    jobAttemptRepository: createJobAttemptRepository({
      getTransactionPool,
    }),
    // ADR-0001 / workorder 21M: the four guarded status transitions the worker
    // performs on a job it is executing (`queued|retrying -> running`,
    // `running -> retrying`, `running -> succeeded`, `* -> failed`). Built here,
    // lazily and against the same `DATABASE_URL` as the attempt counter above.
    // With no reachable pool each transition fails closed and
    // `processJobMessage` treats it as a failure instead of assuming the row
    // moved — nothing here can reach the update this replaces.
    jobTransitionRepository: createJobTransitionRepository({
      getTransactionPool,
    }),
    // ADR-0001 / workorder 21N: the admin single-row read both generation
    // executors now share. Workorder 21I moved `getJobAdmin` onto this repository
    // but wired it into `app.ts` only, so without this line the worker's
    // executors call a service with nothing behind the read and every job row
    // read fails closed as `job_query_failed`. Built lazily against the same
    // `DATABASE_URL` as the repositories above.
    jobAdminReadRepository: createJobAdminReadRepository({
      getTransactionPool,
    }),
    // Workorder 44Q: the job row insert and its compensating delete, built
    // lazily against the same pool as the repositories above.
    jobCreateRepository: createJobCreateRepository({
      getTransactionPool,
    }),
  });
  const baseCreditService = createCreditService({
    creditLedgerFunctionRepository: createCreditLedgerFunctionRepository({
      getTransactionPool,
    }),
  });
  // Workorder 37T: `LOOMIC_CREDIT_POOLS=on` moves the refund (and the charge)
  // onto the three pools; anything else keeps the service exactly as built.
  const creditService: CreditService = creditPoolsEnabled()
    ? withCreditPools(baseCreditService, {
        ...createCreditPoolWriteRepository({ getTransactionPool }),
        readPoolBalances: (poolInput) =>
          createPoolBalanceReadRepository({
            pool: getTransactionPool(),
          }).readPoolBalances(poolInput),
      })
    : baseCreditService;

  // ADR-0001 / workorder 21W: the image executor's watermark decision reads the
  // workspace subscription row to learn the plan. It used to be an admin client
  // read inside the executor whose `error` field was discarded, so a missing row
  // and a failed read both meant the free plan — and a free plan means the image
  // IS watermarked. The read now goes through
  // `CreditReadRepository.readSubscription`, built here as its OWN instance
  // against the same `DATABASE_URL` as the repositories above. The
  // `createCreditService` call above is deliberately untouched: that service
  // still uses its admin client for everything else it does, and this line
  // neither injects into it nor changes it. With no reachable pool the read
  // fails and the executor falls back to the free plan, so the outcome is the
  // one the discarded error used to produce.
  const creditReadRepository = createCreditReadRepository({
    getTransactionPool,
  });

  // GN-11: the image / video executors write provenance onto the asset row they
  // just registered. Built lazily against the same `DATABASE_URL` as the
  // repositories above, so construction connects to nothing.
  const assetProvenanceRepository = createAssetProvenanceRepository({
    getTransactionPool,
  });

  // ED-00j: the tool_execution executor resolves its input artifact through the
  // read ACL. Built lazily like the repositories above, so construction
  // connects to nothing.
  const assetReadRepository = createAssetReadRepository({
    getTransactionPool,
  });

  // 44H: the image / tool / video executors record the ownership of their
  // output through this. Built lazily like the repositories above, so
  // construction connects to nothing.
  const assetRecordRepository = createAssetRecordRepository({
    getTransactionPool,
  });

  // T-133 1c: the object storage the executors upload their output through.
  //
  // ONE instance, built once and reused by every message, the same way
  // `worker.ts` and `app.ts` build theirs: `createObjectStore` picks the backend
  // from `HAHART_STORAGE_PROVIDER`, and in `supabase` mode its delegate is LAZY —
  // so this line constructs no client, reads no connection string and connects to
  // nothing, exactly like the repositories above. The thunk is `getAdminClient`,
  // the same lazy client the 1b fallback inside the executors used, so the bytes
  // keep going to the buckets they went to before.
  const objectStore: ObjectStore = createObjectStore(env, {
    supabaseClient: () => getAdminClient() as unknown as SupabaseStorageLike,
  });

  // ADR-0001 / workorder 21H1: the billing gate the worker runs before it
  // consumes an attempt or calls a model. Built here, lazily, exactly like the
  // attempt repository above and against the same `DATABASE_URL`. With no
  // reachable pool the READ fails, `processJobMessage` leaves the message for a
  // later retry and the job is never executed unbilled — there is no fallback
  // that could reach PostgREST or skip the gate.
  const billingGate = createJobBillingGateRepository({
    getTransactionPool,
  });

  // ADR-0001 / workorder 21O: the refund basis the worker reads before it gives
  // credits back — `credits_cost`, `workspace_id`, `created_by` of one job row.
  // It used to be an admin PostgREST read inside a local function in this file,
  // which discarded its error field, so a failed read and a missing row both
  // meant "refund nothing, silently". Built lazily against the same
  // `DATABASE_URL` as the repositories above: with no reachable pool the read
  // fails, the refund path logs that failure and NO money moves — there is no
  // fallback that could reach PostgREST.
  const refundBasisRepository = createJobRefundBasisRepository({
    getTransactionPool,
  });

  // The refund decision itself lives in `features/jobs/refund-job.ts`: the
  // condition, the amount, the description and the "never throws" contract are
  // unchanged, and the tag stays a call-site argument so both log lines keep
  // naming this worker.
  //
  // BL-41 / workorder 39K: a refund that fails is no longer only a log line — it
  // is recorded in `refund_compensations` so the queue retries it. Built lazily
  // against the same `DATABASE_URL` as every repository above, exactly like them;
  // with no reachable pool the recording fails, `refundJob` logs that failure and
  // still resolves (the refund itself already failed, so nothing regresses).
  // `markLinkRefunded: false` because the worker refunds a job that HAS its
  // `credits_cost`; the unlinked-charge path (with-billing) is the one that owns
  // the mark.
  const refundCompensationRepository = createRefundCompensationRepository({
    getTransactionPool,
  });
  const refundJob = createRefundJob({
    readRefundBasis: (refundInput) => refundBasisRepository.readRefundBasis(refundInput),
    creditService,
    recordCompensation: async (compensationInput) => {
      await refundCompensationRepository.record({
        ...compensationInput,
        markLinkRefunded: false,
      });
    },
  });

  // OP-11 / workorder 45CB: the retention sweep, beside the stuck-job reaper.
  // Started here rather than in `worker.ts` because that is the file the ticket
  // allows, and because the composition is the one place every collaborator is
  // built: the sweep needs the same pool as everything else and nothing that the
  // per-message context holds.
  //
  // Three properties, all in `features/jobs/job-retention-schedule.ts`: it does
  // NOT run at start (a deploy must not sweep the table — the rows it looks at
  // are 180 days old and can wait a day), overlapping ticks are dropped, and a
  // failed pass is logged instead of ending the schedule.
  //
  // Whether it deletes anything is `HAHART_JOB_RETENTION_APPLY`, read once per
  // pass by `jobRetentionApplyEnabled()`: only the exact value `"true"` turns a
  // count into a delete, so the approved default (count only) survives an unset
  // variable or a typo. Nothing here connects: `getDatabasePool()` is lazy and is
  // only reached on the first pass a day from now, which is also why this line
  // opens no socket during a test that merely builds the composition.
  startJobRetentionSchedule({
    prune: () =>
      pruneFinishedJobs(getDatabasePool(), {
        dryRun: !jobRetentionApplyEnabled(),
      }),
    log: (m) => console.log(`[job-retention] ${m}`),
  });

  // OP-11 / workorder 45CC: the daily credits reconciliation, alongside the
  // retention sweep. Started here for the same reasons and with the same
  // laziness: `getDatabasePool()` is inside the thunk, so building the
  // composition still opens no socket and a test that merely builds it pays
  // nothing.
  //
  // READ ONLY, WARN ONLY. `reconcileCredits` answers "does the ledger still
  // agree with `background_jobs` and `team_credit_pools`?" with four counts and
  // writes nothing; the approved behaviour (U-26) is that a drift is reported
  // for a human, never repaired here. The first pass waits a full 24 hours (see
  // `features/credits/daily-reconcile-schedule.ts`): a restart inherits nothing,
  // so a deploy must not put four `count(*)`s on a database it has not touched
  // yet. A dirty report reaches `console.warn` through the schedule's default
  // reporter, one `<check>=<count>` per finding.
  startDailyReconcileSchedule({
    reconcile: () => reconcileCredits(getDatabasePool()),
  });

  // Base context — per-message fields (queue, msgId, renewVt) are added per message below
  const baseCtx: WorkerBaseContext = {
    jobService,
    pgmq,
    env,
    // Workorder 21W: the image executor's watermark decision reads the plan
    // through this. Optional on `ExecutorContext`, wired here for real.
    creditReadRepository,
    // GN-11: provenance written onto the asset row by the image / video executors.
    assetProvenanceRepository,
    // ED-00j: the input artifact of a tool_execution job is read through this.
    assetReadRepository,
    // 44H: output ownership of image / tool / video jobs is recorded through this.
    assetRecordRepository,
    // T-133 1c: the executors upload their output through this store, so the 1b
    // transitional branch (`ctx.objectStore ?? <build one>`) is no longer reached
    // on the production path — the 8th slice deletes that branch.
    objectStore,
  };

  return {
    jobService,
    creditService,
    creditReadRepository,
    billingGate,
    refundJob,
    baseCtx,
  };
}
