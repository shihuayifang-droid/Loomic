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
import { replaceCanvasContent } from "./canvas-version.js";
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
