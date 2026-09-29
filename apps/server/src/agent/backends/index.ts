import type { BackendFactory } from "deepagents";

import type { ServerEnv } from "../../config/env.js";
import { createDevelopmentBackend } from "./dev.js";
import { assertExecutionForbidden } from "./no-exec.js";
import { createProductionBackendFactory } from "./prod.js";

type AgentBackendEnv = Pick<
  ServerEnv,
  "agentBackendMode" | "agentFilesRoot" | "skillsRoot"
>;

export type AgentBackendResult = {
  factory: BackendFactory;
  sandboxDir?: string;
};

/**
 * 一期关闭 execute（D-24，AG-39）：启动自检。
 *
 * deepagents 只看最外层对象的
 * `typeof execute === "function" && typeof id === "string"` 来决定要不要把
 * `execute` 注入工具清单。所以每个 run 建后端都要在 `createAgentBackend` 出口
 * 过一遍自检：一旦 factory 产出的对象仍是沙箱后端，就**直接抛错**，
 * 而不是让它带着 execute 悄悄跑起来。
 */
function guardExecution(factory: BackendFactory): BackendFactory {
  return (stateAndStore) => {
    const backend = factory(stateAndStore);
    assertExecutionForbidden(backend);
    return backend;
  };
}

export function createAgentBackend(
  env: AgentBackendEnv,
  canvasId?: string,
  options?: { hasWorkspaceSkills?: boolean },
): AgentBackendResult {
  if (env.agentBackendMode === "filesystem") {
    const dev = createDevelopmentBackend(env, {
      ...(canvasId != null ? { canvasId } : {}),
      ...(options?.hasWorkspaceSkills ? { hasWorkspaceSkills: true } : {}),
    });

    return { ...dev, factory: guardExecution(dev.factory) };
  }

  if (!canvasId) {
    throw new Error(
      "canvasId is required for production (state) backend mode. " +
        "Each agent run must be scoped to a project.",
    );
  }

  const prod = createProductionBackendFactory(canvasId, {
    ...(env.skillsRoot ? { skillsRoot: env.skillsRoot } : {}),
    ...(options?.hasWorkspaceSkills ? { hasWorkspaceSkills: true } : {}),
  });

  return { ...prod, factory: guardExecution(prod.factory) };
}
