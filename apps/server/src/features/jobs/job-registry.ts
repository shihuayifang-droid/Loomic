// Single source of truth for the queue topology of each background job type.
//
// WHY THIS EXISTS
// Adding a job type used to mean editing five unrelated tables, three of them
// keyed by queue name rather than job type:
//
//   job-service.ts  QUEUE_MAP            job type  -> queue
//   worker.ts       QUEUES               list of queues to poll
//   worker.ts       QUEUE_TO_TYPE        queue -> job type   (inverse of QUEUE_MAP)
//   worker.ts       VT_BY_QUEUE          queue -> visibility timeout
//   worker.ts       CONCURRENCY_BY_QUEUE queue -> concurrency cap
//
// Nothing tied them together. Miss QUEUES and the type is enqueued but never
// polled; miss VT_BY_QUEUE and it silently gets the 120s image default, which
// for a 300s+ video means the message reappears mid-generation and the job runs
// twice.
//
// `satisfies Record<BackgroundJobType, JobTypeConfig>` makes a missing entry a
// compile error instead.
//
// NOT here on purpose:
//   - executors. They stay on the side-effect registry in job-executor.ts so
//     only the worker pulls in provider SDKs; a static reference here would drag
//     all of them into the API process too.
//   - cost functions. tier-guard.calculateCreditCost already dispatches on job
//     type and withBilling is the only caller, so moving it would be churn.
import type { BackgroundJobType } from "@loomic/shared";

import type { ServerEnv } from "../../config/env.js";

export interface JobTypeConfig {
  /** PGMQ queue this job type is enqueued on and polled from. */
  queue: string;
  /**
   * How long a claimed message stays invisible. Must exceed the worst-case
   * execution time, or the message reappears while the executor is still
   * running and the work is done twice. Executors can extend it via
   * `ctx.renewVt`.
   */
  visibilityTimeoutSeconds: number;
  /** Max messages of this type processed concurrently by one worker. */
  concurrency: (env: ServerEnv) => number;
}

export const JOB_TYPE_REGISTRY = {
  image_generation: {
    queue: "image_generation_jobs",
    visibilityTimeoutSeconds: 120,
    concurrency: (env) => env.workerImageConcurrency ?? 3,
  },
  video_generation: {
    queue: "video_generation_jobs",
    // Google Vertex Veo runs 300-500s; executors renew VT while working.
    visibilityTimeoutSeconds: 300,
    concurrency: (env) => env.workerVideoConcurrency ?? 2,
  },
} as const satisfies Record<BackgroundJobType, JobTypeConfig>;

/** Every queue the worker should poll, derived from the registry. */
export const JOB_QUEUES: readonly string[] = Object.values(JOB_TYPE_REGISTRY).map(
  (c) => c.queue,
);

const TYPE_BY_QUEUE = new Map<string, BackgroundJobType>(
  (Object.entries(JOB_TYPE_REGISTRY) as [BackgroundJobType, JobTypeConfig][]).map(
    ([type, config]) => [config.queue, type],
  ),
);

export function jobTypeForQueue(queue: string): BackgroundJobType | undefined {
  return TYPE_BY_QUEUE.get(queue);
}

export function configForQueue(queue: string): JobTypeConfig | undefined {
  const type = TYPE_BY_QUEUE.get(queue);
  return type ? JOB_TYPE_REGISTRY[type] : undefined;
}

export function queueForJobType(jobType: BackgroundJobType): string {
  return JOB_TYPE_REGISTRY[jobType].queue;
}
