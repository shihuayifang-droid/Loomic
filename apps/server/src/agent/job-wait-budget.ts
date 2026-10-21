/**
 * GN-31: how long the AGENT waits for a generation job before it calls the
 * generation timed out.
 *
 * THE PROBLEM THIS ENDS
 * The agent used to keep its own two constants: four minutes for an image and
 * ten minutes for a video. The worker's own budget for the same job is wider —
 * the queue's visibility timeout times the attempts the job was granted, which
 * is six minutes for an image and fifteen for a video by default. A job that
 * finished inside the worker's budget but after the agent's shorter one was
 * therefore two different things at once: the worker succeeded and charged the
 * workspace, while the agent had already shown the user a failed placeholder and
 * never put the artifact on the canvas. The user paid for work they could not
 * see.
 *
 * WHY THE MARGIN
 * The budget below bounds one ATTEMPT, and the job may retry; the message also
 * sits in the queue before the first attempt starts, and the final row write and
 * canvas insert happen after the last one. `AGENT_WAIT_MARGIN_MS` covers that
 * stretch, so the agent's wait is always strictly longer than the worker's own
 * budget: the worker is the one that decides a generation timed out (it fails the
 * job as `failed` + `timeout` and refunds), and the agent only reads that
 * verdict. The agent's timer is the last resort for a worker that died without
 * writing anything.
 *
 * WHY THE WAIT GOES THROUGH `executorTimeoutMs`
 * The server has exactly one statement of "how long this kind of job may run" and
 * it is the one the worker enforces. Deriving the agent's wait from that same
 * function means the two can no longer drift apart: a change to the job registry
 * or to the attempt budget moves both.
 */
import type { BackgroundJobType } from "@loomic/shared";

import { executorTimeoutMs } from "../features/jobs/process-job-message.js";

/** GN-31: how long the agent waits for a job — never shorter than the job's own execution budget, plus a margin for queueing and the final write. */
export const AGENT_WAIT_MARGIN_MS = 60_000;

/**
 * The agent's wait for one job, in milliseconds.
 *
 * Never shorter than `executorTimeoutMs` for the same job type and attempt
 * budget, so the worker's verdict always arrives before the agent stops waiting.
 */
export function agentWaitBudgetMs(jobType: BackgroundJobType, maxAttempts: number): number {
  return executorTimeoutMs(jobType, maxAttempts) + AGENT_WAIT_MARGIN_MS;
}
