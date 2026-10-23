// QA-12: nothing the model is handed can run a command (AG-39 / D-24).
//
// The existing suites pin the two raw backend factories (`backends.test.ts`) and
// call `assertExecutionForbidden` directly, so two separate things were still
// unproven:
//
//   * the tool list `createMainAgentTools` actually returns — deepagents filters
//     `execute` out of its OWN built-ins when the backend is not a sandbox
//     backend, but nothing checked that our own registrations add no equivalent
//     (`shell` / `bash` / `run_command` / any other execution-shaped name);
//   * the guarded exit of `createAgentBackend`, which is the object every agent
//     run really goes through. A future mode that skips `guardExecution` would
//     pass `backends.test.ts` and fail here.
//
// Both deployment shapes are covered: a run with a sandbox directory plus the
// asset record repository (persist_sandbox_file is offered) and a run with neither.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendProtocol } from "deepagents";
import { afterEach, describe, expect, it } from "vitest";

import type { AssetRecordRepository } from "../../db/asset-record-repository.js";
import type { AssetWriteRepository } from "../../db/asset-write-repository.js";
import type { BrandKitReadRepository } from "../../db/brand-kit-read-repository.js";
import type { CanvasReadRepository } from "../../db/canvas-read-repository.js";
import { createAgentBackend } from "../backends/index.js";
import { createMainAgentTools } from "./index.js";

/** Exactly the names an execution tool could take, plus the shape of the rest. */
const NEVER_OFFERED = ["execute", "shell", "bash", "run_command"];
const EXECUTION_SHAPED = /exec|shell|bash|command/i;

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

/**
 * Only the three required repositories are typed here. None of them is read:
 * this file inspects the tool list, it never runs a tool.
 */
function minimalDeps() {
  return {
    assetWriteRepository: {} as unknown as AssetWriteRepository,
    brandKitReadRepository: {} as unknown as BrandKitReadRepository,
    canvasReadRepository: {} as unknown as CanvasReadRepository,
    createUserClient: () => ({}),
  };
}

function toolNames(tools: ReturnType<typeof createMainAgentTools>): string[] {
  return tools.map((entry) => entry.name);
}

function expectNoExecutionTool(
  tools: ReturnType<typeof createMainAgentTools>,
): void {
  const names = toolNames(tools);

  // The list is not empty: an empty list would satisfy every assertion below
  // without proving anything.
  expect(names.length).toBeGreaterThan(0);

  for (const forbidden of NEVER_OFFERED) {
    expect(names).not.toContain(forbidden);
  }

  expect(names.filter((name) => EXECUTION_SHAPED.test(name))).toEqual([]);
}

describe("QA-12: the model's tool list cannot run a command", () => {
  it("QA-12: the tools the model gets have no execute (no sandbox dir, no admin client)", () => {
    const tools = createMainAgentTools(
      {} as unknown as BackendProtocol,
      minimalDeps(),
    );

    expectNoExecutionTool(tools);
    expect(toolNames(tools)).toContain("project_search");
    expect(toolNames(tools)).toContain("inspect_canvas");
    expect(toolNames(tools)).toContain("manipulate_canvas");
  });

  it("QA-12: the tools the model gets have no execute (sandbox dir + asset record repository)", () => {
    const sandboxDir = makeTempDir("loomic-tools-no-exec-");

    const tools = createMainAgentTools({} as unknown as BackendProtocol, {
      ...minimalDeps(),
      sandboxDir,
      assetRecordRepository: {
        recordProjectAsset: async () => {
          throw new Error("not used: this file never runs a tool");
        },
      } as Pick<AssetRecordRepository, "recordProjectAsset">,
    });

    // This dependency shape really does add a tool, so the two cases do not
    // assert the same list twice.
    expect(toolNames(tools)).toContain("persist_sandbox_file");

    expectNoExecutionTool(tools);
  });
});

describe("QA-12: every backend mode's guarded exit has no execute", () => {
  const STATE_ONLY = { state: {} };

  function executeOf(backend: unknown): unknown {
    return (backend as Record<string, unknown>).execute;
  }

  it("QA-12: both backend modes refuse a backend that can execute", () => {
    // Production ("state") mode: the backend the run gets is the guarded one.
    const stateResult = createAgentBackend(
      { agentBackendMode: "state" },
      "canvas-1",
    );
    if (stateResult.sandboxDir) tempDirs.push(stateResult.sandboxDir);

    const stateBackend = stateResult.factory(STATE_ONLY);

    expect(typeof executeOf(stateBackend)).not.toBe("function");
    expect(
      "execute" in (stateBackend as unknown as Record<string, unknown>),
    ).toBe(false);

    // Development ("filesystem") mode: same guard, different factory behind it.
    const agentFilesRoot = makeTempDir("loomic-tools-backend-dev-");
    const devResult = createAgentBackend({
      agentBackendMode: "filesystem",
      agentFilesRoot,
    });
    if (devResult.sandboxDir) tempDirs.push(devResult.sandboxDir);

    const devBackend = devResult.factory(STATE_ONLY);

    expect(typeof executeOf(devBackend)).not.toBe("function");
    expect(
      "execute" in (devBackend as unknown as Record<string, unknown>),
    ).toBe(false);
  });
});
