import type { FastifyInstance } from "fastify";

import { type ModelInfo, modelListResponseSchema } from "@loomic/shared";
import type { ServerEnv } from "../config/env.js";

// LOCAL FORK: replaced upstream's hardcoded OpenAI catalogue with the models
// this deployment's kwjm (开物基模) gateway key can actually call. Verified by
// probing /v1/chat/completions with 8-token requests — /v1/models lists the
// whole platform catalogue (119 entries) and does NOT reflect per-key
// permissions, so it cannot be trusted for this.
//
// Ordered by tool-calling strength because the UI selects the first entry by
// default and Loomic drives deepagents + LangGraph, which needs reliable
// function calling. Sonnet is first rather than Opus to keep the default cost
// reasonable for everyday use.
//
// Denied on this key (do NOT re-add without re-probing): every gemini-*,
// deepseek-*, gpt-4.1, gpt-4o, o3-mini, gpt-5.2.
const OPENAI_MODELS: ModelInfo[] = [
  { id: "openai:claude-sonnet-5", name: "Claude Sonnet 5", provider: "openai" },
  { id: "openai:claude-opus-5", name: "Claude Opus 5", provider: "openai" },
  { id: "openai:gpt-5.5", name: "GPT-5.5", provider: "openai" },
  { id: "openai:gpt-5.4", name: "GPT-5.4", provider: "openai" },
  {
    id: "openai:claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    provider: "openai",
  },
  { id: "openai:qwen3.7-max", name: "Qwen3.7 Max", provider: "openai" },
  { id: "openai:qwen3.7-plus", name: "Qwen3.7 Plus", provider: "openai" },
  { id: "openai:qwen3.5-plus", name: "Qwen3.5 Plus", provider: "openai" },
  { id: "openai:qwen3.5-flash", name: "Qwen3.5 Flash", provider: "openai" },
  { id: "openai:glm-5.2", name: "GLM-5.2", provider: "openai" },
  { id: "openai:kimi-k3", name: "Kimi K3", provider: "openai" },
  { id: "openai:MiniMax-M3", name: "MiniMax M3", provider: "openai" },
];

// DeepSeek's own endpoint. Ordered by measured total latency (median of 3 runs,
// same system prompt and tool schemas as the kwjm probes above):
//   deepseek-chat            174ms TTFT / 1022ms total  <- fastest of everything
//   deepseek-v4-flash-vision  95 / 1102
//   deepseek-reasoner        114 / 1791
//   deepseek-v4-flash        144 / 1926
//   deepseek-v4-pro           95 / 1928
// All five emit tool calls, and all five accept image input despite the docs
// claiming only the -vision-exp build does.
const DEEPSEEK_MODELS: ModelInfo[] = [
  { id: "deepseek:deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" },
  {
    id: "deepseek:deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash (Vision)",
    provider: "deepseek",
  },
  { id: "deepseek:deepseek-reasoner", name: "DeepSeek Reasoner", provider: "deepseek" },
  { id: "deepseek:deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek" },
  { id: "deepseek:deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek" },
];

// Aether, the LAN gateway. Its /v1/models IS trustworthy (7 entries, all of
// which answered), unlike kwjm's. Ordered by measured total latency, median of 3:
//   gpt-5.6-luna     1988 / 2200
//   claude-haiku-4.5 1859 / 2367
//   gpt-5.6-terra    2162 / 2797
//   gpt-5.6-sol      2584 / 3372
//   claude-sonnet-5  3402 / 4255
//   claude-opus-5    2401 / 4284
//   claude-opus-4.8  5115 / 5159
// All seven emit tool calls. Slower than DeepSeek direct across the board, kept
// because this gateway does not depend on the local proxy: kwjm.com and
// api.deepseek.com both resolve into Clash's fake-ip range (198.18.0.0/15), so
// if the proxy stops, those two die and this one still answers.
const AETHER_MODELS: ModelInfo[] = [
  { id: "aether:gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "aether" },
  { id: "aether:claude-haiku-4.5", name: "Claude Haiku 4.5", provider: "aether" },
  { id: "aether:gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "aether" },
  { id: "aether:gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "aether" },
  { id: "aether:claude-sonnet-5", name: "Claude Sonnet 5", provider: "aether" },
  { id: "aether:claude-opus-5", name: "Claude Opus 5", provider: "aether" },
  { id: "aether:claude-opus-4.8", name: "Claude Opus 4.8", provider: "aether" },
];

const GOOGLE_MODELS: ModelInfo[] = [
  // Gemini 3 series (Preview)
  { id: "google:gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", provider: "google" },
  { id: "google:gemini-3-flash-preview", name: "Gemini 3 Flash", provider: "google" },
  { id: "google:gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite", provider: "google" },
  // Gemini 2.5 series (GA)
  { id: "google:gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
  { id: "google:gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
  { id: "google:gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", provider: "google" },
];

export async function registerModelRoutes(app: FastifyInstance, env: ServerEnv) {
  app.get("/api/models", async (_request, reply) => {
    const models: ModelInfo[] = [];
    // DeepSeek first: it is the current default and the fastest measured.
    // These two read process.env directly, matching how createStreamingChatModel
    // in deep-agent.ts decides whether the provider is available -- the listing
    // and the routing must agree on the same source, or the UI offers a model
    // that then silently falls back to OpenAI.
    if (process.env.DEEPSEEK_API_KEY) models.push(...DEEPSEEK_MODELS);
    if (env.openAIApiKey) models.push(...OPENAI_MODELS);
    if (process.env.AETHER_API_KEY) models.push(...AETHER_MODELS);
    if (env.googleApiKey || env.googleVertexProject) models.push(...GOOGLE_MODELS);
    return reply.code(200).send(modelListResponseSchema.parse({ models }));
  });
}
