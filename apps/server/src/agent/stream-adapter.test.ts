// CV-01: the video artifact must carry the storage object key.
//
// WHY THIS IS WORTH A TEST
// Fixing only the agent runtime would not have been enough. The chat stream is a
// second, independent way a video reaches the canvas: `generate_video`'s output
// is parsed here into a VideoArtifact, and the browser inserts that artifact.
// With no `objectPath` on the artifact the browser has nothing to key on and
// would write the public URL straight back into the canvas — silently undoing
// the fix on the one path that is easiest to forget.
//
// The second case is the compatibility half: outputs recorded before CV-01 (and
// the direct-provider path that has no stored object) must still parse, or old
// conversations would stop producing artifacts at all.
import { describe, expect, it } from "vitest";

import { adaptDeepAgentStream } from "./stream-adapter.js";

/** Drive the adapter over a fixed event list and collect what it emits. */
async function collect(events: unknown[]) {
  const emitted: any[] = [];
  for await (const event of adaptDeepAgentStream({
    conversationId: "conv-1",
    runId: "run-1",
    sessionId: "session-1",
    stream: (async function* () {
      yield* events;
    })(),
  })) {
    emitted.push(event);
  }
  return emitted;
}

function videoToolEnd(output: Record<string, unknown>) {
  return {
    event: "on_tool_end",
    name: "generate_video",
    run_id: "tool-run-1",
    data: { output: JSON.stringify(output) },
  };
}

describe("CV-01 video artifact object keys", () => {
  it("keeps objectPath on the artifact and strips it from the passthrough", async () => {
    const emitted = await collect([
      videoToolEnd({
        summary: "Generated 5s video",
        videoUrl: "https://provider.test/signed/abc.mp4",
        objectPath: "gen/job-1.mp4",
        mimeType: "video/mp4",
        width: 1280,
        height: 720,
        durationSeconds: 5,
        title: "A clip",
      }),
    ]);

    const completed = emitted.find((event) => event.type === "tool.completed");
    expect(completed).toBeDefined();

    expect(completed.artifacts).toHaveLength(1);
    expect(completed.artifacts[0]).toMatchObject({
      type: "video",
      url: "https://provider.test/signed/abc.mp4",
      objectPath: "gen/job-1.mp4",
    });

    // `objectPath` belongs to the artifact; the passthrough output is for the
    // model, which must not be handed the storage key to re-persist.
    expect(completed.output?.objectPath).toBeUndefined();
    expect(completed.output?.videoUrl).toBeUndefined();
  });

  it("still parses an output with no objectPath (pre-CV-01 / direct mode)", async () => {
    const emitted = await collect([
      videoToolEnd({
        summary: "Generated 5s video",
        videoUrl: "https://provider.test/signed/abc.mp4",
        mimeType: "video/mp4",
        width: 1280,
        height: 720,
      }),
    ]);

    const completed = emitted.find((event) => event.type === "tool.completed");
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.artifacts[0].type).toBe("video");
    expect(completed.artifacts[0].objectPath).toBeUndefined();
  });
});
