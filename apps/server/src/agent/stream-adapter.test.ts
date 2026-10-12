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

// ---------------------------------------------------------------------------
// X-52 (工单14 T2): the artifact must carry the STABLE identity, and the
// passthrough output must not accumulate a second copy of the read-time URL.
//
// Two failure modes this pins, both of which only show up once the bucket is
// private: an artifact with a URL but no assetId becomes un-re-signable, and an
// `output` copy of the same URL is the version nothing ever refreshes.
// ---------------------------------------------------------------------------

const SIGNED_URL =
  "https://proj.test/storage/v1/object/sign/project-assets/ws-team/agent/c1/shot.png?token=sig";

function toolEnd(name: string, output: Record<string, unknown>) {
  return {
    event: "on_tool_end",
    name,
    run_id: `run-${name}`,
    data: { output: JSON.stringify(output) },
  };
}

function completion(emitted: any[]) {
  const completed = emitted.find((event) => event.type === "tool.completed");
  if (!completed) throw new Error("no tool.completed event was emitted");
  return completed;
}

describe("X-52 stable artifact identity", () => {
  it("case 1: screenshotAsset becomes an image artifact with assetId + objectPath", async () => {
    const emitted = await collect([
      toolEnd("screenshot_canvas", {
        summary: "Canvas screenshot captured (800x600, mode: full)",
        width: 800,
        height: 600,
        screenshotAsset: {
          assetId: "asset-shot-1",
          objectPath: "ws-team/agent/c1/shot.png",
          bucket: "project-assets",
          mimeType: "image/png",
          byteSize: 2048,
          url: SIGNED_URL,
        },
      }),
    ]);

    const completed = completion(emitted);
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.artifacts[0]).toMatchObject({
      type: "image",
      assetId: "asset-shot-1",
      objectPath: "ws-team/agent/c1/shot.png",
      url: SIGNED_URL,
    });
    // The nested asset object is consumed, not echoed into the output.
    expect(completed.output?.screenshotAsset).toBeUndefined();
  });

  it("case 2: an image job result carries assetId onto the artifact", async () => {
    const emitted = await collect([
      toolEnd("generate_image", {
        summary: "Generated image (512x512)",
        imageUrl: SIGNED_URL,
        assetId: "asset-img-1",
        objectPath: "ws-team/agent/c1/gen.png",
        mimeType: "image/png",
        width: 512,
        height: 512,
      }),
    ]);

    const completed = completion(emitted);
    expect(completed.artifacts[0]).toMatchObject({
      type: "image",
      assetId: "asset-img-1",
      objectPath: "ws-team/agent/c1/gen.png",
    });
  });

  it("case 3: a video result carries assetId next to the CV-01 objectPath", async () => {
    const emitted = await collect([
      videoToolEnd({
        summary: "Generated 5s video",
        videoUrl: SIGNED_URL,
        assetId: "asset-vid-1",
        objectPath: "ws-team/agent/c1/gen.mp4",
        mimeType: "video/mp4",
        width: 1280,
        height: 720,
      }),
    ]);

    const completed = completion(emitted);
    expect(completed.artifacts[0]).toMatchObject({
      type: "video",
      assetId: "asset-vid-1",
      objectPath: "ws-team/agent/c1/gen.mp4",
    });
  });

  it("case 4: extractOutput strips url/assetId/objectPath once an artifact was made", async () => {
    const emitted = await collect([
      toolEnd("generate_image", {
        summary: "Generated image (512x512)",
        title: "A cat",
        imageUrl: SIGNED_URL,
        assetId: "asset-img-1",
        objectPath: "ws-team/agent/c1/gen.png",
        mimeType: "image/png",
        width: 512,
        height: 512,
      }),
    ]);

    const completed = completion(emitted);
    expect(completed.output).toBeDefined();
    expect(completed.output?.imageUrl).toBeUndefined();
    expect(completed.output?.assetId).toBeUndefined();
    expect(completed.output?.objectPath).toBeUndefined();
    expect(completed.output?.url).toBeUndefined();
    // Everything that is not artifact identity survives.
    expect(completed.output?.summary).toBe("Generated image (512x512)");
  });

  it("case 5: a legacy screenshotUrl still yields an artifact, with no identity", async () => {
    const emitted = await collect([
      toolEnd("screenshot_canvas", {
        summary: "Canvas screenshot captured",
        width: 800,
        height: 600,
        screenshotUrl: SIGNED_URL,
      }),
    ]);

    const completed = completion(emitted);
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.artifacts[0]).toMatchObject({ type: "image", url: SIGNED_URL });
    expect(completed.artifacts[0].assetId).toBeUndefined();
  });

  it("case 6: with no artifact minted, the output keeps its url", async () => {
    // `persist_sandbox_file` has no placement and no image dimensions, so no
    // artifact is minted — stripping its url would leave the model with nothing.
    const emitted = await collect([
      toolEnd("persist_sandbox_file", {
        summary: "File uploaded successfully: out.png",
        assetId: "asset-file-1",
        objectPath: "ws-team/generated/c1/out.png",
        bucket: "project-assets",
        mimeType: "application/pdf",
        size: 1234,
        url: SIGNED_URL,
      }),
    ]);

    const completed = completion(emitted);
    expect(completed.artifacts).toBeUndefined();
    expect(completed.output?.assetId).toBe("asset-file-1");
    expect(completed.output?.url).toBe(SIGNED_URL);
  });
});
