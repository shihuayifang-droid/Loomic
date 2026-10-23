import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssetRecordRepository } from "../../db/asset-record-repository.js";
import type { AssetWriteRepository } from "../../db/asset-write-repository.js";
import type {
  CanvasProjectLinkRow,
  CanvasReadRepository,
} from "../../db/canvas-read-repository.js";
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
  recordProjectAsset: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  /** How many table reads the caller's client was asked for — must stay zero. */
  tableReads: () => number;
  config: Record<string, unknown>;
};

function makeHarness(
  sandboxDir: string,
  overrides: {
    /** The asset record repository rejects with this message. */
    recordError?: { message: string } | null;
    /** Omit the canvas id so the tool has no owner to file the object under. */
    noCanvas?: boolean;
    /** The canvas → project link answers nothing, i.e. the ACL hid the canvas. */
    canvasHidden?: boolean;
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
  let tableReads = 0;

  const client = {
    // 工单21AC moved the canvas lookup to the repository, so the caller's client
    // has NO table surface left: a read through it is a regression and throws.
    from: (table: string) => {
      tableReads += 1;
      throw new Error(`unexpected table read in persist-sandbox-file test: ${table}`);
    },
    storage: {
      from: vi.fn(() => ({ upload, createSignedUrl, remove })),
    },
  };

  const recordProjectAsset = vi.fn(async (_input: Record<string, unknown>) => {
    if (overrides.recordError) throw new Error(overrides.recordError.message);
    return { assetId: "asset-1", workspaceId: WORKSPACE, projectId: "project-1" };
  });
  const assetRecordRepository: Pick<AssetRecordRepository, "recordProjectAsset"> = {
    recordProjectAsset,
  };

  const canvasReadRepository = {
    async findReadableCanvasProjectLink(): Promise<CanvasProjectLinkRow | null> {
      return overrides.canvasHidden
        ? null
        : { project_id: "project-1", workspace_id: WORKSPACE, brand_kit_id: null };
    },
    async findReadableCanvasContent(): Promise<never> {
      throw new Error("findReadableCanvasContent is not used by this path");
    },
    async listReadableSucceededImageJobs(): Promise<never> {
      throw new Error("listReadableSucceededImageJobs is not used by this path");
    },
    async listReadableCanvasAssets(): Promise<never> {
      throw new Error("listReadableCanvasAssets is not used by this path");
    },
  } as unknown as CanvasReadRepository;

  const assetWriteRepository = {
    async deleteOwnAsset(): Promise<{ deleted: number }> {
      return { deleted: 1 };
    },
  } as unknown as AssetWriteRepository;

  return {
    deps: {
      canvasReadRepository,
      assetWriteRepository,
      createUserClient: () => client as unknown as SupabaseClient,
      assetRecordRepository,
      sandboxDir,
    },
    upload,
    createSignedUrl,
    recordProjectAsset,
    remove,
    tableReads: () => tableReads,
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

    const { deps, recordProjectAsset, config, tableReads } = makeHarness(sandboxDir);
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

    // 工单21AC: the canvas → project link is the repository's answer now, so the
    // caller's client was never asked for a table.
    expect(tableReads()).toBe(0);

    // Ownership came from the canvas, and the creator is the token's subject —
    // not a `configurable` field that could disagree with the JWT.
    expect(recordProjectAsset).toHaveBeenCalledTimes(1);
    expect(recordProjectAsset.mock.calls[0]?.[0]).toMatchObject({
      canvasId: CANVAS,
      createdBy: USER,
      bucket: "project-assets",
      projectId: null,
    });
  });

  it("case 2: no canvas context means no upload at all", async () => {
    const sandboxDir = makeTempDir("loomic-persist-x2-");
    writeFileSync(join(sandboxDir, "out.png"), "png-bytes", "utf-8");

    const { deps, upload, recordProjectAsset, config } = makeHarness(sandboxDir, {
      noCanvas: true,
    });
    const persist = createPersistSandboxFileTool(deps);

    const result = String(await persist.invoke({ filePath: "/out.png" }, config));

    // An unowned object is worse than no object: nothing is written.
    expect(result).toMatch(NO_CANVAS);
    expect(upload).toHaveBeenCalledTimes(0);
    expect(recordProjectAsset).toHaveBeenCalledTimes(0);
  });

  it("case 4: a canvas the repository cannot read is refused after reading the file but before any upload", async () => {
    const sandboxDir = makeTempDir("loomic-persist-x4-");
    writeFileSync(join(sandboxDir, "out.png"), "png-bytes", "utf-8");

    // 工单21AC: the canvas → project link is `findReadableCanvasProjectLink`, so a
    // canvas the caller may not read is a `null` answer rather than a row the tool
    // could derive a workspace from.
    const { deps, upload, recordProjectAsset, config } = makeHarness(sandboxDir, {
      canvasHidden: true,
    });
    const persist = createPersistSandboxFileTool(deps);

    const result = String(await persist.invoke({ filePath: "/out.png" }, config));

    expect(result).toContain("Error uploading file");
    expect(result).toContain("not found or not accessible");
    expect(upload).toHaveBeenCalledTimes(0);
    expect(recordProjectAsset).toHaveBeenCalledTimes(0);
  });

  it("case 3: a metadata failure deletes the object and reports an error", async () => {
    const sandboxDir = makeTempDir("loomic-persist-x3-");
    writeFileSync(join(sandboxDir, "out.png"), "png-bytes", "utf-8");

    const { deps, upload, remove, config } = makeHarness(sandboxDir, {
      recordError: { message: "record exploded" },
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
