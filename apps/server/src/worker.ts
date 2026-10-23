// @credits-system — Worker process: handles job failure refunds (credit refund on generation error)
import { bootstrap } from "global-agent";

// Enable HTTP proxy for all outbound requests if GLOBAL_AGENT_HTTP_PROXY is set
bootstrap();

// Native fetch() proxy — needed for @google/generative-ai SDK
if (process.env.GLOBAL_AGENT_HTTP_PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(process.env.GLOBAL_AGENT_HTTP_PROXY));
}

import { randomUUID } from "node:crypto";
import { loadServerEnv } from "./config/env.js";
import {
  createQueueClient,
  queueConnectionMissingMessage,
} from "./queue/queue-client-factory.js";
import { DATABASE_URL_ENV_KEY, getTransactionPool } from "./db/pool.js";
import { processJobMessage } from "./features/jobs/process-job-message.js";
import { reapStuckJobs } from "./features/jobs/reap-stuck-jobs.js";
import { shouldStartTeamCycleGrant } from "./features/credits/team-cycle-grant-schedule.js";
import { compensateRefunds } from "./features/credits/compensate-refunds.js";
import { SCHEDULE_CATALOG } from "./features/schedules/schedule-catalog.js";
import { startSchedules } from "./features/schedules/schedule-runner.js";
import { createJobCreditsLinkRepository } from "./db/job-credits-link-repository.js";
import { createRefundCompensationRepository } from "./db/refund-compensation-repository.js";
import { createJobStuckReaderRepository } from "./db/job-stuck-reader-repository.js";
import { createPoolGrantWriteRepository } from "./db/pool-grant-write-repository.js";
import { buildWorkerComposition } from "./worker-composition.js";
import { getExecutor, type ExecutorContext } from "./features/jobs/job-executor.js";
import {
  JOB_QUEUES,
  JOB_TYPE_REGISTRY,
  type JobTypeConfig,
} from "./features/jobs/job-registry.js";
import { createAdminSupabaseClient } from "./supabase/admin.js";
import { createUserSupabaseClientFactory } from "./supabase/user.js";

// Import executors to trigger registration via side effects
import "./features/jobs/executors/image-generation.js";
import "./features/jobs/executors/video-generation.js";
import "./features/jobs/executors/tool-execution.js";

import type { BackgroundJobType } from "@loomic/shared";

// Register all image/video providers via shared helper (keeps parity with app.ts)
import { registerAllProviders } from "./generation/providers/register-all.js";
// Register the concrete tool runners the tool_execution executor resolves by id
import { registerToolRunners } from "./features/tools/register-tool-runners.js";

// 一期关闭 execute（D-24，AG-39），代码执行不走 PGMQ。
//
// Queue list, queue->type mapping, visibility timeouts and concurrency caps all
// come from JOB_TYPE_REGISTRY now; they used to be four separate tables here.

async function main() {
  const env = loadServerEnv();

  const missing = queueConnectionMissingMessage(env);
  if (missing) {
    console.error(missing);
    process.exit(1);
  }

  // Register all generation providers (shared with app.ts)
  registerAllProviders(env);
  // GN-05 / ED-06 / ED-07: the tools this process can execute. After the
  // providers, because the quick-edit runner calls the gateway provider.
  registerToolRunners(env);

  const pgmq = createQueueClient(env)!;
  const createUserClient = createUserSupabaseClientFactory(env);

  let adminClient: ReturnType<typeof createAdminSupabaseClient> | undefined;
  const getAdminClient = () => {
    adminClient ??= createAdminSupabaseClient(env);
    return adminClient;
  };

  // ADR-0001 / workorder 21X: the whole assembly below used to live here, in
  // `main()`, where nothing could test it. It is unchanged and now lives in
  // `worker-composition.ts`, behind the pure `buildWorkerComposition`. The one
  // shape change is the pool getter: the six identical copies of the
  // `DATABASE_URL` expression collapsed into the single `getTransactionPool`
  // argument below, which is character for character what each copy used to be.
  //
  // Workorder 36J: the reaper needs the same pool, so the expression has a name
  // instead of a second copy — a repository pointed at a different pool would
  // read rows this worker never wrote, and reclaim nothing.
  const getPool = () =>
    getTransactionPool(
      env.databaseUrl ? { [DATABASE_URL_ENV_KEY]: env.databaseUrl } : {},
    );

  const { jobService, billingGate, creditService, refundJob, baseCtx } =
    buildWorkerComposition({
      env,
      pgmq,
      createUserClient,
      getAdminClient,
      getTransactionPool: getPool,
    });

  const inFlightByQueue = new Map<string, Set<Promise<void>>>(
    JOB_QUEUES.map((q) => [q, new Set()]),
  );

  // Server-side long poll: wait up to N seconds inside Postgres for messages,
  // checking every 500ms. This replaces the old client-side sleep(2000) + read()
  // pattern that generated ~340K idle queries per monitoring period.
  const pollTimeoutSeconds = Math.max(1, Math.floor((env.workerPollIntervalMs ?? 5000) / 1000));
  const workerId = env.workerId ?? randomUUID().slice(0, 8);
  const tag = `[worker:${workerId}]`;

  let running = true;

  // OP-11 (workorder 43A): one timer drives every periodic task, and the sheet
  // of what runs, how often, who owns it and whether a failure alerts lives in
  // `features/schedules/schedule-catalog.ts`. The three that are wired up keep
  // the exact cadences the three hand-written timers had (GN-31 reaper 5 min,
  // BL-41 refund compensator 5 min, BL-44 team cycle grant 10 min), and `every`
  // tasks still run immediately at start — a worker that restarts reclaims what
  // its previous life left behind instead of waiting a whole interval.
  //
  // `failedAt` is not passed on: `jobService.markFailed` stamps the time itself,
  // so the instant this pass reads is never used for the write.
  //
  // The repositories are still built here, lazily, against the same pool getter as
  // everything else in this file — resolving lazily means a pass that never runs
  // never connects. `creditService` comes from the composition above, so the
  // refund payout goes through the same `LOOMIC_CREDIT_POOLS` switch as the
  // charge and the refund that queued the row.
  //
  // Workorder 38I: the team cycle grant is three-pool bookkeeping, so it belongs
  // to the `LOOMIC_CREDIT_POOLS=on` side of the switch, like the charge and the
  // daily grant do. With the switch off the task is not wired at all, so the
  // catalog entry simply has nothing to run — no `cycle_grant` ledger line and no
  // pool row.
  //
  // OP-18: the alert channel is not decided yet, so `onAlert` only logs for now.
  // The runner has already printed the structured `ALERT schedule_failed` line;
  // connecting the real channel replaces this callback and nothing else.
  const stuckReader = createJobStuckReaderRepository({ getTransactionPool: getPool });
  const refundCompensations = createRefundCompensationRepository({
    getTransactionPool: getPool,
  });
  const creditsLink = createJobCreditsLinkRepository({
    getTransactionPool: getPool,
  });

  const schedules = startSchedules({
    entries: SCHEDULE_CATALOG,
    tasks: {
      stuck_job_reaper: async () => {
        await reapStuckJobs({
          listRunningStartedBefore: (i) => stuckReader.listRunningStartedBefore(i),
          markFailed: ({ jobId, errorCode, errorMessage }) =>
            jobService.markFailed(jobId, errorCode, errorMessage),
          refundJob: (jobId) => refundJob(jobId, `${tag} [reaper]`),
          now: () => new Date(),
          log: (m) => console.log(`${tag} ${m}`),
        });
      },
      refund_compensation: async () => {
        await compensateRefunds({
          claimDue: (limit) => refundCompensations.claimDue(limit),
          refund: (input) =>
            creditService.refundCredits(
              input.workspaceId,
              input.userId,
              input.amount,
              input.jobId,
              input.description,
            ),
          markLinkRefunded: (input) => creditsLink.markChargeRefunded(input),
          finish: (input) => refundCompensations.finish(input),
          log: (m) => console.log(`${tag} [refund-compensator] ${m}`),
        });
      },
      ...(shouldStartTeamCycleGrant()
        ? {
            team_cycle_grant: async () => {
              await createPoolGrantWriteRepository({
                getTransactionPool: getPool,
              }).grantTeamCycle();
            },
          }
        : {}),
    },
    onAlert: (alert) =>
      console.log(`${tag} schedule alert ${alert.name}: ${alert.error}`),
    log: (m) => console.log(`${tag} ${m}`),
  });

  // Graceful shutdown — wait for in-flight jobs then exit
  const shutdown = async () => {
    // Stop the timer first: the in-flight jobs waited for below are the ones
    // that matter, and a tick landing mid-shutdown has nothing left to do. One
    // handle now covers every entry in the catalog (OP-11 / workorder 43A).
    schedules.stop();
    const totalInFlight = [...inFlightByQueue.values()].reduce((n, s) => n + s.size, 0);
    console.log(`${tag} Shutting down, waiting for ${totalInFlight} in-flight jobs...`);
    running = false;
    const allTasks = [...inFlightByQueue.values()].flatMap((s) => [...s]);
    if (allTasks.length > 0) {
      await Promise.allSettled(allTasks);
    }
    await pgmq.shutdown();
    console.log(`${tag} Shutdown complete.`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const concurrencyDesc = Object.entries(JOB_TYPE_REGISTRY)
    .map(([type, config]) => `${type}=${config.concurrency(env)}`)
    .join(", ");
  console.log(
    `${tag} Started. concurrency={${concurrencyDesc}}, longPollTimeout=${pollTimeoutSeconds}s`,
  );

  while (running) {
    for (const [jobType, config] of Object.entries(JOB_TYPE_REGISTRY) as [
      BackgroundJobType,
      JobTypeConfig,
    ][]) {
      const queue = config.queue;
      try {
        const inFlight = inFlightByQueue.get(queue)!;
        const available = config.concurrency(env) - inFlight.size;
        if (available <= 0) continue;

        const messages = await pgmq.readWithPoll(
          queue,
          config.visibilityTimeoutSeconds,
          available,
          pollTimeoutSeconds,
          500,
        );

        for (const msg of messages) {
          const ctx: ExecutorContext = {
              ...baseCtx,
              queue,
              msgId: msg.msg_id,
              renewVt: async (vtSeconds: number) => {
                try { await pgmq.setVt(queue, msg.msg_id, vtSeconds); }
                catch (e) { console.warn(`[renewVt] failed for msg ${msg.msg_id}:`, e); }
              },
            };
            const task = processJobMessage(
              {
                jobService,
                billingGate,
                pgmq,
                getExecutor,
                refundJob: (jobId) => refundJob(jobId, tag),
                log: (message) => console.log(`${tag} ${message}`),
              },
              { queue, queueJobType: jobType, msg, ctx },
            )
              .catch((err) =>
                console.error(`${tag} processJobMessage crashed for msg ${msg.msg_id}:`, err),
              )
              .finally(() => inFlight.delete(task));
          inFlight.add(task);
        }
      } catch (err) {
        console.error(`${tag} Error polling ${queue}:`, err);
      }
    }
  }
}

/**
 * Per-message handling lives in `process-job-message.ts` (testable without a
 * worker). This file only wires the real collaborators into it.
 *
 * The refund of a terminally failed job lives in `features/jobs/refund-job.ts`
 * (workorder 21O) and reads its basis through `JobRefundBasisRepository`. It is
 * constructed above, beside the other repositories.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[worker] Fatal error:", err);
  process.exit(1);
});
