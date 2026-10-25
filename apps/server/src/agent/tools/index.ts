import type { StructuredTool } from "@langchain/core/tools";
import type { BackendFactory, BackendProtocol } from "deepagents";

import type { AssetRecordRepository } from "../../db/asset-record-repository.js";
import type { AssetWriteRepository } from "../../db/asset-write-repository.js";
import type { BrandKitReadRepository } from "../../db/brand-kit-read-repository.js";
import type { CanvasContentRepository } from "../../db/canvas-content-repository.js";
import type { CanvasReadRepository } from "../../db/canvas-read-repository.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
import { createBrandKitTool } from "./brand-kit.js";
import { createInspectCanvasTool } from "./inspect-canvas.js";
import { createManipulateCanvasTool } from "./manipulate-canvas.js";
import {
  createImageGenerateTool,
  type PersistImageFn,
  type SubmitImageJobFn,
} from "./image-generate.js";
import { createProjectSearchTool } from "./project-search.js";
import { createScreenshotCanvasTool } from "./screenshot-canvas.js";
// 45AH / T-133 (2nd slice): the storage backend behind `get_brand_kit` is named
// HERE, in the tool assembly, so `brand-kit.ts` itself imports no adapter.
// 45AO (T-133 7th slice): this file no longer NAMES a backend at all. The
// factory arrives from `deps` and is passed through verbatim; when the assembly
// forgot it, the tool reports that as an assembly error instead of quietly
// constructing an adapter of its own.
import type { ObjectStore } from "../../features/storage/object-store.js";
import {
  createVideoGenerateTool,
  type SubmitVideoJobFn,
} from "./video-generate.js";
import { createPersistSandboxFileTool } from "./persist-sandbox-file.js";

export { createImageGenerateTool } from "./image-generate.js";
export { createVideoGenerateTool } from "./video-generate.js";
export { createInspectCanvasTool } from "./inspect-canvas.js";
export { createManipulateCanvasTool } from "./manipulate-canvas.js";

// ---------------------------------------------------------------------------
// deepagents 内置工具参考 (由 FilesystemMiddleware 自动注入)
// ---------------------------------------------------------------------------
//
// deepagents@1.8.4 通过 createFilesystemMiddleware 自动注入以下工具，
// 我们自定义的工具名称不能与这些冲突：
//
//   ls          — 列出目录内容
//   read_file   — 读取文件内容（支持 offset/limit）
//   write_file  — 写入文件
//   edit_file   — 编辑文件（find & replace）
//   glob        — 按模式匹配文件路径
//   grep        — 按正则搜索文件内容
//   task        — 分发子任务到 subagent
//   write_todos — 管理 TODO 列表
//
// 一期关闭 execute（D-24，AG-39）：后端不再实现 SandboxBackendProtocol 的
// execute，FilesystemMiddleware 因此会把 execute 从工具清单里过滤掉。
// 代码执行没有替代品，也不在这里补。
//
// CompositeBackend 路由互不干扰：
//   /workspace/  → StoreBackend (PostgresStore) — 文件持久化
//   /memories/   → StoreBackend (PostgresStore) — agent 记忆
//   /skills/     → FilesystemBackend            — 系统 skills
//   default      → FilesystemBackend            — 临时文件（无 execute）
// ---------------------------------------------------------------------------

/**
 * 45AO (T-133 7th slice): what the brand kit tool gets when the assembly never
 * wired a store factory.
 *
 * It is deliberately NOT an adapter: the tool used to fall back to wrapping the
 * caller's client in the Supabase backend from here, which made a missing wire
 * look like a working assembly. A factory that throws the moment the tool needs
 * a store is the honest shape — the failure names the assembly, not Storage.
 */
const missingObjectStoreFactory = (): ObjectStore => {
  throw new Error(
    "get_brand_kit: no createObjectStore factory was wired into " +
      "createMainAgentTools — assembly error, not a storage failure",
  );
};

/**
 * 45BK (T-133 10b): the same honest shape for `persist_sandbox_file`, which now
 * REQUIRES a token-keyed store factory. Its adapter wrap over the caller's
 * client was deleted in that slice, so a missing wire must throw — and name the
 * assembly — rather than fall back to building a store of its own.
 */
const missingPersistObjectStoreFactory = (): ObjectStore => {
  throw new Error(
    "persist_sandbox_file: no createObjectStore factory was wired into " +
      "createMainAgentTools — assembly error, not a storage failure",
  );
};

export function createMainAgentTools(
  backend: BackendProtocol | BackendFactory,
  deps: {
    /**
     * The compensated asset-row delete behind a failed signing (workorder 21AC).
     * Required, and required all the way down: an optional dependency that is
     * silently missing fails at the one moment it is needed.
     */
    assetWriteRepository: AssetWriteRepository;
    /** Records the asset ownership for persist_sandbox_file (44F); without it that tool is not offered. */
    assetRecordRepository?: Pick<AssetRecordRepository, "recordProjectAsset">;
    /** Owner-keyed brand kit reads — `get_brand_kit` no longer reads tables (21AC). */
    brandKitReadRepository: BrandKitReadRepository;
    /** The canvas → project link behind every persisted asset's workspace (21AC). */
    canvasReadRepository: CanvasReadRepository;
    /** Canvas content reads/writes for inspect_canvas and manipulate_canvas; without it both report canvas_unavailable. */
    canvasContentRepository?: Pick<
      CanvasContentRepository,
      "readCanvasRow" | "writeIfUnchanged"
    >;
    createUserClient: (accessToken: string) => any;
    /**
     * 45AH / T-133 (2nd slice): Storage for `get_brand_kit` arrives as a FACTORY
     * over the CALLER's client — `(client) => ObjectStore` — not as a shared
     * store. The tool signs as the caller, which is exactly what RLS on Storage
     * enforced before the `ObjectStore` seam existed.
     *
     * Optional in THIS type because the callers that assemble it
     * (`deep-agent.ts` → `runtime.ts` → `app.ts`) are not part of this slice's
     * file set. When it is absent the tool is still built, but asking it for a
     * store throws an ASSEMBLY error: 45AO removed the adapter wrap that used to
     * stand in here, because a silent stand-in made a missing wire look wired.
     */
    createObjectStore?: (client: any) => ObjectStore;
    brandKitId?: string | null;
    connectionManager?: ConnectionManager;
    persistImage?: PersistImageFn;
    sandboxDir?: string;
    submitImageJob?: SubmitImageJobFn;
    submitVideoJob?: SubmitVideoJobFn;
  },
) {
  const tools: StructuredTool[] = [
    createProjectSearchTool(backend),
    createInspectCanvasTool(deps),
    createManipulateCanvasTool(deps),
    // 一期关闭 execute（D-24，AG-39）：deepagents 不再注入 execute，
    // 这里也不手动注册任何代码执行工具。
  ];

  // persist_sandbox_file 必须有沙箱根目录才有可校验的上传范围。
  // 没有 sandboxDir 就不注册这个工具，而不是注册一个不校验路径的版本。
  // X-52 之后还有一个必要条件：没有 assetRecordRepository 就记不了归属，
  // 同样不注册 —— 而不是注册一个会写出无归属对象的版本。
  if (deps.sandboxDir && deps.assetRecordRepository) {
    tools.push(
      createPersistSandboxFileTool({
        assetWriteRepository: deps.assetWriteRepository,
        assetRecordRepository: deps.assetRecordRepository,
        canvasReadRepository: deps.canvasReadRepository,
        // 45BK / T-133 (10b): the store factory is REQUIRED here now, and it is
        // handed over keyed on the caller's access token — the same shape
        // `runtime.ts` already produces for this path. `createUserClient` is no
        // longer passed (that wrap is gone). A throwing stand-in when the
        // assembly wired none, so a missing wire is an assembly error.
        createObjectStore:
          deps.createObjectStore ?? missingPersistObjectStoreFactory,
        sandboxDir: deps.sandboxDir,
      }),
    );
  } else if (deps.sandboxDir) {
    console.warn(
      "[tools] no assetRecordRepository — persist_sandbox_file will not be offered, " +
        "because an upload without recorded ownership cannot be authorised (X-52)",
    );
  }

  // LOCAL FORK: generation tools are registered ONLY when a job channel exists.
  //
  // These used to be registered unconditionally, spreading submitJob in when
  // present. With it absent the tool still built fine and fell through to a
  // direct provider call that skipped the job record, the credit deduction and
  // the tier check. runtime.ts only builds those closures when
  // `jobService && createUserClient && accessToken && userId` all hold, so the
  // absent case is a real, reachable state -- not a theoretical one.
  //
  // No job channel now means the capability is simply not offered. The agent
  // sees no generate_image / generate_video tool and says so, which is the
  // honest outcome; handing out unbilled generations is not.
  if (deps.submitImageJob) {
    tools.push(
      createImageGenerateTool({
        submitImageJob: deps.submitImageJob,
        ...(deps.persistImage ? { persistImage: deps.persistImage } : {}),
      }),
    );
  } else {
    console.warn(
      "[tools] no submitImageJob channel — generate_image will not be offered",
    );
  }

  if (deps.submitVideoJob) {
    tools.push(createVideoGenerateTool({ submitVideoJob: deps.submitVideoJob }));
  } else {
    console.warn(
      "[tools] no submitVideoJob channel — generate_video will not be offered",
    );
  }
  if (deps.brandKitId) {
    tools.push(
      createBrandKitTool(
        {
          createUserClient: deps.createUserClient,
          createObjectStore: deps.createObjectStore ?? missingObjectStoreFactory,
          brandKitReadRepository: deps.brandKitReadRepository,
        },
        deps.brandKitId,
      ),
    );
  }
  if (deps.connectionManager) {
    tools.push(createScreenshotCanvasTool({
      connectionManager: deps.connectionManager,
      ...(deps.persistImage ? { persistImage: deps.persistImage } : {}),
    }));
  }
  return tools;
}

// LOCAL FORK: createPhaseATools removed. It was already @deprecated and unused,
// but it constructed both generation tools with no arguments -- i.e. it was a
// ready-made unbilled path waiting to be called. Deleted rather than fixed,
// since createMainAgentTools + sub-agents replaced it.
