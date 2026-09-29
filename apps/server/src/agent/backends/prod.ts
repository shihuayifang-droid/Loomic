import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type BackendFactory,
  type BackendProtocol,
  CompositeBackend,
  FilesystemBackend,
  StoreBackend,
} from "deepagents";

import { withoutExecution } from "./no-exec.js";

const DEFAULT_SANDBOX_ROOT = "/tmp/loomic-sandbox";
const DEFAULT_SKILLS_ROOT = "/opt/loomic/skills";

/**
 * Create a production backend with a per-project sandbox directory.
 *
 * 一期关闭 execute（D-24，AG-39）：default backend 用 `virtualMode: true` 的
 * FilesystemBackend，factory 再把返回值交给 `withoutExecution()` 去掉执行能力，
 * 所以 deepagents 不会注入内置 `execute` 工具。
 * 每个 canvasId 对应一个独立的工作目录，用完由 runtime.ts 清理。
 *
 * 文件持久化（/workspace/、/memories/）走 StoreBackend (PostgresStore)，
 * 与沙箱目录完全独立互不影响。
 *
 * Routes:
 *   /workspace/        → StoreBackend (PostgresStore, per-project)
 *   /memories/         → StoreBackend (PostgresStore, per-project)
 *   /skills/           → FilesystemBackend (shared, read-only system skills)
 *   /workspace-skills/ → StoreBackend (user-installed workspace skills, optional)
 *   default            → FilesystemBackend (per-run sandbox, no execute)
 */
export function createProductionBackendFactory(
  canvasId: string,
  options?: {
    sandboxRoot?: string;
    skillsRoot?: string;
    hasWorkspaceSkills?: boolean;
  },
): { factory: BackendFactory; sandboxDir: string } {
  const sandboxRoot = resolve(options?.sandboxRoot ?? DEFAULT_SANDBOX_ROOT);
  const skillsRoot = resolve(options?.skillsRoot ?? DEFAULT_SKILLS_ROOT);

  // Per-run isolated directory
  const runId = crypto.randomUUID();
  const sandboxDir = join(sandboxRoot, runId);
  mkdirSync(sandboxDir, { recursive: true });
  const realSandboxDir = realpathSync(sandboxDir);

  // 一期关闭 execute（D-24，AG-39）：不再使用会附带 execute 的 shell 后端。
  // virtualMode: true 限制文件工具（write_file/read_file/ls 等）只能操作 rootDir 内的文件。
  // 防止多用户并发时通过 write_file 写绝对路径导致冲突。
  const sandbox = new FilesystemBackend({
    rootDir: sandboxDir,
    virtualMode: true,
  });

  const skillsBackend = new FilesystemBackend({ rootDir: skillsRoot, virtualMode: true });

  const factory: BackendFactory = (stateAndStore) => {
    const routes: Record<string, BackendProtocol> = {
      "/memories/": new StoreBackend(stateAndStore, {
        namespace: ["projects", canvasId, "memories"],
      }),
      "/workspace/": new StoreBackend(stateAndStore, {
        namespace: ["projects", canvasId, "workspace"],
      }),
      "/skills/": skillsBackend,
    };

    if (options?.hasWorkspaceSkills) {
      routes["/workspace-skills/"] = new StoreBackend(stateAndStore, {
        namespace: ["projects", canvasId, "workspace-skills"],
      });
    }

    // 一期关闭 execute（D-24，AG-39）：只保留 BackendProtocol 文件方法。
    return withoutExecution(new CompositeBackend(sandbox, routes));
  };

  return { factory, sandboxDir: realSandboxDir };
}
