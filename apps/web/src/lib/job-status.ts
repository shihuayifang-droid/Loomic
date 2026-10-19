/**
 * GN-30: the one place that answers "is this job still worth waiting on?".
 *
 * The public job status set is six values — `queued / running / retrying /
 * succeeded / failed / canceled`. Only three of them end the wait. `retrying`
 * explicitly does not: it means "this attempt failed and another one is
 * coming", so a waiter that treated it as terminal would abandon a job that is
 * still working (and still paid for).
 *
 * `dead_letter` is the legacy value the server maps to `failed` before it
 * reaches a client (`job-service.ts`); it is normalised here as well so an old
 * row or a stale socket event cannot leave a waiter spinning forever.
 *
 * WHY THIS FILE EXISTS
 * The terminal set used to be copy-pasted in `lib/await-job.ts` and
 * `hooks/use-job-fallback-polling.ts`. Both copies counted `dead_letter` as
 * terminal, and neither could tell `retrying` from `running`, so a retrying job
 * looked like a running one in the UI and like a finished one to the two
 * waiters. One definition, imported by both, is the fix.
 */
import type { BackgroundJobStatus } from "@loomic/shared";

/**
 * The only statuses that mean "stop waiting". `retrying` is deliberately not
 * in this list.
 */
export const TERMINAL_JOB_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
] as const satisfies readonly BackgroundJobStatus[];

export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

/** Legacy value, never written by the server any more; reads as `failed`. */
export const LEGACY_JOB_STATUS = "dead_letter" as const;

/**
 * Maps a legacy status onto the public one. Everything else passes through
 * untouched — this is a compatibility shim, not a state machine.
 */
export function normalizeJobStatus(status: string): string {
  return status === LEGACY_JOB_STATUS ? "failed" : status;
}

/** True for the three statuses that end the wait, after normalising legacy. */
export function isTerminalJobStatus(status: string): boolean {
  const normalized = normalizeJobStatus(status);
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(normalized);
}

/**
 * Placeholder copy for a job that failed an attempt and is being retried, e.g.
 * `重试中（2/3）`.
 *
 * Without a known `maxAttempts` the fraction would be a guess, so the label
 * drops it rather than inventing a denominator. The caller gets `重试中` and can
 * still tell the user the job is alive.
 */
export function formatRetryLabel(
  attempt?: number | null,
  maxAttempts?: number | null,
): string {
  if (!isCount(attempt) || !isCount(maxAttempts)) return "重试中";
  return `重试中（${attempt}/${maxAttempts}）`;
}

function isCount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
