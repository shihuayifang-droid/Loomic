import type { BackgroundJobType } from "@loomic/shared";

import type { JobService } from "./job-service.js";
import type { PgmqClient } from "../../queue/pgmq-client.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { ServerEnv } from "../../config/env.js";
import type { CreditReadRepository } from "../../db/credit-read-repository.js";

export type ExecutorContext = {
  jobService: JobService;
  pgmq: PgmqClient;
  getAdminClient: () => AdminSupabaseClient;
  env: ServerEnv;
  /**
   * The workspace's subscription plan, for the executors that need one — the
   * image executor decides from it whether to watermark. Deliberately OPTIONAL:
   * the worker wires the real repository in, while every other construction
   * site (and every test substitute, which is built with a cast) may leave it
   * out. An absent repository is NOT an error and NOT a reason to look the plan
   * up some other way: the caller treats it exactly like a read that failed,
   * i.e. as the free plan. See the watermark branch of the image executor for
   * why that direction is the safe one.
   */
  creditReadRepository?: Pick<CreditReadRepository, "readSubscription">;
  /** PGMQ queue name for the current job (set per-message by the worker). */
  queue: string;
  /** PGMQ message id for the current job (set per-message by the worker). */
  msgId: number;
  /**
   * Best-effort VT renewal — extends visibility timeout so the message
   * stays invisible while the executor is still working.
   * Never throws; logs on failure.
   */
  renewVt: (vtSeconds: number) => Promise<void>;
};

export type JobExecutor = (
  jobId: string,
  payload: Record<string, unknown>,
  ctx: ExecutorContext,
) => Promise<Record<string, unknown>>;

const executors = new Map<BackgroundJobType, JobExecutor>();

export function registerExecutor(jobType: BackgroundJobType, executor: JobExecutor): void {
  executors.set(jobType, executor);
}

export function getExecutor(jobType: BackgroundJobType): JobExecutor | undefined {
  return executors.get(jobType);
}
