import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph-checkpoint";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { createDeepAgent } from "deepagents";

import { DEFAULT_AGENT_MODEL, DEFAULT_GOOGLE_AGENT_MODEL, type ServerEnv } from "../config/env.js";
import type { AssetRecordRepository } from "../db/asset-record-repository.js";
import type { AssetWriteRepository } from "../db/asset-write-repository.js";
import type { BrandKitReadRepository } from "../db/brand-kit-read-repository.js";
import type { CanvasReadRepository } from "../db/canvas-read-repository.js";
import type { AdminSupabaseClient } from "../supabase/admin.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import { createAgentBackend, type AgentBackendResult } from "./backends/index.js";
import { ChatOpenAIImageUrlCompat } from "./openai-image-url-compat.js";
import { LOOMIC_SYSTEM_PROMPT } from "./prompts/loomic-main.js";
import { createVideoSubAgent } from "./sub-agents.js";
import { createMainAgentTools } from "./tools/index.js";
import type { PersistImageFn, SubmitImageJobFn } from "./tools/image-generate.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";
import type { WorkspaceSkillEntry } from "./workspace-skills.js";

export type LoomicAgent = Pick<
  ReturnType<typeof createDeepAgent>,
  "stream" | "streamEvents"
>;

export type LoomicAgentFactory = (options: {
  assetWriteRepository: AssetWriteRepository;
  assetRecordRepository?: Pick<AssetRecordRepository, "recordProjectAsset">;
  backendResult?: AgentBackendResult;
  brandKitId?: string | null;
  /** Owner-keyed brand kit reads behind `get_brand_kit` (workorder 21AC). */
  brandKitReadRepository: BrandKitReadRepository;
  canvasId?: string;
  /** The canvas → project link behind every persisted asset (workorder 21AC). */
  canvasReadRepository: CanvasReadRepository;
  checkpointer?: BaseCheckpointSaver;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => any;
  /** Service-role getter for asset ownership recording (X-52). */
  getAdminClient?: () => AdminSupabaseClient;
  env: ServerEnv;
  model?: BaseLanguageModel | string;
  persistImage?: PersistImageFn;

  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  store?: BaseStore;
  workspaceSkills?: WorkspaceSkillEntry[];
}) => LoomicAgent;

export function createLoomicDeepAgent(options: {
  assetWriteRepository: AssetWriteRepository;
  assetRecordRepository?: Pick<AssetRecordRepository, "recordProjectAsset">;
  backendResult?: AgentBackendResult;
  brandKitId?: string | null;
  brandKitReadRepository: BrandKitReadRepository;
  canvasId?: string;
  canvasReadRepository: CanvasReadRepository;
  checkpointer?: BaseCheckpointSaver;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => any;
  getAdminClient?: () => AdminSupabaseClient;
  env: ServerEnv;
  model?: BaseLanguageModel | string;
  persistImage?: PersistImageFn;

  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  store?: BaseStore;
  workspaceSkills?: WorkspaceSkillEntry[];
}): LoomicAgent {
  const backendResult =
    options.backendResult ?? createAgentBackend(options.env, options.canvasId);

  applyOpenAICompatEnv(options.env);

  const modelSpec = options.model ?? createDefaultModelSpecifier(options.env);
  const resolvedModel =
    typeof modelSpec === "string"
      ? createStreamingChatModel(modelSpec)
      : modelSpec;

  const createUserClient =
    options.createUserClient ??
    ((_accessToken: string): never => {
      throw new Error(
        "inspect_canvas is unavailable: no createUserClient was provided to createLoomicDeepAgent.",
      );
    });

  let systemPrompt = options.brandKitId
    ? LOOMIC_SYSTEM_PROMPT +
      "\n\n当前项目已绑定品牌套件。在进行设计相关工作时，请先使用 get_brand_kit 工具查询品牌信息，确保设计符合品牌规范。"
    : LOOMIC_SYSTEM_PROMPT;

  // Inject enabled skills (both system and user-created) into the system prompt.
  // All skills are loaded from the database via loadWorkspaceSkills() in runtime.ts.
  const wsSkills = options.workspaceSkills ?? [];
  if (wsSkills.length > 0) {
    const skillsList = wsSkills
      .map((s) => {
        let line = `- **${s.name}**: ${s.description}\n  → Read \`${s.path}\` for full instructions`;
        if (s.files.length > 0) {
          const counts: Record<string, number> = {};
          for (const f of s.files) {
            const dir = f.path.split("/")[0] ?? "other";
            counts[dir] = (counts[dir] ?? 0) + 1;
          }
          const summary = Object.entries(counts)
            .map(([dir, n]) => `${dir}/ (${n})`)
            .join(", ");
          line += `\n  → Has: ${summary}`;
        }
        return line;
      })
      .join("\n");
    systemPrompt += `\n\n## Skills\n\nThe following skills are enabled in this workspace:\n${skillsList}`;
  }

  return createDeepAgent({
    backend: backendResult.factory,
    ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
    model: resolvedModel,
    name: "loomic",
    ...(options.store ? { store: options.store } : {}),
    // Registered only with a job channel — without one the sub-agent's tool
    // would bill nothing. See sub-agents.ts.
    subagents: options.submitVideoJob
      ? [createVideoSubAgent({ submitVideoJob: options.submitVideoJob })]
      : [],
    systemPrompt,
    tools: createMainAgentTools(backendResult.factory, {
      assetWriteRepository: options.assetWriteRepository,
      ...(options.assetRecordRepository
        ? { assetRecordRepository: options.assetRecordRepository }
        : {}),
      brandKitReadRepository: options.brandKitReadRepository,
      canvasReadRepository: options.canvasReadRepository,
      createUserClient,
      ...(options.getAdminClient ? { getAdminClient: options.getAdminClient } : {}),
      ...(options.brandKitId != null ? { brandKitId: options.brandKitId } : {}),
      ...(options.connectionManager ? { connectionManager: options.connectionManager } : {}),
      ...(options.persistImage ? { persistImage: options.persistImage } : {}),
      ...(backendResult.sandboxDir ? { sandboxDir: backendResult.sandboxDir } : {}),

      ...(options.submitImageJob ? { submitImageJob: options.submitImageJob } : {}),
      ...(options.submitVideoJob ? { submitVideoJob: options.submitVideoJob } : {}),
    }),
  });
}

/**
 * Create a streaming chat model from a `<provider>:<model-id>` specifier.
 *
 * Supported providers:
 * - `openai` (default) — uses ChatOpenAI with `streamUsage: false` to work
 *   around the one-api proxy stripping `delta.role` from chunks.
 * - `google` — uses ChatGoogleGenerativeAI (Google AI Studio, API Key) or
 *   ChatVertexAI (Vertex AI, service account) depending on available config.
 * - `deepseek` — DeepSeek's own OpenAI-compatible endpoint, deliberately kept
 *   separate from `openai` so it bypasses the shared gateway. Measured
 *   2026-09-14 with an identical request: `deepseek-v4-flash` took 1926ms direct
 *   versus 12354ms through the kwjm gateway, i.e. the gateway added ~10.4s. Image
 *   generation still has to go through the gateway, so both must coexist.
 * - `aether` — an OpenAI-compatible gateway on the LAN (10.210.134.15:18085).
 *   Same reasoning as `deepseek`: kept separate from `openai` so chat can leave
 *   the kwjm gateway while image generation stays on it.
 */
function createStreamingChatModel(specifier: string): BaseLanguageModel {
  const colonIdx = specifier.indexOf(":");
  let provider = colonIdx > 0 ? specifier.slice(0, colonIdx) : "openai";
  let modelName = colonIdx > 0 ? specifier.slice(colonIdx + 1) : specifier;

  const hasGoogleApiKey = !!process.env.GOOGLE_API_KEY;
  const hasVertexAI = !!(process.env.GOOGLE_VERTEX_PROJECT && process.env.GOOGLE_VERTEX_LOCATION);
  const hasGoogle = hasGoogleApiKey || hasVertexAI;

  // Provider availability fallback
  if (provider === "google" && !hasGoogle) {
    console.warn(`[model] Google unavailable (no GOOGLE_API_KEY or Vertex AI config), falling back to OpenAI for: ${specifier}`);
    provider = "openai";
    modelName = DEFAULT_AGENT_MODEL;
  }
  if (provider === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
    console.warn(
      `[model] DeepSeek unavailable (no DEEPSEEK_API_KEY), falling back to OpenAI for: ${specifier}`,
    );
    provider = "openai";
    modelName = DEFAULT_AGENT_MODEL;
  }
  if (provider === "aether" && !process.env.AETHER_API_KEY) {
    console.warn(
      `[model] Aether unavailable (no AETHER_API_KEY), falling back to OpenAI for: ${specifier}`,
    );
    provider = "openai";
    modelName = DEFAULT_AGENT_MODEL;
  }
  if (provider === "openai" && !process.env.OPENAI_API_KEY && hasGoogle) {
    console.warn(`[model] OpenAI unavailable (no OPENAI_API_KEY), falling back to Google for: ${specifier}`);
    provider = "google";
    modelName = DEFAULT_GOOGLE_AGENT_MODEL;
  }

  switch (provider) {
    case "aether":
      // Same rationale as `deepseek` below: explicit apiKey/baseURL so this
      // does not disturb the OPENAI_* env that image generation depends on.
      return new ChatOpenAIImageUrlCompat({
        model: modelName,
        streaming: true,
        streamUsage: false,
        apiKey: process.env.AETHER_API_KEY!,
        configuration: {
          baseURL: process.env.AETHER_API_BASE ?? "http://10.210.134.15:18085/v1",
        },
      });
    case "deepseek":
      // Explicit apiKey/baseURL rather than the OPENAI_* process env, which is
      // pointed at the gateway for image generation and must stay that way.
      return new ChatOpenAIImageUrlCompat({
        model: modelName,
        streaming: true,
        streamUsage: false,
        apiKey: process.env.DEEPSEEK_API_KEY!,
        configuration: {
          baseURL: process.env.DEEPSEEK_API_BASE ?? "https://api.deepseek.com/v1",
        },
      });
    case "google":
      // Prefer Vertex AI (service account) when configured; fall back to Developer API key
      if (hasVertexAI) {
        const vertexProject = process.env.GOOGLE_VERTEX_PROJECT!;
        const vertexLocation = process.env.GOOGLE_VERTEX_LOCATION!;
        console.log(`[model] Using Vertex AI for: ${modelName} (project=${vertexProject}, location=${vertexLocation})`);
        return new ChatVertexAI({
          model: modelName,
          location: vertexLocation,
          authOptions: { projectId: vertexProject },
          streaming: true,
        });
      }
      return new ChatGoogleGenerativeAI({
        model: modelName,
        apiKey: process.env.GOOGLE_API_KEY!,
        streaming: true,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: -1, // dynamic — let the model decide
        },
      });
    case "openai":
    default:
      return new ChatOpenAIImageUrlCompat({
        model: modelName,
        streaming: true,
        streamUsage: false,
      });
  }
}

/** Known model-name prefixes that map to Google Gemini. */
const GOOGLE_MODEL_PREFIXES = ["gemini-"];
/**
 * Bare `deepseek-*` names route to DeepSeek's own endpoint, because the gateway
 * copy of the same model measured ~10.4s slower. To deliberately use the gateway
 * copy instead, write the prefix out: `openai:deepseek-v4-flash`.
 */
const DEEPSEEK_MODEL_PREFIXES = ["deepseek-"];

export function createDefaultModelSpecifier(
  env: Pick<ServerEnv, "agentModel">,
) {
  const model = env.agentModel;
  // Already has an explicit provider prefix — pass through as-is.
  if (model.includes(":")) return model;
  // Auto-detect Google models by name prefix.
  if (GOOGLE_MODEL_PREFIXES.some((p) => model.startsWith(p)))
    return `google:${model}`;
  if (DEEPSEEK_MODEL_PREFIXES.some((p) => model.startsWith(p)))
    return `deepseek:${model}`;
  return `openai:${model}`;
}

export function applyOpenAICompatEnv(
  env: Pick<ServerEnv, "openAIApiBase" | "openAIApiKey">,
  target: NodeJS.ProcessEnv = process.env,
) {
  if (env.openAIApiKey) {
    target.OPENAI_API_KEY = env.openAIApiKey;
  }

  if (env.openAIApiBase) {
    target.OPENAI_BASE_URL = env.openAIApiBase;
  }
}
