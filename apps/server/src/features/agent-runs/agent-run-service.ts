import {
  isTransportFailure,
  withTransportRetry,
} from "../../supabase/transport-retry.js";
import {
  AgentRunWriteError,
  type AgentRunWriteRepository,
} from "../../db/agent-run-write-repository.js";
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

/**
 * ADR-0001 / workorder 21G: both `agent_runs` writes now run on the pure `pg`
 * repository instead of the service-role admin client, so this service no longer
 * receives one and there is no PostgREST path left in it to fall back to.
 *
 * The repository is injectable for the same reason the other repositories are —
 * a test can hand the service its own double and observe which statement it asked
 * for — and it is OPTIONAL so that `buildApp` can be constructed without one. A
 * call made with no repository wired is a persistence failure, never a silent
 * success: see `callRepositoryWrite`, which is the only way either write is
 * issued.
 */
export function createAgentRunMetadataService(options: {
  agentRunWriteRepository?: AgentRunWriteRepository;
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
    //
    // 21G moved the statements into the repository, and the retry predicate reads
    // the DRIVER error (its `code` and `message`). A transport failure therefore
    // has to be unwrapped out of `AgentRunWriteError` before it can be replayed;
    // every other failure — a real SQL error, a duplicate key, a row that is not
    // the promised shape — stays wrapped and is NOT retried.
    async createAcceptedRun(input) {
      try {
        await withTransportRetry("agent_runs.insert", async () =>
          callRepositoryWrite(options, (repository) =>
            repository.createAcceptedRun(input),
          ),
        );
      } catch (error) {
        // Keep the driver's reason in the log. The thrown message stays generic
        // because it reaches the client.
        const reason = driverReason(error);
        console.log(
          `[agent-run-service] createAcceptedRun failed runId=${input.runId} ` +
            `code=${reason.code} ` +
            `message=${reason.message}`,
        );
        throw new AgentRunPersistenceError("Failed to persist accepted run.");
      }
    },

    async updateRun(input) {
      try {
        await withTransportRetry("agent_runs.update", async () =>
          callRepositoryWrite(options, (repository) => repository.updateRun(input)),
        );
      } catch (error) {
        const reason = driverReason(error);
        console.log(
          `[agent-run-service] updateRun failed runId=${input.runId} ` +
            `status=${input.status} ` +
            `code=${reason.code} ` +
            `message=${reason.message}`,
        );
        throw new AgentRunPersistenceError("Failed to update run metadata.");
      }
    },
  };
}

/**
 * The only way either write is issued.
 *
 * Three rules live here and nowhere else:
 *
 * - Fail closed. With no repository wired the call fails; nothing in this module
 *   can reach PostgREST, so there is no second path to fall back to and no
 *   configuration in which a missing database is silently tolerated.
 * - Unwrap a transport failure. `withTransportRetry` classifies the error it is
 *   given, and the repository's own error deliberately carries fixed text with no
 *   `code`; the driver's error rides along as `cause`, so that is what is rethrown
 *   when, and only when, the predicate recognises it. Any other failure keeps the
 *   wrapper and is therefore reported without being replayed.
 * - Do not translate. A refusal from the repository is passed through as it
 *   stands, so the caller above has exactly one error to project.
 */
async function callRepositoryWrite(
  options: { agentRunWriteRepository?: AgentRunWriteRepository },
  write: (repository: AgentRunWriteRepository) => Promise<void>,
): Promise<void> {
  const repository = options.agentRunWriteRepository;

  if (!repository) {
    throw new Error("agent run write repository is not wired");
  }

  try {
    await write(repository);
  } catch (error) {
    if (error instanceof AgentRunWriteError && isTransportFailure(error.cause)) {
      throw error.cause;
    }

    throw error;
  }
}

/**
 * The driver's own `code` and `message`, for the log line only.
 *
 * The repository's failures carry fixed text and keep the driver's error as
 * `cause`, while a transport failure that exhausted its retries is rethrown as
 * the raw driver error by `callRepositoryWrite`. Both shapes reach here, so the
 * cause is preferred when there is one and the error itself is read otherwise —
 * which is how the log line written before this migration, when the driver's
 * error WAS the thrown value, still prints the same two fields with the same
 * `?? "?"` fallback for a code the driver did not set.
 */
function driverReason(error: unknown): { code: string; message: string } {
  const thrown = error as { code?: unknown; message?: unknown; cause?: unknown };
  const source =
    typeof thrown?.cause === "object" && thrown.cause !== null
      ? (thrown.cause as { code?: unknown; message?: unknown })
      : thrown;

  const code = (source as { code?: string } | null | undefined)?.code ?? "?";
  const message = (source as { message?: string } | null | undefined)?.message;

  return { code, message: message ?? "?" };
}
