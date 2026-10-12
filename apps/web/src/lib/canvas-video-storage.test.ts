// CV-01 (browser half): the canvas document must never hold a video URL.
//
// Three separate places can put a URL into the canvas, and each one is pinned
// here because fixing only the server would leave the other two open:
//
//   1. the browser's own insert path (`insertVideoOnCanvas`, used by the chat
//      sidebar's artifacts) — writes an `oss://` marker and keeps the URL as a
//      read-time field;
//   2. every full save (`buildSavePayload` → `stripResolvedVideoUrls`) — a PUT
//      replaces the whole document, so a read-time field left on an element is
//      stored for good;
//   3. playback (`getVideoElementSrc`, used by the renderer AND the video
//      player panel) — must prefer the projection while still playing elements
//      that were written before object keys existed.
import { describe, expect, it, vi } from "vitest";

import type { VideoArtifact } from "@loomic/shared";

import {
  getVideoElementSrc,
  insertVideoOnCanvas,
  isVideoElement,
  stripResolvedVideoUrls,
} from "./canvas-elements";
import { findGeneratorSpec } from "../components/canvas/generator-registry";

// Excalidraw is client-only and heavy; the insertion logic under test is what we
// choose to pass it, so the converter is replaced with a pass-through that adds
// the id Excalidraw would have added.
vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (skeletons: any[]) =>
    skeletons.map((skeleton, index) => ({
      ...skeleton,
      id: `el-${index}`,
      version: 1,
      versionNonce: 1,
      seed: 1,
    })),
}));

function fakeApi(existing: any[] = []) {
  const scene = { elements: [...existing] };
  const updates: any[][] = [];
  return {
    scene,
    updates,
    api: {
      getSceneElements: () => scene.elements,
      getAppState: () => ({
        scrollX: 0,
        scrollY: 0,
        width: 1000,
        height: 800,
        zoom: { value: 1 },
      }),
      updateScene: ({ elements }: { elements: any[] }) => {
        scene.elements = elements;
        updates.push(elements);
      },
    },
  };
}

const MARKER = "oss://project-assets/gen/a.mp4";

const ARTIFACT: VideoArtifact = {
  type: "video",
  url: "https://provider.test/signed/a.mp4",
  objectPath: "gen/a.mp4",
  mimeType: "video/mp4",
  width: 1280,
  height: 720,
  durationSeconds: 5,
  title: "A clip",
};

describe("CV-01 canvas video object keys", () => {
  it("case 1: an artifact with objectPath inserts an oss marker", async () => {
    const { api, scene } = fakeApi();

    await insertVideoOnCanvas(api as any, ARTIFACT);

    const element = scene.elements[0];
    expect(element.type).toBe("embeddable");
    expect(element.link).toBe(MARKER);
    expect(element.customData.isVideo).toBe(true);
    // The URL is present for this session only, as a read-time field.
    expect(element.customData.resolvedVideoUrl).toBe(ARTIFACT.url);
  });

  it("case 2: an artifact without objectPath is refused and the scene is untouched", async () => {
    const { api, scene, updates } = fakeApi();

    const artifact = { ...ARTIFACT } as VideoArtifact;
    delete (artifact as { objectPath?: string }).objectPath;

    await expect(insertVideoOnCanvas(api as any, artifact)).rejects.toThrow(
      /objectPath/,
    );

    expect(updates).toHaveLength(0);
    expect(scene.elements).toHaveLength(0);
  });

  it("case 3: a save drops the projection without mutating the live element", async () => {
    const projected = {
      type: "embeddable",
      id: "el-video",
      link: MARKER,
      customData: {
        isVideo: true,
        resolvedVideoUrl: "https://storage.test/project-assets/gen/a.mp4",
      },
    };
    const untouched = { type: "rectangle", id: "el-shape" };

    const payload = stripResolvedVideoUrls([projected, untouched]);

    expect(payload[0].customData.resolvedVideoUrl).toBeUndefined();
    expect(payload[0].customData.isVideo).toBe(true);
    expect(payload[0].link).toBe(MARKER);
    // Elements with nothing to strip are passed through by reference.
    expect(payload[1]).toBe(untouched);
    // The live scene element still carries its projection: Excalidraw owns that
    // object, and mutating it in place would corrupt the running scene.
    expect(projected.customData.resolvedVideoUrl).toBe(
      "https://storage.test/project-assets/gen/a.mp4",
    );
  });

  it("case 4: playback prefers the projection and still plays legacy URLs", () => {
    const projected = {
      link: MARKER,
      customData: {
        isVideo: true,
        resolvedVideoUrl: "https://storage.test/project-assets/gen/a.mp4",
      },
    };
    const legacy = {
      link: "https://provider.test/old.mp4",
      customData: { isVideo: true },
    };
    const unprojectedMarker = { link: MARKER, customData: { isVideo: true } };

    expect(getVideoElementSrc(projected)).toBe(
      "https://storage.test/project-assets/gen/a.mp4",
    );
    expect(getVideoElementSrc(legacy)).toBe("https://provider.test/old.mp4");
    // A marker with no projection is not playable, and returning it would hand
    // <video> a URL it can never load.
    expect(getVideoElementSrc(unprojectedMarker)).toBeUndefined();

    // The flag, not the URL shape, decides what is a video.
    expect(isVideoElement(unprojectedMarker)).toBe(true);
    expect(isVideoElement({ link: "https://example.test/page" })).toBe(false);

    // The player panel reads through the same helper, so a projected element
    // opens with a playable URL rather than the marker.
    const spec = findGeneratorSpec({ type: "embeddable", ...projected });
    expect(spec?.kind).toBe("videoPlayer");
    expect((spec?.getData({ ...projected }) as { videoUrl: string }).videoUrl).toBe(
      "https://storage.test/project-assets/gen/a.mp4",
    );
  });

  it("case 5: objectPath without a url for this session is refused (fixup3)", async () => {
    const { api, scene, updates } = fakeApi();

    // What a stored artifact whose signature could not be minted for this
    // caller looks like: identity present, projection absent.
    const artifact = { ...ARTIFACT } as Partial<VideoArtifact>;
    delete artifact.url;

    await expect(
      insertVideoOnCanvas(api as any, artifact as VideoArtifact),
    ).rejects.toThrow(/readable URL/);

    // Nothing was written: no element carrying `resolvedVideoUrl: undefined`,
    // and therefore nothing for a later save to strip. The chat keeps the
    // attachment as inaccessible until a session read signs it again.
    expect(updates).toHaveLength(0);
    expect(scene.elements).toHaveLength(0);
  });
});
