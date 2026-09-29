import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPersistSandboxFileTool,
  type PersistSandboxFileDeps,
} from "./persist-sandbox-file.js";

const PATH_REJECTED = "Error: filePath must be inside the sandbox directory.";

const RUN_CONFIG = { configurable: { access_token: "test-token" } };

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
};

function makeHarness(sandboxDir: string): Harness {
  const upload = vi
    .fn()
    .mockResolvedValue({ data: { path: "uploads/stored.png" }, error: null });
  const createSignedUrl = vi.fn().mockResolvedValue({
    data: { signedUrl: "https://example.invalid/signed" },
    error: null,
  });

  const client = {
    storage: {
      from: vi.fn(() => ({ upload, createSignedUrl })),
    },
  };

  return {
    deps: {
      createUserClient: () => client as unknown as SupabaseClient,
      sandboxDir,
    },
    upload,
  };
}

describe("persist_sandbox_file path guard", () => {
  it("case 1: /../../etc/hosts is refused and nothing is uploaded", async () => {
    const sandboxDir = makeTempDir("loomic-persist-1-");
    const { deps, upload } = makeHarness(sandboxDir);
    const persist = createPersistSandboxFileTool(deps);

    const result = await persist.invoke(
      { filePath: "/../../etc/hosts" },
      RUN_CONFIG,
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

    const { deps, upload } = makeHarness(run1);
    const persist = createPersistSandboxFileTool(deps);

    const result = await persist.invoke(
      { filePath: "/../run10/x.png" },
      RUN_CONFIG,
    );

    expect(result).toBe(PATH_REJECTED);
    expect(upload).toHaveBeenCalledTimes(0);
  });

  it("case 3: a file written inside the sandbox is uploaded", async () => {
    const sandboxDir = makeTempDir("loomic-persist-3-");
    writeFileSync(join(sandboxDir, "out.png"), "png-bytes", "utf-8");

    const { deps, upload } = makeHarness(sandboxDir);
    const persist = createPersistSandboxFileTool(deps);

    const result = await persist.invoke({ filePath: "/out.png" }, RUN_CONFIG);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(String(result)).toContain("out.png");
  });
});
