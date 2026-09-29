import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type BackendFactory,
  type StateAndStore,
  CompositeBackend,
  FilesystemBackend,
  StoreBackend,
} from "deepagents";

import type { ServerEnv } from "../../config/env.js";
import type { AgentBackendResult } from "./index.js";
import { withoutExecution } from "./no-exec.js";

type AgentBackendEnv = Pick<ServerEnv, "agentFilesRoot" | "skillsRoot">;

const DEFAULT_DEV_SANDBOX_ROOT = "/tmp/loomic-sandbox-dev";

/**
 * Create a development backend with a local per-run sandbox directory.
 *
 * 一期关闭 execute（D-24，AG-39）：default backend 用 `virtualMode: true` 的
 * FilesystemBackend，factory 再把返回值交给 `withoutExecution()` 去掉执行能力，
 * 所以 deepagents 不会注入内置 `execute` 工具；文件工具也只能在 sandboxDir 内读写，
 * 不能再按宿主绝对路径操作磁盘（含 `.env.local`）。
 * The agent's workspace files are stored locally at agentFilesRoot,
 * and skills are loaded from skillsRoot.
 */
export function createDevelopmentBackend(
  env: AgentBackendEnv,
  options?: {
    /** Canvas ID — used for workspace-skills Store namespace when available. */
    canvasId?: string;
    /** When true, add a /workspace-skills/ route backed by the Store. */
    hasWorkspaceSkills?: boolean;
  },
): AgentBackendResult {
  if (!env.agentFilesRoot) {
    throw new Error(
      "LOOMIC_AGENT_FILES_ROOT must be set when filesystem backend mode is enabled.",
    );
  }

  const runId = crypto.randomUUID();
  const sandboxDir = join(resolve(DEFAULT_DEV_SANDBOX_ROOT), runId);
  mkdirSync(sandboxDir, { recursive: true });
  const realSandboxDir = realpathSync(sandboxDir);

  const skillsRoot = resolve(env.skillsRoot ?? join(env.agentFilesRoot, "skills"));

  // 一期关闭 execute（D-24，AG-39）：不再使用会附带 execute 的 shell 后端。
  const sandbox = new FilesystemBackend({
    rootDir: sandboxDir,
    virtualMode: true,
  });
  const skillsBackend = new FilesystemBackend({ rootDir: skillsRoot, virtualMode: true });

  const workspaceBackend = new FilesystemBackend({
    rootDir: env.agentFilesRoot,
    virtualMode: true,
  });

  const factory: BackendFactory = (stateAndStore: StateAndStore) => {
    const routes: Record<string, FilesystemBackend | StoreBackend> = {
      "/workspace/": workspaceBackend,
      "/skills/": skillsBackend,
    };

    // In dev mode, workspace skills are served from the Store when available.
    if (options?.hasWorkspaceSkills && options.canvasId && stateAndStore.store) {
      routes["/workspace-skills/"] = new StoreBackend(stateAndStore, {
        namespace: ["projects", options.canvasId, "workspace-skills"],
      });
    }

    // 一期关闭 execute（D-24，AG-39）：只保留 BackendProtocol 文件方法。
    return withoutExecution(new CompositeBackend(sandbox, routes));
  };

  return { factory, sandboxDir: realSandboxDir };
}
