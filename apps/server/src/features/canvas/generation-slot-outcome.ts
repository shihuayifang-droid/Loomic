// GN-19: what the reserved canvas slot becomes when the job stops without
// filling it.
//
// THE BEHAVIOUR THIS PINS DOWN
// The Agent image path already keeps a failed slot (34J) and the video path must
// behave the same way (GN-19: "the two chains behave the same"). The rule is the
// same for both: a job that FAILED or ran out of time leaves a slot that says why
// there is no result, while a job the USER stopped (canceled, or an aborted run)
// leaves no slot at all — the user chose to end it, so the canvas goes back to
// what it was.
//
// Kept as a pure function so the decision is testable without a canvas, a job
// service or a clock; runtime.ts only does the writing.
import { sanitizeErrorForClient } from "../../utils/error-sanitizer.js";

export type SlotOutcome =
  | { kind: "filled" }
  | { kind: "failed"; message: string; jobId: string }
  // canceled / aborted / never finished for a reason the user chose
  | { kind: "dropped" };

/** The user-facing reason a job that ran out of time leaves behind. */
export const SLOT_TIMEOUT_MESSAGE = "生成超时，请重试";

export function slotOutcomeForStop(stop:
  | { reason: "job_failed"; jobId: string; errorMessage: string | null }
  | { reason: "job_canceled"; jobId: string }
  | { reason: "timeout"; jobId: string }
  | { reason: "aborted" }
): SlotOutcome {
  if (stop.reason === "job_failed") {
    // Same sanitising as the image path: the raw provider/DB text is for the
    // server log, the slot gets a message a user can act on.
    return {
      kind: "failed",
      message: sanitizeErrorForClient(
        new Error(stop.errorMessage ?? "Job failed"),
      ),
      jobId: stop.jobId,
    };
  }

  if (stop.reason === "timeout") {
    return {
      kind: "failed",
      message: SLOT_TIMEOUT_MESSAGE,
      jobId: stop.jobId,
    };
  }

  // `job_canceled` and `aborted`: both mean the user stopped waiting.
  return { kind: "dropped" };
}
