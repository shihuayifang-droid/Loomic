// CV-01: a canvas video must persist an OBJECT KEY, never a URL.
//
// THE FAILURE THIS PREVENTS
// Canvas videos used to be stored as an `embeddable` whose `link` was the
// Supabase public URL returned by the provider job. Every one of those URLs dies
// the moment the bucket stops being public (X-52), and because the URL was the
// only thing recorded, there would be nothing left to re-resolve from — the
// video would simply be gone from the canvas with no way to recover it.
//
// The four things pinned here, in order of how quietly they can regress:
//
//   1. the writer persists `oss://<bucket>/<objectPath>` and no URL at all;
//   2. a canvas READ attaches the playable URL as `customData.resolvedVideoUrl`
//      while leaving `link` as the marker (a client's next save is a FULL
//      replace, so rewriting `link` here would persist the URL permanently);
//   3. one damaged marker cannot take down the whole canvas response;
//   4. a succeeded job with no `object_path` writes NOTHING rather than falling
//      back to `signed_url`.
import { describe, expect, it } from "vitest";

import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";
import { insertVideoElementForJobResult } from "../../agent/runtime.js";
import { createCanvasService } from "./canvas-service.js";
import { insertVideoElement } from "./canvas-element-writer.js";

const USER = { accessToken: "test-token" } as AuthenticatedUser;
const CANVAS_ID = "canvas-1";
const MARKER = "oss://project-assets/gen/v1.mp4";

type CanvasContentLike = {
  elements: Array<Record<string, any>>;
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

/**
 * A canvas client good enough for both the writer and the read projection.
 *
 * The read path is `select().eq().maybeSingle()` and the write path is
 * `update().eq("id").eq("version").select().maybeSingle()` — the second `eq` is
 * the optimistic lock, so the fake honours it: a stale version matches no row
 * and the write is dropped, exactly like the real thing.
 */
function createFakeCanvasClient(initial: CanvasContentLike | null) {
  const state = {
    content: initial as CanvasContentLike | null,
    version: initial ? 3 : 0,
  };
  const writes: Array<{ content: CanvasContentLike; version: number }> = [];
  const resolvedUrls: Array<{ bucket: string; objectPath: string }> = [];
  const signedCalls: Array<{
    bucket: string;
    objectPath: string;
    expiresIn: number;
    transform: unknown;
  }> = [];

  const client = {
    from(table: string) {
      if (table !== "canvases") {
        throw new Error(`fake canvas client: unexpected table ${table}`);
      }

      let mode: "select" | "update" = "select";
      let patch: { content?: CanvasContentLike; version?: number } = {};
      const filters: Array<[string, unknown]> = [];

      const chain = {
        select: () => chain,
        update: (next: { content?: CanvasContentLike; version?: number }) => {
          mode = "update";
          patch = next;
          return chain;
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        },
        maybeSingle: async () => {
          if (state.content === null) return { data: null, error: null };

          if (mode === "select") {
            return {
              data: {
                id: CANVAS_ID,
                name: "Board",
                project_id: "project-1",
                content: state.content,
                version: state.version,
              },
              error: null,
            };
          }

          const expected = filters.find(([column]) => column === "version");
          if (expected && expected[1] !== state.version) {
            // Lost the optimistic lock — PostgREST answers with zero rows, not
            // an error. Returning data:null is what the real path sees.
            return { data: null, error: null };
          }

          state.content = patch.content ?? state.content;
          state.version = patch.version ?? state.version;
          writes.push({ content: state.content as CanvasContentLike, version: state.version });
          return { data: { version: state.version }, error: null };
        },
      };

      return chain;
    },
    storage: {
      from(bucket: string) {
        return {
          // X-52: the read-time projection signs each marker. The stub records the
          // same (bucket, objectPath) pairs the old public-URL stub did, plus the
          // transform, and returns a URL that is visibly a signature.
          createSignedUrl: async (
            objectPath: string,
            expiresIn: number,
            callOptions?: { transform?: unknown },
          ) => {
            resolvedUrls.push({ bucket, objectPath });
            signedCalls.push({ bucket, objectPath, expiresIn, transform: callOptions?.transform });
            return {
              data: {
                signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${objectPath}?token=sig`,
              },
              error: null,
            };
          },
          // Present only so that a regression to a public URL would be caught by
          // the assertions rather than silently working.
          getPublicUrl: (objectPath: string) => ({
            data: { publicUrl: `https://storage.test/${bucket}/${objectPath}` },
          }),
        };
      },
    },
  };

  return {
    client: client as unknown as UserSupabaseClient,
    writes,
    resolvedUrls,
    signedCalls,
    state,
  };
}

function emptyCanvas(): CanvasContentLike {
  return { elements: [], appState: {}, files: {} };
}

describe("CV-01 video object keys", () => {
  it("case 1: insertVideoElement persists the oss marker and no URL", async () => {
    const fake = createFakeCanvasClient(emptyCanvas());

    await insertVideoElement(fake.client, {
      canvasId: CANVAS_ID,
      objectPath: "gen/v1.mp4",
      width: 640,
      height: 360,
      mimeType: "video/mp4",
      title: "A clip",
    });

    const element = fake.state.content?.elements[0] as Record<string, any>;
    expect(element.link).toBe("oss://project-assets/gen/v1.mp4");
    expect(element.type).toBe("embeddable");
    expect(element.customData.isVideo).toBe(true);
    // No read-time URL may be persisted, and nothing else may smuggle one in.
    expect(element.customData.resolvedVideoUrl).toBeUndefined();
    expect(JSON.stringify(element)).not.toContain("http");
  });

  it("case 2: a canvas read projects the marker and keeps it", async () => {
    const fake = createFakeCanvasClient({
      ...emptyCanvas(),
      elements: [
        {
          type: "embeddable",
          id: "el-video",
          link: MARKER,
          width: 640,
          height: 360,
          customData: { isVideo: true, mimeType: "video/mp4" },
        },
      ],
    });
    // X-52 工单12: the service records asset metadata through the admin client on
    // the SAVE path; these cases read canvases, so it is never called.
    const service = createCanvasService({
      createUserClient: () => fake.client,
      getAdminClient: () => fake.client as unknown as never,
    });

    const detail = await service.getCanvas(USER, CANVAS_ID);
    const element = (detail.content as unknown as CanvasContentLike).elements[0] as Record<string, any>;
    expect(element.link).toBe(MARKER);
    // X-52: the projection is a SIGNATURE, not a public URL, and the marker in
    // `link` is still the only thing the canvas stores.
    expect(element.customData.resolvedVideoUrl).toContain("token=sig");
    expect(element.customData.resolvedVideoUrl).not.toContain("storage.test");
    expect(fake.signedCalls).toEqual([
      { bucket: "project-assets", objectPath: "gen/v1.mp4", expiresIn: 3600, transform: undefined },
    ]);
    expect(fake.resolvedUrls).toEqual([
      { bucket: "project-assets", objectPath: "gen/v1.mp4" },
    ]);
    // The read is a projection: nothing was written back.
    expect(fake.writes).toHaveLength(0);
    expect(fake.state.content?.elements[0]?.customData.resolvedVideoUrl).toBeUndefined();
  });

  it("case 2b: an image file is projected as a signed display URL plus the signed original", async () => {
    const fake = createFakeCanvasClient({
      ...emptyCanvas(),
      files: {
        "file-1": {
          id: "file-1",
          mimeType: "image/png",
          dataURL: "oss://project-assets/ws-team/canvas-files/c1/file-1.png",
        },
      },
    });
    const service = createCanvasService({
      createUserClient: () => fake.client,
      getAdminClient: () => fake.client as unknown as never,
    });

    const detail = await service.getCanvas(USER, CANVAS_ID);
    const file = (detail.content as unknown as CanvasContentLike).files["file-1"] as Record<string, any>;

    // The display projection is the 1024px transform, signed; the original stays
    // reachable and is signed too — neither is a public URL.
    expect(file.storageUrl).toContain("token=sig");
    expect(file.storageUrlOriginal).toContain("token=sig");
    expect(file.storageUrl).not.toContain("storage.test");
    expect(file.dataURL).toBe("oss://project-assets/ws-team/canvas-files/c1/file-1.png");

    expect(fake.signedCalls).toEqual([
      {
        bucket: "project-assets",
        objectPath: "ws-team/canvas-files/c1/file-1.png",
        expiresIn: 3600,
        transform: undefined,
      },
      {
        bucket: "project-assets",
        objectPath: "ws-team/canvas-files/c1/file-1.png",
        expiresIn: 3600,
        transform: { width: 1024, height: 1024, resize: "contain" },
      },
    ]);
    expect(fake.writes).toHaveLength(0);
  });

  it("case 3: non-video, legacy URL and broken markers are left alone", async () => {
    const legacy = {
      type: "embeddable",
      id: "el-legacy",
      link: "https://provider.test/old.mp4",
      customData: { isVideo: true },
    };
    const nonVideo = {
      type: "embeddable",
      id: "el-iframe",
      link: "https://example.test/watch",
      customData: {},
    };
    // Three shapes the parser cannot turn into a bucket + key. `oss://bucket/x/`
    // is deliberately NOT here: a key may legally end in "/", and the image path
    // in this same file accepts it, so rejecting it would be a new rule rather
    // than a repair.
    const emptyObjectPath = {
      type: "embeddable",
      id: "el-broken-1",
      link: "oss://project-assets/",
      customData: { isVideo: true },
    };
    const emptyBucket = {
      type: "embeddable",
      id: "el-broken-2",
      link: "oss:///gen/v1.mp4",
      customData: { isVideo: true },
    };
    const noSlash = {
      type: "embeddable",
      id: "el-broken-3",
      link: "oss://project-assets",
      customData: { isVideo: true },
    };
    const good = {
      type: "embeddable",
      id: "el-good",
      link: MARKER,
      customData: { isVideo: true },
    };

    const fake = createFakeCanvasClient({
      ...emptyCanvas(),
      elements: [legacy, nonVideo, emptyObjectPath, emptyBucket, noSlash, good],
    });
    // X-52 工单12: the service records asset metadata through the admin client on
    // the SAVE path; these cases read canvases, so it is never called.
    const service = createCanvasService({
      createUserClient: () => fake.client,
      getAdminClient: () => fake.client as unknown as never,
    });

    // The response must still arrive: a bad marker is one element's problem.
    const detail = await service.getCanvas(USER, CANVAS_ID);
    const elements = (detail.content as unknown as CanvasContentLike).elements;

    expect(elements[0]).toEqual(legacy);
    expect(elements[1]).toEqual(nonVideo);
    expect(elements[2]).toEqual(emptyObjectPath);
    expect(elements[3]).toEqual(emptyBucket);
    expect(elements[4]).toEqual(noSlash);
    expect(elements[5]?.customData.resolvedVideoUrl).toContain("token=sig");
    // Only the well-formed marker was ever handed to the storage API.
    expect(fake.resolvedUrls).toHaveLength(1);
  });

  it("case 4: a succeeded job keys the canvas element on object_path", async () => {
    const fake = createFakeCanvasClient(emptyCanvas());
    const signedUrl = "https://provider.test/signed/abc.mp4?token=xyz";

    const elementId = await insertVideoElementForJobResult({
      client: fake.client,
      canvasId: CANVAS_ID,
      jobId: "job-1",
      objectPath: "gen/job-1.mp4",
      result: {
        signed_url: signedUrl,
        object_path: "gen/job-1.mp4",
        width: 1280,
        height: 720,
        mime_type: "video/mp4",
        duration_seconds: 5,
      },
      input: {},
      prompt: "a cat",
    });

    expect(elementId).toBeTruthy();
    const element = fake.state.content?.elements[0] as Record<string, any>;
    expect(element.link).toBe("oss://project-assets/gen/job-1.mp4");
    // The signed URL is what the client may fetch with today; it must not be
    // anywhere in the stored document.
    expect(JSON.stringify(fake.state.content)).not.toContain(signedUrl);
    expect(JSON.stringify(fake.state.content)).not.toContain("provider.test");
  });

  it("case 5: a job with no object_path writes nothing at all", async () => {
    const fake = createFakeCanvasClient(emptyCanvas());

    const elementId = await insertVideoElementForJobResult({
      client: fake.client,
      canvasId: CANVAS_ID,
      jobId: "job-2",
      objectPath: undefined,
      result: { signed_url: "https://provider.test/signed/def.mp4" },
      input: {},
      prompt: "a dog",
    });

    expect(elementId).toBeUndefined();
    // No canvas write — and therefore no URL anywhere near the document.
    expect(fake.writes).toHaveLength(0);
    expect(fake.state.content?.elements).toHaveLength(0);
  });
});
