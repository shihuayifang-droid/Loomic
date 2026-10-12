// X-52 (工单14 T1): the single Agent project-asset persistence entry point.
//
// The three producers — direct image persist, `screenshot_canvas`,
// `persist_sandbox_file` — all funnel through here, so this file is where the
// ticket's ordering guarantee is pinned:
//
//   upload (user JWT) → record_project_asset (service role, canvas-derived) →
//   on metadata failure DELETE the object and throw → sign → return stable ref.
//
// Two properties are the whole point:
//   * what comes back is an IDENTITY (assetId + objectPath), not a URL, so a
//     private bucket cannot orphan the record;
//   * a failure NEVER degrades to a public URL, a provider URL or `data:` — a
//     fallback here would quietly undo X-52 from the inside.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import {
  AgentProjectAssetError,
  buildAgentObjectPath,
  createAgentProjectAssetService,
  sanitizeAgentFileName,
} from "./agent-project-assets.js";

const WORKSPACE = "ws-team";
const CANVAS = "canvas-1";
const USER = "user-1";
const TOKEN = "jwt-token";

type UploadCall = { bucket: string; path: string; bytes: number; contentType?: string };
type RemoveCall = { bucket: string; paths: string[] };
type RpcCall = { name: string; params: Record<string, unknown> };

function makeHarness(options: {
  /** `record_project_asset` failure. */
  rpcError?: { message: string } | null;
  /** Returned row for the RPC; omit the asset id to simulate a silent failure. */
  rpcData?: unknown;
  uploadError?: { message: string } | null;
  signError?: { message: string } | null;
  removeError?: { message: string } | null;
  /** Canvas read returns nothing, i.e. RLS hid it. */
  canvasHidden?: boolean;
  canvasError?: { message: string } | null;
}) {
  const uploads: UploadCall[] = [];
  const removes: RemoveCall[] = [];
  const rpcs: RpcCall[] = [];
  let signedPaths: string[] = [];

  const userClient = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table !== "canvases") return { data: null, error: null };
          if (options.canvasError) return { data: null, error: options.canvasError };
          if (options.canvasHidden) return { data: null, error: null };
          return { data: { project: { workspace_id: WORKSPACE } }, error: null };
        },
      };
      return chain;
    },
    storage: {
      from(bucket: string) {
        return {
          upload: async (
            path: string,
            buffer: { length: number },
            uploadOptions?: { contentType?: string },
          ) => {
            if (options.uploadError) return { data: null, error: options.uploadError };
            uploads.push({
              bucket,
              path,
              bytes: buffer.length,
              ...(uploadOptions?.contentType
                ? { contentType: uploadOptions.contentType }
                : {}),
            });
            return { data: { path }, error: null };
          },
          remove: async (paths: string[]) => {
            removes.push({ bucket, paths });
            return { data: null, error: options.removeError ?? null };
          },
          createSignedUrl: async (path: string) => {
            if (options.signError) return { data: null, error: options.signError };
            signedPaths.push(path);
            return {
              data: { signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig` },
              error: null,
            };
          },
        };
      },
    },
  };

  const adminClient = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcs.push({ name, params });
      if (options.rpcError) return { data: null, error: options.rpcError };
      return {
        data: options.rpcData ?? { asset_id: `asset-${rpcs.length}` },
        error: null,
      };
    },
  };

  const service = createAgentProjectAssetService({
    createUserClient: () => userClient as unknown as UserSupabaseClient,
    getAdminClient: () => adminClient as unknown as AdminSupabaseClient,
  });

  return {
    service,
    uploads,
    removes,
    rpcs,
    signedPaths: () => signedPaths,
  };
}

const PNG = Buffer.from("png-bytes", "utf-8");

function persist(
  harness: ReturnType<typeof makeHarness>,
  overrides: Partial<Parameters<ReturnType<typeof makeHarness>["service"]["persist"]>[0]> = {},
) {
  return harness.service.persist({
    accessToken: TOKEN,
    canvasId: CANVAS,
    createdBy: USER,
    content: PNG,
    mimeType: "image/png",
    fileName: "canvas-screenshot-full",
    ...overrides,
  });
}

describe("agent project asset persistence (T1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("case 1: returns the stable reference, not a bare URL", async () => {
    const h = makeHarness({});
    const result = await persist(h);

    expect(result.assetId).toBe("asset-1");
    expect(result.objectPath).toBe(h.uploads[0]?.path);
    expect(result.bucket).toBe("project-assets");
    expect(result.mimeType).toBe("image/png");
    expect(result.byteSize).toBe(PNG.length);
    // The URL is this read's projection and is present exactly alongside the
    // identity — never instead of it.
    expect(h.signedPaths()).toEqual([result.objectPath]);
    expect(result.signedUrl).toContain(result.objectPath);
  });

  it("case 2: ownership is recorded from the canvas, never from the object path", async () => {
    const h = makeHarness({});
    await persist(h);

    expect(h.rpcs).toHaveLength(1);
    expect(h.rpcs[0]?.name).toBe("record_project_asset");
    expect(h.rpcs[0]?.params).toMatchObject({
      p_bucket: "project-assets",
      p_canvas_id: CANVAS,
      p_created_by: USER,
      // No project named directly: the RPC derives it from the canvas.
      p_project_id: null,
    });
    // The key starts with the canvas-derived workspace (the Storage RLS
    // requirement) and the recorded path is the uploaded path, verbatim.
    expect(String(h.rpcs[0]?.params.p_object_path).startsWith(`${WORKSPACE}/`)).toBe(true);
    expect(h.rpcs[0]?.params.p_object_path).toBe(h.uploads[0]?.path);
    // The billing/personal workspace is nowhere in the decision.
    expect(JSON.stringify(h.rpcs[0]?.params)).not.toContain("personal");
  });

  it("case 3: a metadata failure deletes the just-uploaded object and throws", async () => {
    const h = makeHarness({ rpcError: { message: "rpc exploded" } });

    await expect(persist(h)).rejects.toBeInstanceOf(AgentProjectAssetError);
    expect(h.uploads).toHaveLength(1);
    expect(h.removes).toHaveLength(1);
    expect(h.removes[0]?.paths).toEqual([h.uploads[0]?.path]);
    // Nothing was signed, and no URL of any kind was handed back.
    expect(h.signedPaths()).toHaveLength(0);
  });

  it("case 4: an RPC that returns no asset id counts as failure, not success", async () => {
    const h = makeHarness({ rpcData: { asset_id: null } });

    await expect(persist(h)).rejects.toMatchObject({ code: "metadata_failed" });
    expect(h.removes[0]?.paths).toEqual([h.uploads[0]?.path]);
  });

  it("case 5: no canvas context is refused before anything is uploaded", async () => {
    const h = makeHarness({});

    await expect(persist(h, { canvasId: "" })).rejects.toMatchObject({
      code: "no_canvas",
    });
    expect(h.uploads).toHaveLength(0);
    expect(h.rpcs).toHaveLength(0);
  });

  it("case 6: an unreachable canvas is refused — no object is written at all", async () => {
    const h = makeHarness({ canvasHidden: true });

    await expect(persist(h)).rejects.toMatchObject({ code: "canvas_not_found" });
    expect(h.uploads).toHaveLength(0);
    expect(h.rpcs).toHaveLength(0);
  });

  it("case 7: a signing failure never degrades to a public or data URL", async () => {
    const h = makeHarness({ signError: { message: "permission denied" } });

    const error = await persist(h).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentProjectAssetError);
    expect((error as AgentProjectAssetError).code).toBe("sign_failed");
    expect(String((error as Error).message)).not.toContain("http");
    expect(String((error as Error).message)).not.toContain("data:");
  });

  it("case 8: the object key is sanitised into the workspace/canvas namespace", async () => {
    const h = makeHarness({});
    const result = await persist(h, { fileName: "../../etc/pass wd.png" });

    expect(result.objectPath.startsWith(`${WORKSPACE}/agent/${CANVAS}/`)).toBe(true);
    expect(result.objectPath).not.toContain("..");
    expect(result.objectPath).not.toContain(" ");
  });
});

describe("agent object path / name helpers", () => {
  it("keeps an extension that is already present and adds one otherwise", () => {
    const withExt = buildAgentObjectPath({
      workspaceId: "ws",
      canvasId: "c1",
      pathPrefix: "agent",
      fileName: "shot.png",
      mimeType: "image/png",
      now: 1,
      nonce: "abc",
    });
    const withoutExt = buildAgentObjectPath({
      workspaceId: "ws",
      canvasId: "c1",
      pathPrefix: "agent",
      fileName: "shot",
      mimeType: "image/webp",
      now: 1,
      nonce: "abc",
    });

    expect(withExt).toBe("ws/agent/c1/1-abc-shot.png");
    expect(withoutExt).toBe("ws/agent/c1/1-abc-shot.webp");
  });

  it("falls back to a usable name when the display name sanitises away", () => {
    expect(sanitizeAgentFileName("///")).toBe("asset");
    expect(sanitizeAgentFileName("生成图")).toBe("asset");
  });
});
