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
import { createPgmqClient } from "./queue/pgmq-client.js";
import { createJobService } from "./features/jobs/job-service.js";
import { createJobAttemptRepository } from "./db/job-attempt-repository.js";
import { createJobTransitionRepository } from "./db/job-transition-repository.js";
import { createJobBillingGateRepository } from "./db/job-billing-gate-repository.js";
import { createJobAdminReadRepository } from "./db/job-admin-read-repository.js";
import { DATABASE_URL_ENV_KEY, getTransactionPool } from "./db/pool.js";
import { processJobMessage } from "./features/jobs/process-job-message.js";
import { createCreditService, type CreditService } from "./features/credits/credit-service.js";
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

import type { BackgroundJobType } from "@loomic/shared";

// Register all image/video providers via shared helper (keeps parity with app.ts)
import { registerAllProviders } from "./generation/providers/register-all.js";

// 一期关闭 execute（D-24，AG-39），代码执行不走 PGMQ。
//
// Queue list, queue->type mapping, visibility timeouts and concurrency caps all
// come from JOB_TYPE_REGISTRY now; they used to be four separate tables here.

async function main() {
  const env = loadServerEnv();

  if (!env.supabaseDbUrl) {
    console.error("SUPABASE_DB_URL is required for worker process.");
    process.exit(1);
  }

  // Register all generation providers (shared with app.ts)
  registerAllProviders(env);

  const pgmq = createPgmqClient(env.supabaseDbUrl);
  const createUserClient = createUserSupabaseClientFactory(env);

  let adminClient: ReturnType<typeof createAdminSupabaseClient> | undefined;
  const getAdminClient = () => {
    adminClient ??= createAdminSupabaseClient(env);
    return adminClient;
  };

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
      getTransactionPool: () =>
        getTransactionPool(
          env.databaseUrl ? { [DATABASE_URL_ENV_KEY]: env.databaseUrl } : {},
        ),
    }),
    // ADR-0001 / workorder 21M: the four guarded status transitions the worker
    // performs on a job it is executing (`queued|retrying -> running`,
    // `running -> retrying`, `running -> succeeded`, `* -> failed`). Built here,
    // lazily and against the same `DATABASE_URL` as the attempt counter above.
    // With no reachable pool each transition fails closed and
    // `processJobMessage` treats it as a failure instead of assuming the row
    // moved — nothing here can reach the update this replaces.
    jobTransitionRepository: createJobTransitionRepository({
      getTransactionPool: () =>
        getTransactionPool(
          env.databaseUrl ? { [DATABASE_URL_ENV_KEY]: env.databaseUrl } : {},
        ),
    }),
    // ADR-0001 / workorder 21N: the admin single-row read both generation
    // executors now share. Workorder 21I moved `getJobAdmin` onto this repository
    // but wired it into `app.ts` only, so without this line the worker's
    // executors call a service with nothing behind the read and every job row
    // read fails closed as `job_query_failed`. Built lazily against the same
    // `DATABASE_URL` as the repositories above.
    jobAdminReadRepository: createJobAdminReadRepository({
      getTransactionPool: () =>
        getTransactionPool(
          env.databaseUrl ? { [DATABASE_URL_ENV_KEY]: env.databaseUrl } : {},
        ),
    }),
  });
  const creditService = createCreditService({ getAdminClient });

  // ADR-0001 / workorder 21H1: the billing gate the worker runs before it
  // consumes an attempt or calls a model. Built here, lazily, exactly like the
  // attempt repository above and against the same `DATABASE_URL`. With no
  // reachable pool the READ fails, `processJobMessage` leaves the message for a
  // later retry and the job is never executed unbilled — there is no fallback
  // that could reach PostgREST or skip the gate.
  const billingGate = createJobBillingGateRepository({
    getTransactionPool: () =>
      getTransactionPool(
        env.databaseUrl ? { [DATABASE_URL_ENV_KEY]: env.databaseUrl } : {},
      ),
  });

  // Base context — per-message fields (queue, msgId, renewVt) are added per message below
  const baseCtx = {
    jobService,
    pgmq,
    getAdminClient,
    env,
  };

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

  // Graceful shutdown — wait for in-flight jobs then exit
  const shutdown = async () => {
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
                refundJob: (jobId) => refundJob(jobId, ctx, creditService, tag),
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
 */

/**
 * Refund credits for a terminally failed job if credits were deducted.
 * Only terminally failed jobs get refunds — not cancelled jobs.
 */
async function refundJob(
  jobId: string,
  ctx: ExecutorContext,
  creditService: CreditService,
  tag: string,
) {
  try {
    const admin = ctx.getAdminClient();
    const { data: jobRow } = await admin
      .from("background_jobs")
      .select("credits_cost, workspace_id, created_by")
      .eq("id", jobId)
      .single();

    if (!jobRow) return;

    const creditsCost = jobRow.credits_cost ?? 0;
    const workspaceId = jobRow.workspace_id;
    const createdBy = jobRow.created_by;

    if (creditsCost <= 0 || !workspaceId || !createdBy) return;

    const txId = await creditService.refundCredits(
      workspaceId,
      createdBy,
      creditsCost,
      jobId,
      "Auto-refund: job failed",
    );
    console.log(`${tag} Refunded ${creditsCost} credits for job ${jobId} (tx: ${txId})`);
  } catch (refundErr) {
    // Log but don't crash the worker — the job is already dead-lettered
    console.error(`${tag} Failed to refund credits for job ${jobId}:`, refundErr);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[worker] Fatal error:", err);
  process.exit(1);
});
