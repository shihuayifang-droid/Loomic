/**
 * P1-b parity check: every value the five deleted tables produced must still
 * come out of JOB_TYPE_REGISTRY unchanged.
 *
 * The tables were copied by hand into the registry, and "I copied them right" is
 * not evidence. The expected values below are transcribed from the pre-refactor
 * source (job-service.ts QUEUE_MAP, worker.ts QUEUES / QUEUE_TO_TYPE /
 * VT_BY_QUEUE / CONCURRENCY_BY_QUEUE) and compared against the derived helpers.
 *
 * Run: npx tsx _job-registry-parity.ts
 */
import {
  JOB_QUEUES,
  JOB_TYPE_REGISTRY,
  configForQueue,
  jobTypeForQueue,
  queueForJobType,
} from "./src/features/jobs/job-registry.js";
import type { ServerEnv } from "./src/config/env.js";

// Old tables, verbatim from before the refactor.
const OLD_QUEUE_MAP = {
  image_generation: "image_generation_jobs",
  video_generation: "video_generation_jobs",
} as const;

const OLD_QUEUES = ["image_generation_jobs", "video_generation_jobs"] as const;

// 45-series tool execution introduced a THIRD queue. It is a real production
// queue (JOB_TYPE_REGISTRY.tool_execution in
// src/features/jobs/job-registry.ts, the executor in
// src/features/jobs/executors/tool-execution.ts, enqueued by src/http/tools.ts)
// and it has no counterpart in the pre-refactor tables above, so it is appended
// to the expected poll order instead of being edited into `OLD_QUEUES` (which
// stays the verbatim two-queue list). Order still matters: it is the poll order.
const ADDED_QUEUES = ["tool_execution_jobs"] as const;

const EXPECTED_QUEUES = [...OLD_QUEUES, ...ADDED_QUEUES];

const OLD_QUEUE_TO_TYPE = {
  image_generation_jobs: "image_generation",
  video_generation_jobs: "video_generation",
} as const;

const OLD_VT_BY_QUEUE = {
  image_generation_jobs: 120,
  video_generation_jobs: 300,
} as const;

// worker.ts built this from env at startup.
function oldConcurrency(env: ServerEnv): Record<string, number> {
  return {
    image_generation_jobs: env.workerImageConcurrency ?? 3,
    video_generation_jobs: env.workerVideoConcurrency ?? 2,
  };
}

const problems: string[] = [];
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${a}${ok ? "" : `  expected ${e}`}`);
  if (!ok) problems.push(`${label}: got ${a}, expected ${e}`);
}

console.log("queueForJobType vs QUEUE_MAP:");
for (const [type, queue] of Object.entries(OLD_QUEUE_MAP)) {
  check(type, queueForJobType(type as keyof typeof OLD_QUEUE_MAP), queue);
}

console.log("\nJOB_QUEUES vs QUEUES + the third queue added after the refactor (order matters -- poll order):");
check("queue list", [...JOB_QUEUES], [...EXPECTED_QUEUES]);

console.log("\njobTypeForQueue vs QUEUE_TO_TYPE:");
for (const [queue, type] of Object.entries(OLD_QUEUE_TO_TYPE)) {
  check(queue, jobTypeForQueue(queue), type);
}

console.log("\nvisibilityTimeoutSeconds vs VT_BY_QUEUE:");
for (const [queue, vt] of Object.entries(OLD_VT_BY_QUEUE)) {
  check(queue, configForQueue(queue)?.visibilityTimeoutSeconds, vt);
}

// Both branches of the ?? default: env values absent, then present.
for (const env of [
  {} as ServerEnv,
  { workerImageConcurrency: 7, workerVideoConcurrency: 9 } as ServerEnv,
]) {
  const label = Object.keys(env).length ? "env set" : "env empty (defaults)";
  console.log(`\nconcurrency vs CONCURRENCY_BY_QUEUE (${label}):`);
  const old = oldConcurrency(env);
  for (const [queue, expected] of Object.entries(old)) {
    check(queue, configForQueue(queue)?.concurrency(env), expected);
  }
}

console.log("\nunknown queue must resolve to undefined, not a wrong default:");
check("jobTypeForQueue('nope')", jobTypeForQueue("nope"), undefined);
check("configForQueue('nope')", configForQueue("nope"), undefined);

console.log(`\nregistry entries: ${Object.keys(JOB_TYPE_REGISTRY).length}`);
console.log(`TOTAL MISMATCHES: ${problems.length}`);
for (const p of problems) console.log(`  ! ${p}`);
if (problems.length) process.exitCode = 1;
