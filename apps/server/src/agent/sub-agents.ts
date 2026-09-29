import type { SubAgent } from "deepagents";

import {
  createVideoGenerateTool,
  type SubmitVideoJobFn,
} from "./tools/video-generate.js";

/**
 * Video generation sub-agent.
 *
 * LOCAL FORK: this used to call `createVideoGenerateTool()` with no arguments.
 * That made the tool fall through to a direct provider call, which records no
 * job, deducts no credits and performs no subscription tier check -- so any
 * video routed through this sub-agent was free and unrestricted. Nothing errored
 * and nothing logged; the only visible symptom was a credit balance that did not
 * move.
 *
 * `submitVideoJob` is now required. Callers that have no job channel must not
 * create this sub-agent at all (see deep-agent.ts) -- offering no video
 * capability is correct, offering an unbilled one is not.
 */
export function createVideoSubAgent(deps: {
  submitVideoJob: SubmitVideoJobFn;
}): SubAgent {
  return {
    name: "video_generate",
    description:
      "Generate a video based on a creative description. Video generation availability depends on provider configuration.",
    systemPrompt: `You are a video generation specialist. Given a description, generate a video using the generate_video tool and return the result.

If video generation is not available or fails, clearly explain the limitation.`,
    tools: [createVideoGenerateTool({ submitVideoJob: deps.submitVideoJob })],
  };
}
