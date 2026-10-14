// X-52 prep (T3): canvas files become project assets when they are extracted.
//
// The save path turns base64 data URLs into stored objects, and until now it did
// so without telling anyone who owned the result. That is fine while the bucket is
// public and fatal afterwards: the canvas would keep an `oss://` marker pointing
// at an object no project is authorised to read.
//
// The two properties that matter here:
//   * one record per NEW object, with the project derived from the canvas;
//   * an object that is already an `oss://` marker is NOT re-recorded (the save
//     path runs on every keystroke-sized save, so a repeat would be constant).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./canvas-version.js", () => ({
  replaceCanvasContent: vi.fn(async () => ({ version: 2 })),
  readCanvasRow: vi.fn(async () => null),
  CanvasVersionConflictError: class CanvasVersionConflictError extends Error {},
  CanvasNotFoundError: class CanvasNotFoundError extends Error {},
  CanvasUnavailableError: class CanvasUnavailableError extends Error {},
}));
import type { CanvasContent } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";
import {
  CanvasReadError,
  LIST_READABLE_CANVAS_ASSETS,
  type CanvasReadRepository,
} from "../../db/canvas-read-repository.js";
import { readCanvasRow, replaceCanvasContent } from "./canvas-version.js";
import { createCanvasService } from "./canvas-service.js";

const USER = {
  id: "user-1",
  accessToken: "token",
  email: "a@t",
  userMetadata: {},
} as AuthenticatedUser;

const WORKSPACE = "ws-team";
const PROJECT = "project-1";

const PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type RpcCall = { name: string; params: Record<string, unknown> };

function makeStubs(options: {
  rpcError?: { message: string } | null;
  uploadError?: { message: string } | null;
  /** Distinguishes cases: resolveWorkspaceId caches per canvas id. */
  canvasId: string;
}) {
  const rpcs: RpcCall[] = [];
  const uploads: Array<{ bucket: string; path: string; bytes: number }> = [];

  const userClient = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: async () => {
          if (table === "canvases") return { data: { project_id: PROJECT }, error: null };
          if (table === "projects") return { data: { workspace_id: WORKSPACE }, error: null };
          return { data: null, error: null };
        },
      };
      return chain;
    },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, buffer: { length: number }) => {
            if (options.uploadError) return { data: null, error: options.uploadError };
            uploads.push({ bucket, path, bytes: buffer.length });
            return { data: { path }, error: null };
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        };
      },
    },
  };

  const adminClient = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcs.push({ name, params });
      if (options.rpcError) return { data: null, error: options.rpcError };
      return { data: { asset_id: `asset-${rpcs.length}` }, error: null };
    },
  };

  const service = createCanvasService({
    createUserClient: () => userClient as unknown as UserSupabaseClient,
    getAdminClient: () => adminClient as unknown as AdminSupabaseClient,
  });

  return { service, rpcs, uploads, canvasId: options.canvasId };
}

function contentWithFiles(files: Record<string, unknown>): CanvasContent {
  return { elements: [], files } as unknown as CanvasContent;
}

const replaceMock = vi.mocked(replaceCanvasContent);
const readMock = vi.mocked(readCanvasRow);

/**
 * The files as they were handed to the write. `saveCanvasContent` returns the
 * version row, so the saved content is only observable on the write itself.
 */
function savedFiles(): Record<string, { dataURL?: string }> {
  const call = replaceMock.mock.calls.at(-1);
  return (call?.[2] as unknown as { files: Record<string, { dataURL?: string }> }).files;
}

beforeEach(() => {
  replaceMock.mockClear();
  // The read-path cases install their own `readCanvasRow`; clearing here (before
  // each implementation is installed) keeps a stale canvas row from leaking into
  // the save-path cases.
  readMock.mockClear();
});

describe("canvas file extraction records asset metadata", () => {
  it("case 1: a new base64 file is uploaded and recorded once", async () => {
    const stub = makeStubs({ canvasId: "canvas-a" });
    const content = contentWithFiles({
      "file-1": { id: "file-1", dataURL: PNG_BASE64 },
    });

    await stub.service.saveCanvasContent(USER, "canvas-a", content, 1);

    expect(stub.uploads).toHaveLength(1);
    expect(stub.rpcs).toHaveLength(1);
    expect(stub.rpcs[0]?.name).toBe("record_project_asset");
    expect(stub.rpcs[0]?.params).toMatchObject({
      p_bucket: "project-assets",
      p_canvas_id: "canvas-a",
      p_project_id: null,
      p_created_by: "user-1",
      p_fallback_workspace_id: WORKSPACE,
    });
    expect(stub.rpcs[0]?.params.p_object_path).toBe(stub.uploads[0]?.path);

    // The marker is written only after the metadata exists.
    const files = savedFiles();
    expect(files["file-1"]?.dataURL).toBe(
      `oss://project-assets/${stub.uploads[0]?.path}`,
    );
  });

  it("case 2: an existing oss marker is not uploaded and not recorded again", async () => {
    const stub = makeStubs({ canvasId: "canvas-b" });
    const marker = "oss://project-assets/ws-team/canvas-files/canvas-b/file-1.png";
    const content = contentWithFiles({
      "file-1": { id: "file-1", dataURL: marker },
    });

    await stub.service.saveCanvasContent(USER, "canvas-b", content, 1);

    expect(stub.uploads).toHaveLength(0);
    expect(stub.rpcs).toHaveLength(0);
    const files = savedFiles();
    expect(files["file-1"]?.dataURL).toBe(marker);
  });

  it("case 3: several new files produce one record each", async () => {
    const stub = makeStubs({ canvasId: "canvas-c" });
    const content = contentWithFiles({
      "file-1": { id: "file-1", dataURL: PNG_BASE64 },
      "file-2": { id: "file-2", dataURL: PNG_BASE64 },
      "file-3": { id: "file-3", dataURL: "oss://project-assets/ws-team/already.png" },
    });

    await stub.service.saveCanvasContent(USER, "canvas-c", content, 1);

    expect(stub.uploads).toHaveLength(2);
    expect(stub.rpcs).toHaveLength(2);
    expect(stub.rpcs.map((call) => call.params.p_canvas_id)).toEqual([
      "canvas-c",
      "canvas-c",
    ]);
  });

  it("case 4: a metadata failure keeps the base64 and writes no marker", async () => {
    const stub = makeStubs({ canvasId: "canvas-d", rpcError: { message: "rpc exploded" } });
    const content = contentWithFiles({
      "file-1": { id: "file-1", dataURL: PNG_BASE64 },
    });

    await stub.service.saveCanvasContent(USER, "canvas-d", content, 1);

    // The upload happened, but the canvas keeps its data — so the next save
    // retries both the upload (upsert) and the record (idempotent on the key).
    expect(stub.uploads).toHaveLength(1);
    const files = savedFiles();
    expect(files["file-1"]?.dataURL).toBe(PNG_BASE64);
  });

  it("case 5: a failed upload is still left as base64 and never recorded", async () => {
    const stub = makeStubs({ canvasId: "canvas-e", uploadError: { message: "denied" } });
    const content = contentWithFiles({
      "file-1": { id: "file-1", dataURL: PNG_BASE64 },
    });

    await stub.service.saveCanvasContent(USER, "canvas-e", content, 1);

    expect(stub.rpcs).toHaveLength(0);
    const files = savedFiles();
    expect(files["file-1"]?.dataURL).toBe(PNG_BASE64);
  });

  it("case 6: non-image data URLs and plain strings are left alone", async () => {
    const stub = makeStubs({ canvasId: "canvas-f" });
    const content = contentWithFiles({
      "file-1": { id: "file-1", dataURL: "https://cdn.test/legacy.png" },
      "file-2": { id: "file-2", dataURL: undefined },
    });

    await stub.service.saveCanvasContent(USER, "canvas-f", content, 1);

    expect(stub.uploads).toHaveLength(0);
    expect(stub.rpcs).toHaveLength(0);
    const files = savedFiles();
    expect(files["file-1"]?.dataURL).toBe("https://cdn.test/legacy.png");
    expect(files["file-2"]?.dataURL).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// X-52 T3: the READ projection the browser uses as the Agent's attachment
// identity — now served by the canvas read repository (workorder 20C).
//
// The canvas marker is `oss://project-assets/<objectPath>` — a path, not an id.
// The browser used to make do with the Excalidraw element id, which is an
// identity of the ELEMENT and has nothing to do with the stored object, so the
// server now reports the real `assetId` next to the file.
//
// The lookup is no longer a PostgREST read through the caller's client: the
// repository requires the object to belong to THIS canvas's project and matches
// the exact `(bucket, object_path)` pair. These cases pin the caller's half of
// that contract — the pair it asks for, the actor it names, and the fact that no
// answer at all (error, no row, no repository) can stop a canvas from loading.
//
// A file with no metadata row keeps NO assetId. Guessing one from the path is
// the "把旧URL反解为objectPath" trap: authorising against a guessed owner is worse
// than a file that cannot be attached.
// ---------------------------------------------------------------------------

type AssetRef = { bucket: string; objectPath: string };

type ReadStub = {
  service: ReturnType<typeof createCanvasService>;
  calls: Array<{ actorId: string; canvasId: string; refs: AssetRef[] }>;
};

function makeReadStub(options: {
  /** What the repository answers, or the failure it raises instead. */
  rows?: Array<{ id: string; bucket: string; object_path: string }>;
  repositoryError?: Error | null;
  /** Omit the repository entirely, to pin the degraded path. */
  withoutRepository?: boolean;
  files: Record<string, unknown>;
}): ReadStub {
  const calls: Array<{ actorId: string; canvasId: string; refs: AssetRef[] }> = [];

  const userClient = {
    // The read path reaches storage for signatures and nothing else. A
    // PostgREST table read appearing here again is exactly the regression this
    // ticket removed, so it fails the case instead of answering empty.
    from(table: string): never {
      throw new Error(`the canvas read must not query "${table}" through the client`);
    },
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (path: string) => ({
            data: {
              signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig`,
            },
            error: null,
          }),
        };
      },
    },
  };

  const repository = {
    async findReadableCanvasContent() {
      throw new Error("the canvas read must not fetch content through the repository");
    },
    async listReadableSucceededImageJobs() {
      return [];
    },
    async listReadableCanvasAssets(input: {
      actorId: string;
      canvasId: string;
      refs: readonly AssetRef[];
    }) {
      calls.push({
        actorId: input.actorId,
        canvasId: input.canvasId,
        refs: input.refs.map((ref) => ({ ...ref })),
      });
      if (options.repositoryError) throw options.repositoryError;
      return options.rows ?? [];
    },
  };

  const readContent: CanvasContent = {
    elements: [],
    files: options.files,
  } as unknown as CanvasContent;

  vi.mocked(readCanvasRow).mockImplementation(async () => ({
    id: "canvas-1",
    name: "Canvas",
    project_id: PROJECT,
    content: readContent,
    version: 3,
  }));

  const service = createCanvasService({
    createUserClient: () => userClient as unknown as UserSupabaseClient,
    getAdminClient: () =>
      ({ rpc: async () => ({ data: null, error: null }) }) as unknown as AdminSupabaseClient,
    ...(options.withoutRepository
      ? {}
      : { canvasReadRepository: repository as unknown as CanvasReadRepository }),
  });

  return { service, calls };
}

function readFiles(result: { content: CanvasContent }): Record<string, Record<string, unknown>> {
  return result.content.files as unknown as Record<string, Record<string, unknown>>;
}

describe("canvas read projects the real assetId (X-52 T3)", () => {
  it("case 1: an oss file gets its assetId from the exact (bucket, object_path) pair, for the real actor", async () => {
    const stub = makeReadStub({
      files: {
        "el-1": {
          id: "el-1",
          dataURL: "oss://project-assets/ws-team/canvas-1/pic.png",
          mimeType: "image/png",
        },
      },
      rows: [
        {
          id: "asset-real-1",
          bucket: "project-assets",
          object_path: "ws-team/canvas-1/pic.png",
        },
      ],
    });

    const result = await stub.service.getCanvas(USER, "canvas-1");
    const files = readFiles(result);

    expect(files["el-1"]?.assetId).toBe("asset-real-1");
    // Asked by canvas AND actor, by the BUCKET and the path — never by parsing
    // the marker into a project.
    expect(stub.calls).toEqual([
      {
        actorId: "user-1",
        canvasId: "canvas-1",
        refs: [{ bucket: "project-assets", objectPath: "ws-team/canvas-1/pic.png" }],
      },
    ]);
    // The marker itself is untouched: the id is a response projection only.
    expect(files["el-1"]?.dataURL).toBe(
      "oss://project-assets/ws-team/canvas-1/pic.png",
    );
  });

  it("case 2: a legacy file with no metadata row gets NO assetId", async () => {
    const stub = makeReadStub({
      files: {
        "el-legacy": {
          id: "el-legacy",
          dataURL: "oss://project-assets/ws-team/canvas-1/old.png",
          mimeType: "image/png",
        },
      },
      rows: [],
    });

    const result = await stub.service.getCanvas(USER, "canvas-1");
    const files = readFiles(result);

    expect(files["el-legacy"]?.assetId).toBeUndefined();
    // Still readable — the marker and its signed URL survive. It simply cannot be
    // sent as a persistent Agent attachment, which is the client's call to make.
    expect(files["el-legacy"]?.dataURL).toBe(
      "oss://project-assets/ws-team/canvas-1/old.png",
    );
    expect(String(files["el-legacy"]?.storageUrl)).toContain("token=sig");
  });

  it("case 3: a repository failure costs the assetId and nothing else", async () => {
    const stub = makeReadStub({
      files: {
        "el-1": {
          id: "el-1",
          dataURL: "oss://project-assets/ws-team/canvas-1/pic.png",
          mimeType: "image/png",
        },
      },
      repositoryError: new CanvasReadError(
        LIST_READABLE_CANVAS_ASSETS,
        new Error("postgres://user:secret@host/db is unreachable"),
      ),
    });

    // The canvas must still load: a failed identity lookup is one missing
    // response field, not a 404/503 on the whole document.
    const result = await stub.service.getCanvas(USER, "canvas-1");
    const files = readFiles(result);

    expect(result.id).toBe("canvas-1");
    expect(result.version).toBe(3);
    expect(files["el-1"]?.assetId).toBeUndefined();
    expect(files["el-1"]?.dataURL).toBe(
      "oss://project-assets/ws-team/canvas-1/pic.png",
    );
    expect(String(files["el-1"]?.storageUrl)).toContain("token=sig");
    expect(stub.calls).toHaveLength(1);
  });

  it("case 4: the same object path in two buckets is never mismatched", async () => {
    const path = "ws-team/canvas-1/shared.png";
    const stub = makeReadStub({
      files: {
        "el-project": {
          id: "el-project",
          dataURL: `oss://project-assets/${path}`,
          mimeType: "image/png",
        },
        "el-avatar": {
          id: "el-avatar",
          dataURL: `oss://user-avatars/${path}`,
          mimeType: "image/png",
        },
      },
      // Only the project-assets object is this canvas's asset; the identically
      // named avatar in another bucket has no row here.
      rows: [{ id: "asset-project", bucket: "project-assets", object_path: path }],
    });

    const result = await stub.service.getCanvas(USER, "canvas-1");
    const files = readFiles(result);

    expect(files["el-project"]?.assetId).toBe("asset-project");
    expect(files["el-avatar"]?.assetId).toBeUndefined();
    // Both pairs were asked for, each with its own bucket.
    expect(stub.calls[0]?.refs).toEqual([
      { bucket: "project-assets", objectPath: path },
      { bucket: "user-avatars", objectPath: path },
    ]);
  });

  it("case 5: without a repository the canvas still loads, with no assetIds", async () => {
    const stub = makeReadStub({
      files: {
        "el-1": {
          id: "el-1",
          dataURL: "oss://project-assets/ws-team/canvas-1/pic.png",
          mimeType: "image/png",
        },
      },
      withoutRepository: true,
    });

    const result = await stub.service.getCanvas(USER, "canvas-1");
    const files = readFiles(result);

    // "No identity" is a legal answer — the same one a legacy object produces.
    expect(files["el-1"]?.assetId).toBeUndefined();
    expect(files["el-1"]?.dataURL).toBe(
      "oss://project-assets/ws-team/canvas-1/pic.png",
    );
    expect(stub.calls).toHaveLength(0);
  });

  it("case 6: a marker that cannot address an object is dropped, not sent as a lookup key", async () => {
    const stub = makeReadStub({
      files: {
        "el-empty-bucket": {
          id: "el-empty-bucket",
          dataURL: "oss:///ws-team/canvas-1/pic.png",
          mimeType: "image/png",
        },
        "el-ok": {
          id: "el-ok",
          dataURL: "oss://project-assets/ws-team/canvas-1/ok.png",
          mimeType: "image/png",
        },
      },
      rows: [
        {
          id: "asset-ok",
          bucket: "project-assets",
          object_path: "ws-team/canvas-1/ok.png",
        },
      ],
    });

    const result = await stub.service.getCanvas(USER, "canvas-1");
    const files = readFiles(result);

    // One damaged marker must not take the other files' identities with it.
    expect(stub.calls[0]?.refs).toEqual([
      { bucket: "project-assets", objectPath: "ws-team/canvas-1/ok.png" },
    ]);
    expect(files["el-ok"]?.assetId).toBe("asset-ok");
    expect(files["el-empty-bucket"]?.assetId).toBeUndefined();
  });
});
