import { annotatedModelSchema, type GeneratorParam } from "@loomic/shared";
import { describe, expect, it } from "vitest";

import { GoogleVertexVideoProvider } from "../generation/providers/google-vertex-video.js";
import { GoogleVideoProvider } from "../generation/providers/google-video.js";
import {
  METASO_VIDEO_MODEL_ID,
  MetasoVideoProvider,
} from "../generation/providers/metaso-video.js";
import { ReplicateVideoProvider } from "../generation/providers/replicate-video.js";
import type { AvailableVideoModel } from "../generation/providers/registry.js";
import { toVideoModelListItem } from "./video-models.js";

/** The Replicate model whose catalogue entry allows exactly 5s and 10s. */
const FIVE_OR_TEN_MODEL_ID = "kwaivgi/kling-v2.6";

/**
 * Every video model the providers ship, in the same shape
 * `getAvailableVideoModels()` builds (model info + owning provider name).
 * Built from the provider tables instead of the registry so the test does not
 * depend on which API keys the test environment happens to have.
 */
function everyVideoModel(): AvailableVideoModel[] {
  const providers = [
    new ReplicateVideoProvider("test-token"),
    new GoogleVideoProvider("test-key"),
    new GoogleVertexVideoProvider({
      project: "test-project",
      location: "us-central1",
    }),
    new MetasoVideoProvider("test-key"),
  ];
  return providers.flatMap((p) =>
    p.models.map((m) => ({ ...m, provider: p.name })),
  );
}

function durationParam(item: ReturnType<typeof toVideoModelListItem>) {
  const [param] = item.params.params;
  if (!param) throw new Error(`model ${item.id} publishes no parameter`);
  return param as Extract<GeneratorParam, { type: "continuous" }>;
}

describe("toVideoModelListItem", () => {
  it("AG-07: a model that only allows 5s and 10s publishes exactly those values", () => {
    const model = everyVideoModel().find(
      (m) => m.id === FIVE_OR_TEN_MODEL_ID,
    );
    expect(model?.limits.allowedDurations).toEqual([5, 10]);

    const duration = durationParam(toVideoModelListItem(model!, null));
    expect(duration.type).toBe("continuous");
    expect(duration.values).toEqual([5, 10]);
    expect(duration.min).toBe(5);
    expect(duration.max).toBe(10);
    expect(duration.default).toBe(5);
  });

  it("AG-07: a model without a duration list publishes a 1..max range", () => {
    const model = {
      id: FIVE_OR_TEN_MODEL_ID,
      displayName: "Synthetic 8s model",
      description: "A model that declares no allowed duration list.",
      provider: "synthetic",
      capabilities: {
        textToVideo: true,
        imageToVideo: true,
        videoToVideo: false,
        audio: false,
      },
      limits: { maxDuration: 8, maxResolution: "1080p", maxInputImages: 1 },
    } as unknown as AvailableVideoModel;

    const duration = durationParam(toVideoModelListItem(model, null));
    expect(duration.min).toBe(1);
    expect(duration.max).toBe(8);
    expect(duration.step).toBe(1);
    expect(duration.default).toBe(5);
    expect("values" in duration).toBe(false);
    expect(duration.values).toBeUndefined();
  });

  it("AG-07: only MiniMax-style first/last frame models say so", () => {
    const items = everyVideoModel().map((m) =>
      toVideoModelListItem(m, null),
    );

    for (const item of items) {
      expect(typeof item.capabilities.firstLastFrame).toBe("boolean");
    }

    const firstLastFrameIds = items
      .filter((item) => item.capabilities.firstLastFrame)
      .map((item) => item.id)
      .sort();
    expect(firstLastFrameIds).toEqual([METASO_VIDEO_MODEL_ID]);

    const others = items.filter((item) => item.id !== METASO_VIDEO_MODEL_ID);
    expect(others.length).toBeGreaterThan(0);
    for (const item of others) {
      expect(item.capabilities.firstLastFrame).toBe(false);
    }
  });

  it("the list item parses against the shared schema", () => {
    const items = everyVideoModel().map((m) =>
      toVideoModelListItem(m, null),
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(() => annotatedModelSchema.parse(item)).not.toThrow();
    }
  });
});
