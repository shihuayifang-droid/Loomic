import { isSandboxBackend, type BackendProtocol } from "deepagents";

/**
 * 一期关闭 execute（D-24，AG-39）。
 *
 * deepagents 判断「这个后端能不能执行 shell」只看**最外层**对象：
 * `typeof backend.execute === "function" && typeof backend.id === "string"`。
 * `CompositeBackend` 永远满足这两条（它的 `id` getter 在非沙箱时返回 `""`，
 * 但仍是 string；`execute` 方法始终存在），所以只把 default backend 换成
 * 文件后端是不够的 —— 必须让 factory 返回的对象**根本没有** `execute`。
 */
export const EXECUTION_BACKEND_FORBIDDEN =
  "execution backend is forbidden (D-24, AG-39)";

/**
 * deepagents@1.8.4 `dist/index.d.ts` 里 `BackendProtocol` 的全部成员。
 * `execute` / `id` 属于 `SandboxBackendProtocol`，**故意不在这个名单里**。
 */
const BACKEND_PROTOCOL_METHODS = [
  "lsInfo",
  "read",
  "readRaw",
  "grepRaw",
  "globInfo",
  "write",
  "edit",
  "uploadFiles",
  "downloadFiles",
] as const;

/**
 * 启动自检：backend 仍然是沙箱后端（能执行 shell）就直接抛错。
 *
 * 这是「宁可起不来，也不要带着 execute 跑起来」的闸门：
 * 每个 run 建后端都会经过 `createAgentBackend` 出口的这道检查。
 */
export function assertExecutionForbidden(backend: BackendProtocol): void {
  if (isSandboxBackend(backend)) {
    throw new Error(EXECUTION_BACKEND_FORBIDDEN);
  }
}

/**
 * 去掉执行能力：只转发 `BackendProtocol` 的文件方法，不转发 `execute` / `id`。
 *
 * 返回值是普通对象而非 `CompositeBackend` 实例，所以
 * `typeof wrapper.execute === "function"` 为 false，
 * deepagents 的 FilesystemMiddleware 会把 `execute` 从工具清单里过滤掉。
 */
export function withoutExecution(backend: BackendProtocol): BackendProtocol {
  const source = backend as unknown as Record<string, unknown>;
  const wrapper: Record<string, unknown> = {};

  for (const name of BACKEND_PROTOCOL_METHODS) {
    const member = source[name];
    if (typeof member === "function") {
      wrapper[name] = (member as (...memberArgs: unknown[]) => unknown).bind(backend);
    }
  }

  return wrapper as unknown as BackendProtocol;
}
