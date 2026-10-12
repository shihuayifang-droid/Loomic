import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import {
  createPersistSandboxFileTool,
  type PersistSandboxFileDeps,
} from "./persist-sandbox-file.js";

const PATH_REJECTED = "Error: filePath must be inside the sandbox directory.";
const NO_CANVAS = /no canvas context/i;

const WORKSPACE = "ws-team";
const CANVAS = "canvas-1";
const USER = "user-1";

/**
 * A structurally valid JWT whose `sub` is the acting user. Only the payload is
 * read (the run was authenticated before the tool ran), so no signature is
 * needed here.
 */
const ACCESS_TOKEN = `header.${Buffer.from(
  JSON.stringify({ sub: USER, email: "a@t" }),
).toString("base64url")}.signature`;

const RUN_CONFIG = {
  configurable: { access_token: ACCESS_TOKEN, canvas_id: CANVAS },
};

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

type Harness = {
  deps: PersistSandboxFileDeps;
  upload: ReturnType<typeof vi.fn>;
  createSignedUrl: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  config: Record<string, unknown>;
};

function makeHarness(
  sandboxDir: string,
  overrides: {
    rpcError?: { message: string } | null;
    /** Omit the canvas id so the tool has no owner to file the object under. */
    noCanvas?: boolean;
  } = {},
): Harness {
  const upload = vi
    .fn()
    .mockResolvedValue({ data: { path: "ws-team/generated/out.png" }, error: null });
  const createSignedUrl = vi.fn().mockResolvedValue({
    data: { signedUrl: "https://proj.test/storage/v1/object/sign/out.png?token=sig" },
    error: null,
  });
  const remove = vi.fn().mockResolvedValue({ data: null, error: null });

  const client = {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: { project: { workspace_id: WORKSPACE } },
          error: null,
        }),
      };
      return chain;
    },
    storage: {
      from: vi.fn(() => ({ upload, createSignedUrl, remove })),
    },
  };

  const rpc = vi.fn().mockResolvedValue(
    overrides.rpcError
      ? { data: null, error: overrides.rpcError }
      : { data: { asset_id: "asset-1" }, error: null },
  );

  return {
    deps: {
      createUserClient: () => client as unknown as SupabaseClient,
      getAdminClient: () => ({ rpc }) as unknown as AdminSupabaseClient,
      sandboxDir,
    },
    upload,
    createSignedUrl,
    rpc,
    remove,
    config: overrides.noCanvas
      ? { configurable: { access_token: ACCESS_TOKEN } }
      : RUN_CONFIG,
  };
}

describe("persist_sandbox_file path guard", () => {
  it("case 1: /../../etc/hosts is refused and nothing is uploaded", async () => {
    const sandboxDir = makeTempDir("loomic-persist-1-");
    const { deps, upload, config } = makeHarness(sandboxDir);
    const persist = createPersistSandboxFileTool(deps);

    const result = await persist.invoke(
      { filePath: "/../../etc/hosts" },
      config,
    );

    expect(result).toBe(PATH_REJECTED);
    expect(upload).toHaveBeenCalledTimes(0);
  });

  it("case 2: a sibling directory sharing the run1 prefix is refused", async () => {
    const root = makeTempDir("loomic-persist-2-");
    const run1 = join(root, "run1");
    const run10 = join(root, "run10");
    mkdirSync(run1, { recursive: true });
    mkdirSync(run10, { recursive: true });
    writeFileSync(join(run10, "x.png"), "not-a-real-png", "utf-8");

    const { deps, upload, config } = makeHarness(run1);
    const persist = createPersistSandboxFileTool(deps);

    const result = await persist.invoke(
      { filePath: "/../run10/x.png" },
      config,
    );

    expect(result).toBe(PATH_REJECTED);
    expect(upload).toHaveBeenCalledTimes(0);
  });

  it("case 3: a file written inside the sandbox is uploaded", async () => {
    const sandboxDir = makeTempDir("loomic-persist-3-");
    writeFileSync(join(sandboxDir, "out.png"), "png-bytes", "utf-8");

    const { deps, upload, config } = makeHarness(sandboxDir);
    const persist = createPersistSandboxFileTool(deps);

    const result = await persist.invoke({ filePath: "/out.png" }, config);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(String(result)).toContain("out.png");
  });
});

// X-52 (工单14 T1): the sandbox producer must return a stable identity and must
// refuse to write an object with no owner. Both halves are load-bearing: a
// `{url, path}` response cannot be re-signed later, and an `uploads/...` key has
// no project to authorise against.
describe("persist_sandbox_file stable asset reference (T1)", () => {
  it("case 1: returns assetId/objectPath/mimeType plus this read's url", async () => {
    const sandboxDir = makeTempDir("loomic-persist-x1-");
    writeFileSync(join(sandboxDir, "out.png"), "png-bytes", "utf-8");

    const { deps, rpc, config } = makeHarness(sandboxDir);
    const persist = createPersistSandboxFileTool(deps);

    const parsed = JSON.parse(
      String(await persist.invoke({ filePath: "/out.png" }, config)),
    ) as Record<string, unknown>;

    expect(parsed.assetId).toBe("asset-1");
    expect(typeof parsed.objectPath).toBe("string");
    expect(parsed.bucket).toBe("project-assets");
    expect(parsed.mimeType).toBe("image/png");
    expect(parsed.size).toBe("png-bytes".length);
    expect(String(parsed.url)).toContain("token=sig");

    // Ownership came from the canvas, and the creator is the token's subject —
    // not a `configurable` field that could disagree with the JWT.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_canvas_id: CANVAS,
      p_created_by: USER,
      p_bucket: "project-assets",
      p_project_id: null,
    });
  });

  it("case 2: no canvas context means no upload at all", async () => {
    const sandboxDir = makeTempDir("loomic-persist-x2-");
    writeFileSync(join(sandboxDir, "out.png"), "png-bytes", "utf-8");

    const { deps, upload, rpc, config } = makeHarness(sandboxDir, {
      noCanvas: true,
    });
    const persist = createPersistSandboxFileTool(deps);

    const result = String(await persist.invoke({ filePath: "/out.png" }, config));

    // An unowned object is worse than no object: nothing is written.
    expect(result).toMatch(NO_CANVAS);
    expect(upload).toHaveBeenCalledTimes(0);
    expect(rpc).toHaveBeenCalledTimes(0);
  });

  it("case 3: a metadata failure deletes the object and reports an error", async () => {
    const sandboxDir = makeTempDir("loomic-persist-x3-");
    writeFileSync(join(sandboxDir, "out.png"), "png-bytes", "utf-8");

    const { deps, upload, remove, config } = makeHarness(sandboxDir, {
      rpcError: { message: "rpc exploded" },
    });
    const persist = createPersistSandboxFileTool(deps);

    const result = String(await persist.invoke({ filePath: "/out.png" }, config));

    expect(result).toContain("Error uploading file");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    // No URL was fabricated as a fallback.
    expect(result).not.toContain("http");
  });
});
