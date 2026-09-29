/**
 * P1-d verification, at zero cost: does the watcher emit a well-formed
 * `job.progress` for a job that already exists, and does it stop?
 *
 * Uses a real job row (read-only) and a fake ConnectionManager, so nothing is
 * generated and no credits are spent. What it cannot cover is the browser
 * actually rendering the event — that needs a real generation.
 *
 * Run: npx tsx _p1d-verify.ts
 */
import { readFileSync } from "node:fs";
import pg from "pg";

import { streamEventSchema } from "@loomic/shared";

import { watchJob } from "./src/features/jobs/job-watcher.js";
import type { JobService } from "./src/features/jobs/job-service.js";
import type { ConnectionManager } from "./src/ws/connection-manager.js";

const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env: Record<string, string> = {};
for (const line of envText.split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1).trim();
}

const problems: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL });
await client.connect();

const row = await client.query(
  `select id, job_type, status, result, started_at, completed_at, attempt_count
     from public.background_jobs
    where status = 'succeeded' and result is not null
      and started_at is not null and completed_at is not null
    order by completed_at desc nulls last
    limit 1`,
);
if (!row.rows.length) {
  console.log("no succeeded job in the database to watch; cannot verify");
  await client.end();
  process.exit(0);
}
const job = row.rows[0];
console.log(`watching real job ${job.id} (${job.job_type}, ${job.status})\n`);

// Fake WS layer: capture instead of send.
const pushed: unknown[] = [];
const fakeCm = {
  pushToUser: (_userId: string, event: unknown) => {
    pushed.push(event);
  },
  pushToCanvas: () => {},
} as unknown as ConnectionManager;

// Real-shaped job service backed by the row we just read.
const fakeJobService = {
  getJobAdmin: async () => ({
    id: job.id,
    status: job.status,
    result: job.result,
    started_at: job.started_at,
    completed_at: job.completed_at,
    attempt_count: job.attempt_count,
    error_code: null,
    error_message: null,
  }),
} as unknown as JobService;

watchJob(
  { jobService: fakeJobService, connectionManager: fakeCm },
  { jobId: job.id, userId: "user-under-test", jobType: job.job_type, pollIntervalMs: 200 },
);

// The watcher is fire-and-forget; give it a moment, then assert.
await new Promise((r) => setTimeout(r, 800));

check("emitted exactly one event for an already-terminal job", pushed.length === 1, `got ${pushed.length}`);

const event = pushed[0] as Record<string, unknown>;
const parsed = streamEventSchema.safeParse(event);
check(
  "event validates against the shared StreamEvent schema",
  parsed.success,
  parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 2)),
);
check("type is job.progress", event?.type === "job.progress", String(event?.type));
check("carries the jobId", event?.jobId === job.id);
check("carries status succeeded", event?.status === "succeeded");
check("carries the result payload so no extra request is needed", !!event?.result);
// For a terminal job this must be the actual duration, not "time since it
// started" — the first version reported ~18h for a job finished the day before.
const trueDurationMs =
  new Date(job.completed_at).getTime() - new Date(job.started_at).getTime();
check(
  "elapsedMs equals the job's real duration, not time-since-start",
  event?.elapsedMs === trueDurationMs,
  `event=${event?.elapsedMs} expected=${trueDurationMs}`,
);
check(
  "no runId (this event is not part of a run)",
  !("runId" in (event ?? {})),
);

// Must not keep polling after a terminal state.
const countAfterFirst = pushed.length;
await new Promise((r) => setTimeout(r, 700));
check(
  "stopped watching after terminal state (no further events)",
  pushed.length === countAfterFirst,
  `${countAfterFirst} -> ${pushed.length}`,
);

await client.end();
console.log(`\nTOTAL FAILURES: ${problems.length}`);
if (problems.length) process.exitCode = 1;
