import type { JobService } from "../features/jobs/job-service.js";
import { watchJob } from "../features/jobs/job-watcher.js";
import type { ConnectionManager } from "../ws/connection-manager.js";

/**
 * GN-30 / T-58 ③: a job the Agent submitted reports its progress to the user the
 * same way a generator-panel job does. Fire-and-forget; without a connection
 * manager there is nobody to push to, so nothing starts.
 */
export function startAgentJobProgress(
  deps: { jobService: JobService; connectionManager?: ConnectionManager | undefined },
  args: { jobId: string; userId: string; jobType: "image_generation" | "video_generation" },
  watch: typeof watchJob = watchJob,
): boolean {
  if (!deps.connectionManager) return false;
  watch(
    { jobService: deps.jobService, connectionManager: deps.connectionManager },
    { jobId: args.jobId, userId: args.userId, jobType: args.jobType },
  );
  return true;
}
