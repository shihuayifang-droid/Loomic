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
  createRepositoryCanvasStore: vi.fn(() => ({})),
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
import { ObjectStoreError } from "../storage/object-store.js";
import type { ObjectStore } from "../storage/object-store.js";

const USER = {
  id: "user-1",
  accessToken: "token",
  email: "a@t",
  userMetadata: {},
} as AuthenticatedUser;

// canvas-version is mocked in this file, so the content does not matter; the
// service only needs a repository to be present.
const fakeContentRepository = {
  async readCanvasRow() {
    return null;
  },
  async writeIfUnchanged() {
    return null;
  },
};

const WORKSPACE = "ws-team";
const PROJECT = "project-1";

/**
 * 45AJ: the read-path fixtures below never upload — the service builds its store
 * only on the SAVE path, and every case using this factory reads a canvas. It is
 * required by the service's options, so it is supplied here and throws rather than
 * answering a stub: an upload creeping into these cases must fail loudly instead
 * of passing against a store that silently does nothing.
 */
const noObjectStoreOnTheReadPath = (): ObjectStore => {
  throw new Error("the canvas read path must not build an object store");
};

const PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type RecordCall = {
  bucket: string;
  objectPath: string;
  createdBy: string;
  fallbackWorkspaceId: string;
  projectId?: string | null;
  canvasId?: string | null;
  mimeType?: string | null;
  byteSize?: number | null;
};

function makeStubs(options: {
  recordError?: Error | null;
  /** Omit the asset record repository entirely. */
  withoutRepository?: boolean;
  uploadError?: { message: string } | null;
  /** Omit the canvas read repository entirely (workspace cannot be resolved). */
  withoutCanvasReadRepository?: boolean;
  /** The canvas read repository answers null (canvas not readable by the actor). */
  canvasLinkNull?: boolean;
  /** Distinguishes cases: resolveWorkspaceId caches per canvas id. */
  canvasId: string;
}) {
  const records: RecordCall[] = [];
  const uploads: Array<{ bucket: string; path: string; bytes: number }> = [];
  // 45AJ: the clients the injected store factory was handed. Recorded so "the
  // store is built from the caller's OWN client, never the admin's" is observable
  // instead of assumed.
  const storeClients: UserSupabaseClient[] = [];

  const userClient = {
    storage: {
      // 45AJ: the save path writes through the injected `ObjectStore` now, so the
      // user client is only reached for signatures. `upload` is deliberately gone:
      // a regression back to the raw SDK would then fail loudly instead of working
      // around the factory through this stub.
      from(bucket: string) {
        return {
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        };
      },
    },
  };

  // 45AJ / T-133 (4th slice): a FAKE STORE the injected factory answers with — the
  // same shape brand-kit (45AH) and uploads (45AI) use in their tests. Replacing
  // the fake user client + real adapter pair with this keeps every assertion's
  // meaning: it records the same bucket / key / byte count, and a failure is
  // raised as the `ObjectStoreError` the adapter would have produced.
  const objectStore: ObjectStore = {
    async put(ref, body) {
      if (options.uploadError) {
        throw new ObjectStoreError("backend_failed", options.uploadError.message);
      }
      uploads.push({ bucket: ref.bucket, path: ref.key, bytes: body.length });
    },
    async get() {
      throw new Error("the canvas save path must not read an object");
    },
    async head() {
      throw new Error("the canvas save path must not head an object");
    },
    async delete() {
      throw new Error("the canvas save path must not delete an object");
    },
    async copy() {
      throw new Error("the canvas save path must not copy an object");
    },
    async signedReadUrl() {
      throw new Error("the canvas save path must not sign a read URL");
    },
    async signedReadUrls() {
      throw new Error("the canvas save path must not sign read URLs");
    },
  };

  const createObjectStore = (client: UserSupabaseClient): ObjectStore => {
    storeClients.push(client);
    return objectStore;
  };

  const assetRecordRepository = {
    async recordProjectAsset(input: RecordCall) {
      records.push({ ...input });
      if (options.recordError) throw options.recordError;
      return {
        assetId: `asset-${records.length}`,
        workspaceId: WORKSPACE,
        projectId: null,
      };
    },
  };

  const canvasLinkCalls: Array<{ actorId: string; canvasId: string }> = [];
  const canvasReadRepository = {
    async findReadableCanvasProjectLink(input: {
      actorId: string;
      canvasId: string;
    }) {
      canvasLinkCalls.push({ ...input });
      if (options.canvasLinkNull) return null;
      return {
        project_id: PROJECT,
        workspace_id: WORKSPACE,
        brand_kit_id: null,
      };
    },
  };

  const service = createCanvasService({
    createUserClient: () => userClient as unknown as UserSupabaseClient,
    createObjectStore,
    canvasContentRepository: fakeContentRepository,
    ...(options.withoutRepository ? {} : { assetRecordRepository }),
    ...(options.withoutCanvasReadRepository
      ? {}
      : {
          canvasReadRepository:
            canvasReadRepository as unknown as CanvasReadRepository,
        }),
  });

  return {
    service,
    records,
    uploads,
    storeClients,
    userClient: userClient as unknown as UserSupabaseClient,
    canvasLinkCalls,
    canvasId: options.canvasId,
  };
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
    // 45AJ: the bytes went through the store the injected factory built, and the
    // factory was handed the caller's OWN user client — that is what keeps the
    // upload inside the saver's RLS.
    expect(stub.storeClients).toEqual([stub.userClient]);
    expect(stub.records).toHaveLength(1);
    expect(stub.records[0]).toMatchObject({
      bucket: "project-assets",
      canvasId: "canvas-a",
      projectId: null,
      createdBy: "user-1",
      fallbackWorkspaceId: WORKSPACE,
    });
    expect(stub.records[0]?.objectPath).toBe(stub.uploads[0]?.path);

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
    expect(stub.records).toHaveLength(0);
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
    expect(stub.records).toHaveLength(2);
    expect(stub.records.map((call) => call.canvasId)).toEqual([
      "canvas-c",
      "canvas-c",
    ]);
  });

  it("case 4: a metadata failure keeps the base64 and writes no marker", async () => {
    const stub = makeStubs({ canvasId: "canvas-d", recordError: new Error("record exploded") });
    const content = contentWithFiles({
      "file-1": { id: "file-1", dataURL: PNG_BASE64 },
    });

    await stub.service.saveCanvasContent(USER, "canvas-d", content, 1);

    // The upload happened, but the canvas keeps its data — so the next save
    // retries both the upload (upsert) and the record (idempotent on the key).
    expect(stub.uploads).toHaveLength(1);
    expect(stub.records).toHaveLength(1);
    const files = savedFiles();
    expect(files["file-1"]?.dataURL).toBe(PNG_BASE64);
    expect(files["file-1"]?.dataURL).not.toMatch(/^oss:\/\//);
  });

  it("case 4b: without a repository the base64 is kept and nothing throws", async () => {
    const stub = makeStubs({ canvasId: "canvas-d2", withoutRepository: true });
    const content = contentWithFiles({
      "file-1": { id: "file-1", dataURL: PNG_BASE64 },
    });

    await expect(
      stub.service.saveCanvasContent(USER, "canvas-d2", content, 1),
    ).resolves.toEqual({ version: 2 });

    expect(stub.uploads).toHaveLength(1);
    expect(stub.records).toHaveLength(0);
    const files = savedFiles();
    expect(files["file-1"]?.dataURL).toBe(PNG_BASE64);
  });

  it("case 5: a failed upload is still left as base64 and never recorded", async () => {
    const stub = makeStubs({ canvasId: "canvas-e", uploadError: { message: "denied" } });
    const content = contentWithFiles({
      "file-1": { id: "file-1", dataURL: PNG_BASE64 },
    });

    await stub.service.saveCanvasContent(USER, "canvas-e", content, 1);

    expect(stub.records).toHaveLength(0);
    const files = savedFiles();
    expect(files["file-1"]?.dataURL).toBe(PNG_BASE64);
  });

  it("case 7: a canvas the repository cannot resolve keeps base64 and uploads nothing", async () => {
    const stub = makeStubs({ canvasId: "canvas-g", canvasLinkNull: true });
    const content = contentWithFiles({
      "file-1": { id: "file-1", dataURL: PNG_BASE64 },
    });

    await stub.service.saveCanvasContent(USER, "canvas-g", content, 1);

    expect(stub.canvasLinkCalls).toEqual([
      { actorId: "user-1", canvasId: "canvas-g" },
    ]);
    expect(stub.uploads).toHaveLength(0);
    expect(stub.records).toHaveLength(0);
    const files = savedFiles();
    expect(files["file-1"]?.dataURL).toBe(PNG_BASE64);
  });

  it("case 8: without a canvas read repository base64 is kept and nothing is uploaded", async () => {
    const stub = makeStubs({
      canvasId: "canvas-h",
      withoutCanvasReadRepository: true,
    });
    const content = contentWithFiles({
      "file-1": { id: "file-1", dataURL: PNG_BASE64 },
    });

    await stub.service.saveCanvasContent(USER, "canvas-h", content, 1);

    expect(stub.uploads).toHaveLength(0);
    expect(stub.records).toHaveLength(0);
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
    expect(stub.records).toHaveLength(0);
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
  /** Object paths the storage API was asked to sign (45D). */
  signed: string[];
};

function makeReadStub(options: {
  /** What the repository answers, or the failure it raises instead. */
  rows?: Array<{ id: string; bucket: string; object_path: string }>;
  repositoryError?: Error | null;
  /** The workspace lookup (findReadableCanvasProjectLink) fails (45D). */
  workspaceError?: Error | null;
  /** Omit the repository entirely, to pin the degraded path. */
  withoutRepository?: boolean;
  files: Record<string, unknown>;
}): ReadStub {
  const calls: Array<{ actorId: string; canvasId: string; refs: AssetRef[] }> = [];
  const signed: string[] = [];

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
          createSignedUrl: async (path: string) => (signed.push(path), {
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
    // 45D: the canvas's own workspace is the second admissible source for a
    // marker's path, next to the asset rows.
    async findReadableCanvasProjectLink() {
      if (options.workspaceError) throw options.workspaceError;
      return { project_id: PROJECT, workspace_id: WORKSPACE, brand_kit_id: null };
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
    createObjectStore: noObjectStoreOnTheReadPath,
    canvasContentRepository: fakeContentRepository,
    getAdminClient: () =>
      ({ rpc: async () => ({ data: null, error: null }) }) as unknown as AdminSupabaseClient,
    ...(options.withoutRepository
      ? {}
      : { canvasReadRepository: repository as unknown as CanvasReadRepository }),
  });

  return { service, calls, signed };
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

// ---------------------------------------------------------------------------
// 45D: a marker is signed only if the canvas's project owns the object (asset
// row) or its path sits under the canvas's workspace id. fs storage has no RLS,
// so this server-side check is the only thing between a hand-written marker and
// a readable foreign object.
// ---------------------------------------------------------------------------
describe("canvas read signs only owned markers (45D)", () => {
  it("case 1: a foreign-workspace image marker with no asset row is neither signed nor resolved", async () => {
    const foreign = "ws-other/canvas-1/secret.png";
    const stub = makeReadStub({
      files: {
        "el-foreign": {
          id: "el-foreign",
          dataURL: `oss://project-assets/${foreign}`,
          mimeType: "image/png",
        },
      },
      rows: [],
    });

    const result = await stub.service.getCanvas(USER, "canvas-1");
    const file = readFiles(result)["el-foreign"];

    expect(stub.signed).not.toContain(foreign);
    expect(stub.signed).toHaveLength(0);
    expect(file?.dataURL).toBe(`oss://project-assets/${foreign}`);
    expect(file?.storageUrl).toBeUndefined();
    expect(file?.storageUrlOriginal).toBeUndefined();
    expect(file?.assetId).toBeUndefined();
  });

  it("case 3: an asset row makes the marker signable even outside the workspace prefix", async () => {
    const path = "legacy-root/pic.png";
    const stub = makeReadStub({
      files: {
        "el-1": { id: "el-1", dataURL: `oss://project-assets/${path}`, mimeType: "image/png" },
      },
      rows: [{ id: "asset-legacy", bucket: "project-assets", object_path: path }],
    });

    const result = await stub.service.getCanvas(USER, "canvas-1");
    const file = readFiles(result)["el-1"];

    expect(stub.signed).toContain(path);
    expect(String(file?.storageUrl)).toContain("token=sig");
    expect(file?.assetId).toBe("asset-legacy");
  });

  it("case 4: a path under the workspace prefix is signed without an asset row", async () => {
    const path = "ws-team/canvas-files/canvas-1/file-9.png";
    const stub = makeReadStub({
      files: {
        "el-1": { id: "el-1", dataURL: `oss://project-assets/${path}`, mimeType: "image/png" },
      },
      rows: [],
    });

    const result = await stub.service.getCanvas(USER, "canvas-1");
    const file = readFiles(result)["el-1"];

    expect(stub.signed).toContain(path);
    expect(String(file?.storageUrl)).toContain("token=sig");
    expect(file?.assetId).toBeUndefined();
  });

  it("case 5: when the workspace lookup fails only the asset rows decide", async () => {
    const owned = "elsewhere/owned.png";
    const prefixed = "ws-team/canvas-files/canvas-ws-fail/prefixed.png";
    const stub = makeReadStub({
      workspaceError: new Error("workspace lookup is down"),
      files: {
        "el-owned": { id: "el-owned", dataURL: `oss://project-assets/${owned}`, mimeType: "image/png" },
        "el-prefixed": { id: "el-prefixed", dataURL: `oss://project-assets/${prefixed}`, mimeType: "image/png" },
      },
      rows: [{ id: "asset-owned", bucket: "project-assets", object_path: owned }],
    });

    // A canvas id no earlier case used: resolveWorkspaceId caches per canvas id.
    const result = await stub.service.getCanvas(USER, "canvas-ws-fail");
    const files = readFiles(result);

    expect(stub.signed).toContain(owned);
    expect(stub.signed).not.toContain(prefixed);
    expect(String(files["el-owned"]?.storageUrl)).toContain("token=sig");
    expect(files["el-prefixed"]?.storageUrl).toBeUndefined();
    expect(files["el-prefixed"]?.dataURL).toBe(`oss://project-assets/${prefixed}`);
  });
});

describe("canvas content repository is required (44V)", () => {
  it("case 1: without the content repository getCanvas answers 503 service_unavailable", async () => {
    const service = createCanvasService({
      createUserClient: () => ({}) as unknown as UserSupabaseClient,
      createObjectStore: noObjectStoreOnTheReadPath,
    });

    await expect(service.getCanvas(USER, "canvas-1")).rejects.toMatchObject({
      statusCode: 503,
      code: "service_unavailable",
    });
  });

  it("case 2: without the content repository saveCanvasContent answers 503 service_unavailable", async () => {
    const service = createCanvasService({
      createUserClient: () => ({}) as unknown as UserSupabaseClient,
      createObjectStore: noObjectStoreOnTheReadPath,
    });

    await expect(
      service.saveCanvasContent(USER, "canvas-1", contentWithFiles({}), 1),
    ).rejects.toMatchObject({ statusCode: 503, code: "service_unavailable" });
  });
});