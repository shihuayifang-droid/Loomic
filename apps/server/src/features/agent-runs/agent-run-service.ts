import type { AdminSupabaseClient } from "../../supabase/admin.js";
import {
  throwIfError,
  withTransportRetry,
} from "../../supabase/transport-retry.js";
import type {
  CreateAcceptedAgentRunInput,
  UpdateAgentRunInput,
} from "./types.js";

export class AgentRunPersistenceError extends Error {
  readonly statusCode: number;
  readonly code: "application_error";

  constructor(message: string, statusCode = 500) {
    super(message);
    this.code = "application_error";
    this.statusCode = statusCode;
  }
}

export type AgentRunMetadataService = {
  createAcceptedRun(input: CreateAcceptedAgentRunInput): Promise<void>;
  updateRun(input: UpdateAgentRunInput): Promise<void>;
};

export function createAgentRunMetadataService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): AgentRunMetadataService {
  return {
    // Both writes below are wrapped in withTransportRetry because a single proxy
    // blip here does visible damage that has nothing to do with the actual work:
    // the run gets marked failed and the UI tells the user to retry, while the
    // image the run produced is already on the canvas. Observed 2026-09-15.
    //
    // Replaying is safe for both, and for a stronger reason than "the request
    // probably never arrived":
    //   createAcceptedRun  INSERT with a CALLER-SUPPLIED id. If a lost response hid
    //                      a successful insert, the replay hits the primary key and
    //                      errors with a pg code — it cannot create a second run.
    //   updateRun          UPDATE ... WHERE id = ? with a patch built from the
    //                      input only. Applying it twice equals applying it once.
    async createAcceptedRun(input) {
      try {
        await withTransportRetry("agent_runs.insert", async () =>
          throwIfError(
            await options.getAdminClient().from("agent_runs").insert({
              id: input.runId,
              model: input.model ?? null,
              session_id: input.sessionId,
              status: "accepted",
              thread_id: input.threadId,
            }),
          ),
        );
      } catch (error) {
        // Keep the driver's reason in the log. The thrown message stays generic
        // because it reaches the client.
        console.log(
          `[agent-run-service] createAcceptedRun failed runId=${input.runId} ` +
            `code=${(error as { code?: string })?.code ?? "?"} ` +
            `message=${(error as { message?: string })?.message}`,
        );
        throw new AgentRunPersistenceError("Failed to persist accepted run.");
      }
    },

    async updateRun(input) {
      const patch = {
        ...(input.completedAt ? { completed_at: input.completedAt } : {}),
        ...(input.errorCode ? { error_code: input.errorCode } : {}),
        ...(input.errorMessage ? { error_message: input.errorMessage } : {}),
        status: input.status,
      };
      try {
        await withTransportRetry("agent_runs.update", async () =>
          throwIfError(
            await options.getAdminClient()
              .from("agent_runs")
              .update(patch)
              .eq("id", input.runId),
          ),
        );
      } catch (error) {
        console.log(
          `[agent-run-service] updateRun failed runId=${input.runId} ` +
            `status=${input.status} ` +
            `code=${(error as { code?: string })?.code ?? "?"} ` +
            `message=${(error as { message?: string })?.message}`,
        );
        throw new AgentRunPersistenceError("Failed to update run metadata.");
      }
    },
  };
}
