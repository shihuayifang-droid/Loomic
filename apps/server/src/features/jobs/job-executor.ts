import type { BackgroundJobType } from "@loomic/shared";

import type { JobService } from "./job-service.js";
import type { PgmqClient } from "../../queue/pgmq-client.js";
import type { ServerEnv } from "../../config/env.js";
import type { CreditReadRepository } from "../../db/credit-read-repository.js";
import type { AssetProvenanceRepository } from "../../db/asset-provenance-repository.js";
import type { AssetReadRepository } from "../../db/asset-read-repository.js";
import type { AssetRecordRepository } from "../../db/asset-record-repository.js";
import type { SpendGuard } from "../../generation/spend-guard.js";
import type { ObjectStore } from "../storage/object-store.js";

export type ExecutorContext = {
  jobService: JobService;
  pgmq: PgmqClient;
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
  /**
   * GN-11: writes provenance (source, operation, model, prompt, job id) onto the
   * asset row the image / video executors just registered. The worker wires the
   * real repository in; every other construction site (and every test
   * substitute) may leave it out. An absent repository is NOT an error — the
   * executor simply skips provenance.
   */
  assetProvenanceRepository?: Pick<AssetProvenanceRepository, "recordProvenance">;
  /**
   * ED-00j: the read ACL the tool executor resolves an input artifact through.
   * The worker wires the real repository in; every other construction site (and
   * every test substitute) may leave it out. The tool executor treats an absent
   * repository as an error rather than reading the object some other way.
   */
  assetReadRepository?: Pick<AssetReadRepository, "findReadableAsset">;
  /**
   * 44I onward: the image / tool / video executors record the ownership of the
   * output they produce through this. The worker wires the real repository in;
   * every other construction site (and every test substitute) may leave it out.
   * An absent repository is treated by the executors as a failed record.
   */
  assetRecordRepository?: Pick<AssetRecordRepository, "recordProjectAsset">;
  /**
   * OP-03 / T-133: the object store the executors write their output through.
   * Same policy as the repositories above — the worker wires the real store in,
   * every other construction site and every test substitute may leave it out.
   * Absent is NOT an error, and this field being optional keeps every existing
   * construction site compiling untouched.
   */
  objectStore?: ObjectStore;
  /**
   * GN-11: the amount this job was charged, as the worker read it from the
   * billing gate (`credits_cost`). The executors copy it into provenance.
   * Optional: absent means "unknown", and the executors then record null.
   */
  creditsCharged?: number;
  /**
   * QA-15 (workorder 45DX): the credit guard for THIS task.
   *
   * `processJobMessage` creates one guard per task execution
   * (`createSpendGuard({ limit: TASK_CREDIT_LIMIT })`) and hands it in here, so
   * an executor can refuse a billable upstream call before it is made and report
   * it afterwards (`runBillableStep` in `generation/task-spend.ts` does both).
   * Optional for the same reason as the repositories above: the worker and this
   * one runner wire it, while every other construction site and every test
   * substitute stays valid. Absent means "no per-task budget in this context",
   * and the executor then runs its single step unguarded rather than guessing a
   * budget of its own.
   */
  spendGuard?: SpendGuard;
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
