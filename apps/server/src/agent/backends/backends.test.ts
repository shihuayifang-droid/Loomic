import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompositeBackend,
  LocalShellBackend,
  type BackendProtocol,
  isSandboxBackend,
} from "deepagents";
import { afterEach, describe, expect, it } from "vitest";

import { createDevelopmentBackend } from "./dev.js";
import { assertExecutionForbidden } from "./no-exec.js";
import { createProductionBackendFactory } from "./prod.js";

const STATE_ONLY = { state: {} };

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

/** prod factory 产出的对象；sandbox root 落在临时目录，测完清理。 */
function makeProductionBackend(): BackendProtocol {
  const root = makeTempDir("loomic-backends-prod-");
  const sandboxRoot = join(root, "sandbox");
  const skillsRoot = join(root, "skills");
  mkdirSync(sandboxRoot, { recursive: true });
  mkdirSync(skillsRoot, { recursive: true });

  const { factory, sandboxDir } = createProductionBackendFactory("canvas-test", {
    sandboxRoot,
    skillsRoot,
  });
  tempDirs.push(sandboxDir);

  return factory(STATE_ONLY);
}

describe("agent backends never expose shell execution (AG-39)", () => {
  it("case 1: production factory output is not a sandbox backend", () => {
    const backend = makeProductionBackend();

    expect(isSandboxBackend(backend)).toBe(false);
    expect(typeof (backend as unknown as Record<string, unknown>).execute).toBe(
      "undefined",
    );
  });

  it("case 2: development factory output is not a sandbox backend", () => {
    const agentFilesRoot = makeTempDir("loomic-backends-dev-");
    const { factory, sandboxDir } = createDevelopmentBackend({ agentFilesRoot });
    if (sandboxDir) tempDirs.push(sandboxDir);

    const backend = factory(STATE_ONLY);

    expect(isSandboxBackend(backend)).toBe(false);
    expect(typeof (backend as unknown as Record<string, unknown>).execute).toBe(
      "undefined",
    );
  });

  it("case 3: the startup self-check still rejects a real shell backend", () => {
    const root = makeTempDir("loomic-backends-control-");
    const composite = new CompositeBackend(
      new LocalShellBackend({ rootDir: root }),
      {},
    );

    // 对照组必须真的是沙箱后端，否则这条用例什么也证明不了。
    expect(isSandboxBackend(composite)).toBe(true);
    expect(() => assertExecutionForbidden(composite)).toThrow(
      /execution backend is forbidden/,
    );
  });

  it("case 4: read('../../.env') is refused with a path traversal error", async () => {
    const backend = makeProductionBackend();

    const result = await backend.read("../../.env");

    expect(result).toContain("Path traversal");
  });

  it("case 5: a host absolute path outside the sandbox leaks nothing", async () => {
    const backend = makeProductionBackend();
    const outsideDir = makeTempDir("loomic-backends-outside-");
    const secretPath = join(outsideDir, "secret.txt");
    writeFileSync(secretPath, "TOP_SECRET_VALUE", "utf-8");

    const result = await backend.read(secretPath);

    expect(result).not.toContain("TOP_SECRET_VALUE");
    expect(result).toContain("Error");
  });

  it("case 6: writing and reading inside the sandbox still works", async () => {
    const backend = makeProductionBackend();

    const written = await backend.write("/a.txt", "hello");
    expect(written.error).toBeUndefined();

    const content = await backend.read("/a.txt");
    expect(content).toContain("hello");
  });
});
