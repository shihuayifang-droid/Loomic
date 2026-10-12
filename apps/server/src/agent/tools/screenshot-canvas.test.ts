// X-52 (工单14 T1): the screenshot producer must return a STABLE reference.
//
// `screenshot_canvas` used to answer `{ screenshotUrl }` — a bare string that was
// a public URL. That is not an identity: once `project-assets` stops serving
// public objects there is nothing in the record to authorise or re-sign, so the
// screenshot in history becomes a broken image for good.
//
// The tool's JSON is now `screenshotAsset` (assetId / objectPath / mimeType, plus
// this turn's url). These cases pin the shape, and pin the deliberate absence of
// any fallback — a failed persist must yield a text-only summary, never the raw
// data URI or a public URL.
import { describe, expect, it, vi } from "vitest";

import type { ConnectionManager } from "../../ws/connection-manager.js";
import type { PersistImageFn } from "./image-generate.js";
import { createScreenshotCanvasTool } from "./screenshot-canvas.js";

const USER = "user-1";

/** The data URI the browser hands back — 1-2 MB of base64 in the real thing. */
const DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

function makeConnectionManager(): {
  connectionManager: ConnectionManager;
  rpc: ReturnType<typeof vi.fn>;
} {
  const rpc = vi.fn().mockResolvedValue({
    url: DATA_URI,
    width: 800,
    height: 600,
  } as never);
  return {
    connectionManager: { rpc } as unknown as ConnectionManager,
    rpc,
  };
}

const CONFIG = { configurable: { user_id: USER, canvas_id: "canvas-1" } };

function makePersist(
  result: Awaited<ReturnType<PersistImageFn>> | Error,
): { persistImage: PersistImageFn; calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = [];
  const persistImage = (async (sourceUrl: string, mime: string, prompt: string) => {
    calls.push([sourceUrl, mime, prompt]);
    if (result instanceof Error) throw result;
    return result;
  }) as PersistImageFn;
  return { persistImage, calls };
}

const STORED = {
  assetId: "asset-shot-1",
  bucket: "project-assets",
  objectPath: "ws-team/agent/canvas-1/1-abc-canvas-screenshot-full.png",
  mimeType: "image/png",
  byteSize: 1024,
  signedUrl:
    "https://proj.test/storage/v1/object/sign/project-assets/ws-team/agent/canvas-1/1-abc.png?token=sig",
};

describe("screenshot_canvas stable asset output (T1)", () => {
  it("case 1: answers screenshotAsset with the stable fields and this read's url", async () => {
    const { connectionManager } = makeConnectionManager();
    const { persistImage, calls } = makePersist(STORED);
    const screenshot = createScreenshotCanvasTool({
      connectionManager,
      persistImage,
    });

    const output = JSON.parse(
      String(await screenshot.invoke({ mode: "full", max_dimension: 1024 }, CONFIG)),
    ) as Record<string, any>;

    expect(output.screenshotAsset).toBeDefined();
    expect(output.screenshotAsset.assetId).toBe("asset-shot-1");
    expect(output.screenshotAsset.objectPath).toBe(STORED.objectPath);
    expect(output.screenshotAsset.mimeType).toBe("image/png");
    expect(output.screenshotAsset.url).toBe(STORED.signedUrl);

    // The old bare-string field is gone: nothing downstream may keep depending
    // on a URL as the screenshot's identity.
    expect(output.screenshotUrl).toBeUndefined();

    // Persistence was handed the screenshot's data URI, not a URL.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(DATA_URI);
    expect(calls[0]?.[2]).toBe("canvas-screenshot-full");
  });

  it("case 2: a failed persist degrades to text only — no URL, no data URI", async () => {
    const { connectionManager } = makeConnectionManager();
    const { persistImage } = makePersist(new Error("record_project_asset exploded"));
    const screenshot = createScreenshotCanvasTool({
      connectionManager,
      persistImage,
    });

    const raw = String(
      await screenshot.invoke({ mode: "viewport", max_dimension: 512 }, CONFIG),
    );
    const output = JSON.parse(raw) as Record<string, any>;

    expect(output.screenshotAsset).toBeUndefined();
    expect(output.screenshotUrl).toBeUndefined();
    // The 1-2 MB base64 must not leak into the tool message: that is what blew
    // past the model's token limit in the first place.
    expect(raw).not.toContain("data:image");
    expect(raw).not.toContain("base64");
    expect(output.summary).toContain("Canvas screenshot captured");
  });

  it("case 3: with no persistImage at all the tool still answers, text only", async () => {
    const { connectionManager } = makeConnectionManager();
    const screenshot = createScreenshotCanvasTool({ connectionManager });

    const raw = String(await screenshot.invoke({ mode: "full", max_dimension: 1024 }, CONFIG));
    const output = JSON.parse(raw) as Record<string, any>;

    expect(output.screenshotAsset).toBeUndefined();
    expect(raw).not.toContain("base64");
    expect(output.width).toBe(800);
    expect(output.height).toBe(600);
  });
});
