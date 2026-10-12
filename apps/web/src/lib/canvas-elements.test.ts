// 工单14 fixup3: an artifact that HAS identity (`assetId` / `objectPath`) but no
// URL for THIS read must be refused by the browser's own canvas insertion path.
// Refusing is the whole point — the alternative is an element built around
// `undefined`, which fetches `/api/proxy-image?url=undefined` (image) or leaves
// `resolvedVideoUrl: undefined` on a live element (video). Both would surface as
// broken media instead of the chat's "附件当前不可访问" state, and both would be
// signed again by a later session read anyway.
//
// The URL-present half of each path is pinned here too, so a guard that is
// merely too eager (refusing everything) cannot pass this file.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImageArtifact, VideoArtifact } from "@loomic/shared";

import { insertImageOnCanvas, insertVideoOnCanvas } from "./canvas-elements";

// Excalidraw is client-only and heavy; the insertion logic under test is what we
// choose to pass it, so the converter is replaced with a pass-through that adds
// the id Excalidraw would have added (same shape as canvas-video-storage.test.ts).
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

const IMAGE_URL = "https://storage.test/project-assets/gen/a.png";
const VIDEO_URL = "https://storage.test/project-assets/gen/a.mp4";

const IMAGE: ImageArtifact = {
  type: "image",
  url: IMAGE_URL,
  mimeType: "image/png",
  width: 512,
  height: 512,
  title: "A picture",
};

const VIDEO: VideoArtifact = {
  type: "video",
  url: VIDEO_URL,
  objectPath: "gen/a.mp4",
  mimeType: "video/mp4",
  width: 1280,
  height: 720,
  durationSeconds: 5,
  title: "A clip",
};

function fakeImageApi() {
  const scene = { elements: [] as any[] };
  const addedFiles: any[][] = [];
  const updates: any[][] = [];
  return {
    scene,
    addedFiles,
    updates,
    api: {
      addFiles: (files: any[]) => addedFiles.push(files),
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

function fakeVideoApi() {
  const scene = { elements: [] as any[] };
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

// fetchAsDataURL goes through the server proxy and then a FileReader; the point
// of these cases is WHETHER it runs at all, so the response is a minimal body.
function stubFetch() {
  const fetchMock = vi.fn(async (..._callArgs: any[]) => ({
    ok: true,
    status: 200,
    blob: async () => new Blob(["fake-bytes"], { type: "image/png" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("工单14 fixup3 canvas insertion guards", () => {
  it("case A1: an image artifact WITH a url still inserts exactly as before", async () => {
    const fetchMock = stubFetch();
    const { api, scene, addedFiles, updates } = fakeImageApi();

    await insertImageOnCanvas(api as any, IMAGE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(String(call?.[0])).toContain(encodeURIComponent(IMAGE_URL));
    expect(addedFiles).toHaveLength(1);
    const files = addedFiles[0] ?? [];
    expect(files[0]?.mimeType).toBe("image/png");
    expect(files[0]?.dataURL).toMatch(/^data:image\/png/);
    expect(updates).toHaveLength(1);
    expect(scene.elements).toHaveLength(1);
    expect(scene.elements[0].type).toBe("image");
    // The URL still travels with the element's customData.
    expect(scene.elements[0].customData.storageUrl).toBe(IMAGE_URL);
    expect(scene.elements[0].customData.title).toBe("A picture");
  });

  it("case A2: an image artifact WITHOUT a url is refused with zero fetch and zero scene writes", async () => {
    const fetchMock = stubFetch();
    const { api, scene, addedFiles, updates } = fakeImageApi();
    const artifact = { ...IMAGE } as Partial<ImageArtifact>;
    delete artifact.url;

    await expect(
      insertImageOnCanvas(api as any, artifact as ImageArtifact),
    ).rejects.toThrow(/readable URL/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(addedFiles).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(scene.elements).toHaveLength(0);
  });

  it("case A3: a stable image identity is NOT turned into a url", async () => {
    const fetchMock = stubFetch();
    const { api, scene, addedFiles } = fakeImageApi();
    const artifact = {
      ...IMAGE,
      assetId: "9f1c2b3a-0000-4000-8000-000000000001",
      objectPath: "gen/a.png",
    } as Partial<ImageArtifact>;
    delete artifact.url;

    await expect(
      insertImageOnCanvas(api as any, artifact as ImageArtifact),
    ).rejects.toThrow(/readable URL/);

    // No request was made at all — in particular none carrying the asset id,
    // the object key, or the literal string "undefined".
    expect(fetchMock).not.toHaveBeenCalled();
    expect(addedFiles).toHaveLength(0);
    expect(scene.elements).toHaveLength(0);
  });

  it("case B1: a video artifact WITH a url still inserts an oss marker", async () => {
    const { api, scene, updates } = fakeVideoApi();

    await insertVideoOnCanvas(api as any, VIDEO);

    expect(updates).toHaveLength(1);
    expect(scene.elements).toHaveLength(1);
    expect(scene.elements[0].link).toBe("oss://project-assets/gen/a.mp4");
    expect(scene.elements[0].customData.isVideo).toBe(true);
    expect(scene.elements[0].customData.resolvedVideoUrl).toBe(VIDEO_URL);
  });

  it("case B2: an artifact with objectPath but NO url is refused and the scene is untouched", async () => {
    const { api, scene, updates } = fakeVideoApi();
    const artifact = { ...VIDEO } as Partial<VideoArtifact>;
    delete artifact.url;

    await expect(
      insertVideoOnCanvas(api as any, artifact as VideoArtifact),
    ).rejects.toThrow(/readable URL/);

    expect(updates).toHaveLength(0);
    expect(scene.elements).toHaveLength(0);
  });
});
