// @credits-system — Agent tool runtime with credit checks before image/video generation
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { HumanMessage } from "@langchain/core/messages";
import type {
  ImageAttachment,
  ImageGenerationPreference,
  MessageMention,
  RunCancelResponse,
  RunCreateRequest,
  RunCreateResponse,
  StreamEvent,
  VideoGenerationPreference,
} from "@loomic/shared";

import type { ServerEnv } from "../config/env.js";
import { createPipelineLogger } from "../ws/logger.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { AuthenticatedUser, UserSupabaseClient } from "../supabase/user.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
// 一期关闭 execute（D-24，AG-39）：不注入、也不自定义任何代码执行工具
import type { SubmitImageJobFn } from "./tools/image-generate.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import { withBilling } from "../features/credits/with-billing.js";
import {
  getPlanConfig,
  type BillingErrorCode,
  type ImageQualityLevel,
  type VideoResolution,
} from "@loomic/shared";
import { createAgentBackend } from "./backends/index.js";
import {
  type LoomicAgent,
  type LoomicAgentFactory,
  createDefaultModelSpecifier,
  createLoomicDeepAgent,
} from "./deep-agent.js";
import type { AgentPersistenceService } from "./persistence/index.js";
import { adaptDeepAgentStream } from "./stream-adapter.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";
import { loadWorkspaceSkills, type WorkspaceSkillEntry } from "./workspace-skills.js";
import { buildCanvasSummaryForContext } from "./tools/inspect-canvas.js";
import {
  insertImageElement,
  insertImagePlaceholder,
  insertVideoElement,
  removeCanvasElement,
} from "../features/canvas/canvas-element-writer.js";
import { aspectRatioToDimensions } from "../generation/utils.js";

/**
 * Build the text portion of a user message, appending <input_images> XML
 * tags when attachments are present so the LLM can reference them by assetId.
 */
export function buildUserMessage(
  prompt: string,
  attachments: ImageAttachment[],
  imageGenerationPreference?: ImageGenerationPreference,
  mentions: MessageMention[] = [],
  videoGenerationPreference?: VideoGenerationPreference,
  canvasSummary?: string | null,
): { text: string } {
  const xmlBlocks: string[] = [];

  // Canvas state context (auto-injected, not user-provided)
  if (canvasSummary) {
    xmlBlocks.push(`<canvas_state>\n${canvasSummary}\n</canvas_state>`);
  }

  const inputImagesXml = buildInputImagesXml(attachments);
  if (inputImagesXml) xmlBlocks.push(inputImagesXml);

  const imageGenerationPreferenceXml = buildImageGenerationPreferenceXml(
    imageGenerationPreference,
  );
  if (imageGenerationPreferenceXml) xmlBlocks.push(imageGenerationPreferenceXml);

  const videoGenerationPreferenceXml = buildVideoGenerationPreferenceXml(
    videoGenerationPreference,
  );
  if (videoGenerationPreferenceXml) xmlBlocks.push(videoGenerationPreferenceXml);

  const mentionXmlBlocks = buildMentionXmlBlocks(mentions);
  xmlBlocks.push(...mentionXmlBlocks);

  if (!xmlBlocks.length) return { text: prompt };
  return { text: `${prompt}\n\n${xmlBlocks.join("\n\n")}` };
}

function buildInputImagesXml(attachments: ImageAttachment[]): string | null {
  if (attachments.length === 0) return null;

  const imageXml = attachments
    .map((attachment, i) => {
      const nameAttr = attachment.name
        ? ` name="${escapeXmlAttribute(attachment.name)}"`
        : "";
      return `<image index="${i + 1}" asset_id="${escapeXmlAttribute(attachment.assetId)}" mime_type="${escapeXmlAttribute(attachment.mimeType)}"${nameAttr} />`;
    })
    .join("\n  ");

  return `<input_images count="${attachments.length}">\n  ${imageXml}\n</input_images>`;
}

function buildImageGenerationPreferenceXml(
  imageGenerationPreference?: ImageGenerationPreference,
): string | null {
  if (
    imageGenerationPreference?.mode !== "manual" ||
    imageGenerationPreference.models.length === 0
  ) {
    return null;
  }

  const modelXml = imageGenerationPreference.models
    .map(
      (model, i) =>
        `<preferred_model index="${i + 1}" id="${escapeXmlAttribute(model)}" />`,
    )
    .join("\n  ");

  return `<human_image_generation_preference mode="manual" count="${imageGenerationPreference.models.length}">\n  ${modelXml}\n</human_image_generation_preference>`;
}

function buildVideoGenerationPreferenceXml(
  videoGenerationPreference?: VideoGenerationPreference,
): string | null {
  if (
    videoGenerationPreference?.mode !== "manual" ||
    videoGenerationPreference.models.length === 0
  ) {
    return null;
  }

  const modelXml = videoGenerationPreference.models
    .map(
      (model, i) =>
        `<preferred_model index="${i + 1}" id="${escapeXmlAttribute(model)}" />`,
    )
    .join("\n  ");

  return `<human_video_generation_preference mode="manual" count="${videoGenerationPreference.models.length}">\n  ${modelXml}\n</human_video_generation_preference>`;
}

function buildMentionXmlBlocks(mentions: MessageMention[]): string[] {
  const xmlBlocks: string[] = [];

  const mentionedModels = mentions.filter(
    (mention): mention is Extract<MessageMention, { mentionType: "image-model" }> =>
      mention.mentionType === "image-model",
  );
  if (mentionedModels.length > 0) {
    const modelXml = mentionedModels
      .map(
        (mention, i) =>
          `<model index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" display_name="${escapeXmlAttribute(mention.label)}" />`,
      )
      .join("\n  ");

    xmlBlocks.push(
      `<human_image_model_mentions count="${mentionedModels.length}">\n  ${modelXml}\n</human_image_model_mentions>`,
    );
  }

  const mentionedBrandKitAssets = mentions.filter(
    (
      mention,
    ): mention is Extract<MessageMention, { mentionType: "brand-kit-asset" }> =>
      mention.mentionType === "brand-kit-asset",
  );
  if (mentionedBrandKitAssets.length > 0) {
    const assetXml = mentionedBrandKitAssets
      .map((mention, i) => {
        const textContentAttr =
          mention.textContent != null
            ? ` text_content="${escapeXmlAttribute(mention.textContent)}"`
            : "";
        const fileUrlAttr =
          mention.fileUrl != null
            ? ` file_url="${escapeXmlAttribute(mention.fileUrl)}"`
            : "";
        return `<brand_kit_asset index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" type="${escapeXmlAttribute(mention.assetType)}" display_name="${escapeXmlAttribute(mention.label)}"${textContentAttr}${fileUrlAttr} />`;
      })
      .join("\n  ");

    xmlBlocks.push(
      `<human_brand_kit_mentions count="${mentionedBrandKitAssets.length}">\n  ${assetXml}\n</human_brand_kit_mentions>`,
    );
  }

  // Skill mentions — tell the agent to read and follow the mentioned skill
  const mentionedSkills = mentions.filter(
    (
      mention,
    ): mention is Extract<MessageMention, { mentionType: "skill" }> =>
      mention.mentionType === "skill",
  );
  if (mentionedSkills.length > 0) {
    const skillXml = mentionedSkills
      .map(
        (mention, i) =>
          `<skill index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" name="${escapeXmlAttribute(mention.label)}" slug="${escapeXmlAttribute(mention.slug)}">\nThe user explicitly requested this skill. Read \`/workspace-skills/${mention.slug}/SKILL.md\` for full instructions and follow them.\n</skill>`,
      )
      .join("\n  ");
    xmlBlocks.push(
      `<human_skill_mentions count="${mentionedSkills.length}">\n  ${skillXml}\n</human_skill_mentions>`,
    );
  }

  return xmlBlocks;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Build a lookup map from assetId to base64 data URI.
 * Stored in configurable so tools can resolve assetId references.
 */
export function buildAttachmentDataMap(
  downloaded: Array<{ assetId: string; mimeType: string; base64: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const d of downloaded) {
    map[d.assetId] = `data:${d.mimeType};base64,${d.base64}`;
  }
  return map;
}

type RuntimeRunStatus =
  | "accepted"
  | "canceled"
  | "completed"
  | "failed"
  | "running";

type RuntimeRunRecord = RunCreateRequest & {
  accessToken?: string;
  consumed: boolean;
  controller: AbortController;
  modelOverride?: string;
  runId: string;
  status: RuntimeRunStatus;
  threadId?: string;
  userId?: string;
};

type CreateAgentRuntimeOptions = {
  agentPersistenceService?: AgentPersistenceService;
  agentFactory?: LoomicAgentFactory;
  agentRunMetadataService?: AgentRunMetadataService;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => unknown;
  creditService?: CreditService;
  env: ServerEnv;
  eventDelayMs?: number;
  jobService?: JobService;
  model?: BaseLanguageModel | string;
  now?: () => string;
  runIdFactory?: () => string;
  tierGuard?: TierGuard;
  viewerService?: ViewerService;
};

/**
 * canvasId -> fingerprint of the workspace-skill payload already written to the Store.
 *
 * The Store is Postgres-backed and memoized for the lifetime of the process, so
 * re-writing identical SKILL.md files on every turn is pure waste. Measured at
 * ~2.3s per run, it was the single largest item in pre-flight — larger than the
 * model's own time to first token.
 *
 * Keyed by content, not just canvasId, so editing a skill still lands. A process
 * restart empties the map and the first run re-writes: correct by construction,
 * since a fresh process cannot know what the Store already holds.
 */
const writtenWorkspaceSkills = new Map<string, string>();

function fingerprintWorkspaceSkills(skills: WorkspaceSkillEntry[]): string {
  const h = createHash("sha1");
  for (const skill of skills) {
    h.update(skill.name);
    h.update("\u0000");
    h.update(skill.content);
    h.update("\u0000");
    for (const file of skill.files) {
      h.update(file.path);
      h.update("\u0000");
      h.update(file.content);
      h.update("\u0000");
    }
  }
  return h.digest("hex");
}

/**
 * Resolve the brand kit id for a canvas, never rejecting.
 *
 * Extracted from the run pipeline so it can be started concurrently with the
 * other pre-flight lookups. Supabase sits ~180ms away, so running these three
 * independent queries back to back cost more in waiting than in work.
 */
async function resolveBrandKitId(
  createUserClient: (accessToken: string) => unknown,
  accessToken: string,
  canvasId: string,
): Promise<string | null> {
  try {
    const client = createUserClient(accessToken) as any;
    const { data: canvas } = await client
      .from("canvases")
      .select("project_id, projects!inner(brand_kit_id)")
      .eq("id", canvasId)
      .maybeSingle();
    return canvas?.projects?.brand_kit_id ?? null;
  } catch {
    // Fallback: the joined query fails if the FK isn't exposed via PostgREST.
    try {
      const client = createUserClient(accessToken) as any;
      const { data: c } = await client
        .from("canvases")
        .select("project_id")
        .eq("id", canvasId)
        .maybeSingle();
      if (!c?.project_id) return null;
      const { data: p } = await client
        .from("projects")
        .select("brand_kit_id")
        .eq("id", c.project_id)
        .maybeSingle();
      return p?.brand_kit_id ?? null;
    } catch (err) {
      console.warn("Failed to resolve brand kit ID:", err);
      return null;
    }
  }
}

/**
 * Resolve the caller's personal workspace id.
 *
 * Supabase returns `{ data: null, error }` on failure, so destructuring only
 * `{ data }` collapses every distinct failure (statement timeout, RLS denial,
 * expired token, network fault) into the single misleading message
 * "No personal workspace found" — which points debugging at missing data when
 * the row actually exists. Always surface `error` instead.
 */
async function resolvePersonalWorkspaceId(
  client: UserSupabaseClient,
  context: string,
): Promise<string> {
  const { data: ws, error } = await client
    .from("workspaces")
    .select("id")
    .eq("type", "personal")
    .limit(1)
    .single();
  if (error) {
    // console.log (not console.error): the dev runner wraps stderr into an
    // error record and truncates it, hiding the very fields we need.
    console.log(
      `[${context}] personal workspace lookup failed`,
      JSON.stringify({
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      }),
    );
    throw new Error(
      `Personal workspace lookup failed (${error.code ?? "no-code"}): ${error.message}`,
    );
  }
  if (!ws?.id) {
    console.log(`[${context}] personal workspace lookup returned no row`);
    throw new Error("No personal workspace found (query succeeded but returned no row)");
  }
  return ws.id;
}

export type AgentRunService = ReturnType<typeof createAgentRunService>;

export function createAgentRunService(options: CreateAgentRuntimeOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const runs = new Map<string, RuntimeRunRecord>();
  const runIdFactory =
    options.runIdFactory ??
    (() => randomUUID());

  const resolvedAgentFactory: LoomicAgentFactory =
    options.agentFactory ??
    ((agentOptions) =>
      createLoomicDeepAgent({
        ...agentOptions,
        ...(options.createUserClient
          ? { createUserClient: options.createUserClient }
          : {}),
      }));

  // ── Billing error helper: push WS event + abort run ──────────
  function pushBillingErrorAndAbort(
    run: { runId: string; conversationId: string; controller: AbortController },
    canvasId: string | undefined,
    opts: { connectionManager?: ConnectionManager },
    code: BillingErrorCode,
    message: string,
    extra?: {
      currentBalance?: number;
      requiredAmount?: number;
      plan?: string;
      dailyClaimed?: boolean;
    },
  ): void {
    const canvasTarget = canvasId ?? run.conversationId;
    if (!opts.connectionManager || !canvasTarget) {
      console.warn(`[billing] pushBillingErrorAndAbort: no connectionManager or canvasTarget, billing.error (${code}) not sent to client`);
    } else {
      opts.connectionManager.pushToCanvas(canvasTarget, {
        type: "billing.error",
        runId: run.runId,
        timestamp: new Date().toISOString(),
        code,
        message,
        ...extra,
      });
    }
    if (!run.controller.signal.aborted) {
      run.controller.abort();
    }
  }

  return {
    cancelRun(runId: string): RunCancelResponse | null {
      const run = runs.get(runId);
      if (!run) {
        return null;
      }

      if (!run.controller.signal.aborted) {
        run.controller.abort();
      }

      run.status = "canceled";
      return {
        runId,
        status: "canceled",
      };
    },

    createRun(
      input: RunCreateRequest,
      runOptions?: { accessToken?: string; model?: string; threadId?: string; userId?: string },
    ): RunCreateResponse {
      const runId = runIdFactory();
      const { accessToken: _ignoredAccessToken, ...runInput } = input;

      runs.set(runId, {
        ...runInput,
        ...(runOptions?.accessToken ? { accessToken: runOptions.accessToken } : {}),
        consumed: false,
        controller: new AbortController(),
        ...(runOptions?.model ? { modelOverride: runOptions.model } : {}),
        ...(runOptions?.threadId ? { threadId: runOptions.threadId } : {}),
        ...(runOptions?.userId ? { userId: runOptions.userId } : {}),
        runId,
        status: "accepted",
      });

      return {
        conversationId: input.conversationId,
        runId,
        sessionId: input.sessionId,
        status: "accepted",
      };
    },

    hasRun(runId: string) {
      return runs.has(runId);
    },

    async *streamRun(runId: string): AsyncGenerator<StreamEvent> {
      const run = runs.get(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (run.consumed) {
        return;
      }

      run.consumed = true;
      run.status = "running";

      const rlog = createPipelineLogger("runtime", { runId });

      // ── Pre-flight lookups, started together ──
      //
      // Persistence, workspace skills and the brand kit are independent of each
      // other, but used to be awaited one after another. With Supabase ~180ms
      // away, that serialised three round trips for no reason; measured at 2.3s
      // of pure waiting on a warm process. They are kicked off here and awaited
      // at the points that actually need them.
      //
      // Each task is wrapped so it cannot reject: an unawaited rejected promise
      // would surface as an unhandledRejection before the code below reaches its
      // await. The original throw/degrade behaviour is reproduced at each await
      // site instead.
      const persistenceTask: Promise<
        | {
            ok: true;
            value: Awaited<
              ReturnType<NonNullable<AgentPersistenceService["getPersistence"]>>
            > | null;
          }
        | { ok: false; error: unknown }
      > =
        run.threadId && options.agentPersistenceService
          ? options.agentPersistenceService
              .getPersistence()
              .then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              )
          : Promise.resolve({ ok: true as const, value: null });

      const skillsTask: Promise<WorkspaceSkillEntry[]> =
        run.canvasId && run.accessToken && options.createUserClient
          ? loadWorkspaceSkills(
              options.createUserClient(run.accessToken) as UserSupabaseClient,
              run.canvasId,
            ).catch((err) => {
              // Non-fatal: the agent runs without workspace skills.
              console.warn("[runtime] Failed to load workspace skills:", err);
              return [];
            })
          : Promise.resolve([]);

      const brandKitTask: Promise<string | null> =
        run.canvasId && run.accessToken && options.createUserClient
          ? resolveBrandKitId(
              options.createUserClient,
              run.accessToken,
              run.canvasId,
            )
          : Promise.resolve(null);

      try {
        await updatePersistedRunStatus(
          options.agentRunMetadataService,
          run,
          "running",
        );
      } catch (error) {
        const failedEvent = toFailedEvent(runId, now, error);
        run.status = "failed";
        yield failedEvent;
        return;
      }

      let persistence: Awaited<
        ReturnType<NonNullable<AgentPersistenceService["getPersistence"]>>
      > | null = null;
      try {
        const settled = await persistenceTask;
        if (!settled.ok) throw settled.error;
        persistence = settled.value;
        rlog.lap("persistence_init");
      } catch (error) {
        const failedEvent = toFailedEvent(runId, now, error);
        run.status = "failed";
        await updatePersistedRunFailure(
          options.agentRunMetadataService,
          run,
          now,
          error,
        );
        yield failedEvent;
        return;
      }

      if (run.threadId && !persistence) {
        const failedEvent = toFailedEvent(
          runId,
          now,
          new Error("SUPABASE_DB_URL is required for persisted agent threads."),
        );
        run.status = "failed";
        await updatePersistedRunFailure(
          options.agentRunMetadataService,
          run,
          now,
          new Error("SUPABASE_DB_URL is required for persisted agent threads."),
        );
        yield failedEvent;
        return;
      }

      // Build submitImageJob / submitVideoJob closures for async jobs via PGMQ
      let submitImageJob: SubmitImageJobFn | undefined;
      let submitVideoJob: SubmitVideoJobFn | undefined;
      if (options.jobService && options.createUserClient && run.accessToken && run.userId) {
        const jobSvc = options.jobService;
        const createClient = options.createUserClient;
        const accessToken = run.accessToken;
        const userId = run.userId;
        const canvasId = run.canvasId;
        const sessionId = run.sessionId;
        const runId = run.runId;

        submitImageJob = async (input) => {
          const jobT0 = Date.now();
          const jobLap = (label: string, extra?: Record<string, unknown>) => {
            console.log(`[submitImageJob] ${label} +${Date.now() - jobT0}ms`, extra ? JSON.stringify(extra) : "");
          };

          // Look up personal workspace directly — the viewer is already
          // bootstrapped from the normal auth flow, so we skip ensureViewer
          // to avoid its strict email validation on the profile schema.
          const client = createClient(accessToken) as UserSupabaseClient;
          const workspaceId = await resolvePersonalWorkspaceId(client, "submitImageJob");
          jobLap("workspace_resolved", { workspaceId });

          const user: AuthenticatedUser = {
            id: userId,
            accessToken,
            email: "",
            userMetadata: {},
          };

          // Guard + charge + create job. `onRejected` is what makes this differ
          // from the HTTP routes: the client is on a WS run, so a rejection has
          // to be pushed as a billing.error event and abort the run rather than
          // just surface as a status code.
          const { job, creditsCost } = await withBilling(
            { ...options, jobService: jobSvc },
            {
              user,
              workspaceId,
              modelId: input.model,
              guard: {
                jobType: "image_generation",
                quality: (input.quality as ImageQualityLevel) ?? "hd",
              },
              description: `Image generation: ${input.model}`,
              job: {
                payload: {
                  prompt: input.prompt,
                  title: input.title,
                  model: input.model,
                  aspect_ratio: input.aspectRatio,
                  ...(input.inputImages ? { input_images: input.inputImages } : {}),
                },
                refs: {
                  ...(canvasId ? { canvasId } : {}),
                  ...(sessionId ? { sessionId } : {}),
                },
              },
              onRejected: (rejection) => {
                if (rejection.kind === "tier") {
                  pushBillingErrorAndAbort(
                    run, canvasId, options,
                    rejection.error.code, rejection.error.message,
                  );
                } else {
                  pushBillingErrorAndAbort(
                    run, canvasId, options,
                    "insufficient_credits", "Insufficient credits",
                    {
                      currentBalance: rejection.currentBalance,
                      requiredAmount: rejection.requiredAmount,
                      plan: rejection.plan,
                      dailyClaimed: rejection.dailyClaimed,
                    },
                  );
                }
              },
            },
            // The work below (placeholder + polling) stays outside withBilling:
            // the job is on the queue, so the worker owns its outcome and its
            // refund. Returning the job hands control back to the existing flow.
            async (outcome) => outcome,
          );
          if (!job) throw new Error("submitImageJob: withBilling returned no job");
          jobLap("job_created", { jobId: job.id, creditsCost, sessionId, runId });

          const explicitPlacement =
            (input as any).placementX != null && (input as any).placementY != null
              ? {
                  x: (input as any).placementX,
                  y: (input as any).placementY,
                  width: (input as any).placementWidth ?? 512,
                  height: (input as any).placementHeight ?? 512,
                }
              : undefined;

          // LOCAL FORK: reserve the canvas slot NOW, before the job is polled.
          // Upstream inserted nothing until the job succeeded, so the canvas sat
          // empty for the full 30-90s generation with no indication that
          // anything was happening.
          let placeholderElementId: string | undefined;
          let placeholderFilled = false;
          if (canvasId) {
            try {
              const { width: slotW, height: slotH } = aspectRatioToDimensions(
                input.aspectRatio ?? "1:1",
              );
              const slot = await insertImagePlaceholder(
                createClient(accessToken) as UserSupabaseClient,
                {
                  canvasId,
                  width: slotW,
                  height: slotH,
                  ...(input.title ? { title: input.title } : {}),
                },
                explicitPlacement,
              );
              placeholderElementId = slot.elementId;
              options.connectionManager?.pushToCanvas(canvasId, {
                type: "canvas.sync" as const,
                runId,
                timestamp: new Date().toISOString(),
              });
              jobLap("canvas_placeholder_inserted", { elementId: slot.elementId });
            } catch (slotErr) {
              // Non-fatal: without a slot the image simply gets appended later.
              console.error("[submitImageJob] placeholder insert failed:", slotErr);
            }
          }

          try {
          // Poll until terminal state
          // Worker image VT=120s, but Replicate calls can take 100s+ plus queue delay.
          const POLL_INTERVAL = 2000;
          const MAX_WAIT = 240_000; // 4 minutes
          const start = Date.now();
          let pollCount = 0;

          while (Date.now() - start < MAX_WAIT) {
            await delay(POLL_INTERVAL);
            pollCount++;

            if (run.controller.signal.aborted) {
              throw new Error("Run was canceled");
            }

            const current = await jobSvc.getJobAdmin(job.id);

            if (current.status === "succeeded" && current.result) {
              const result = current.result as {
                signed_url?: string;
                object_path?: string;
                width?: number;
                height?: number;
                mime_type?: string;
              };
              jobLap("job_poll_done", { pollCount, status: "succeeded" });

              // Write element directly to canvas (backend-driven insertion)
              let elementId: string | undefined;
              if (canvasId && result.object_path) {
                try {
                  const writerClient = createClient(accessToken) as UserSupabaseClient;

                  const insertResult = await insertImageElement(
                    writerClient,
                    {
                      canvasId,
                      objectPath: result.object_path,
                      width: result.width ?? 1024,
                      height: result.height ?? 1024,
                      mimeType: result.mime_type ?? "image/png",
                      title: input.title,
                      // Fill the slot reserved before polling, so the image lands
                      // exactly where the placeholder was.
                      ...(placeholderElementId
                        ? { replaceElementId: placeholderElementId }
                        : {}),
                    },
                    explicitPlacement,
                  );
                  elementId = insertResult.elementId;
                  placeholderFilled = true;

                  // Notify connected frontends to refresh canvas
                  options.connectionManager?.pushToCanvas(canvasId, {
                    type: "canvas.sync" as const,
                    runId,
                    timestamp: new Date().toISOString(),
                  });
                  jobLap("canvas_element_inserted", { elementId });
                } catch (insertErr) {
                  // Graceful degradation: log error but still return result
                  console.error("[submitImageJob] canvas insert failed:", insertErr);
                }
              }

              return {
                jobId: job.id,
                ...(elementId != null ? { elementId } : {}),
                imageUrl: result.signed_url ?? "",
                width: result.width ?? 1024,
                height: result.height ?? 1024,
                mimeType: result.mime_type ?? "image/png",
              };
            }

            // `failed` is terminal now (a retryable failure is written as
            // `retrying`), so there is nothing to wait for beyond these two.
            if (current.status === "failed" || current.status === "canceled") {
              jobLap("job_poll_done", { pollCount, status: current.status });
              return {
                jobId: job.id,
                error: current.error_message ?? `Job ${current.status}`,
              };
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          return {
            jobId: job.id,
            error: `Job timed out after ${MAX_WAIT / 1000}s`,
          };
          } finally {
            // Covers every exit path — failure, timeout, and the abort throw —
            // so a slot that will never be filled does not stay on the canvas as
            // a permanently empty frame.
            if (canvasId && placeholderElementId && !placeholderFilled) {
              try {
                await removeCanvasElement(
                  createClient(accessToken) as UserSupabaseClient,
                  canvasId,
                  placeholderElementId,
                );
                options.connectionManager?.pushToCanvas(canvasId, {
                  type: "canvas.sync" as const,
                  runId,
                  timestamp: new Date().toISOString(),
                });
                jobLap("canvas_placeholder_removed", {
                  elementId: placeholderElementId,
                });
              } catch (cleanupErr) {
                console.error(
                  "[submitImageJob] placeholder cleanup failed:",
                  cleanupErr,
                );
              }
            }
          }
        };

        submitVideoJob = async (input) => {
          const jobT0 = Date.now();
          const jobLap = (label: string, extra?: Record<string, unknown>) => {
            console.log(`[submitVideoJob] ${label} +${Date.now() - jobT0}ms`, extra ? JSON.stringify(extra) : "");
          };

          const client = createClient(accessToken) as UserSupabaseClient;
          const workspaceId = await resolvePersonalWorkspaceId(client, "submitVideoJob");
          jobLap("workspace_resolved", { workspaceId });

          const user: AuthenticatedUser = {
            id: userId,
            accessToken,
            email: "",
            userMetadata: {},
          };

          const { job, creditsCost } = await withBilling(
            { ...options, jobService: jobSvc },
            {
              user,
              workspaceId,
              modelId: input.model,
              guard: {
                jobType: "video_generation",
                ...(input.duration != null ? { duration: input.duration } : {}),
                ...(input.resolution
                  ? { resolution: input.resolution as VideoResolution }
                  : {}),
              },
              description: `Video generation: ${input.model}`,
              job: {
                payload: {
                  prompt: input.prompt,
                  model: input.model,
                  ...(input.duration != null ? { duration: input.duration } : {}),
                  ...(input.resolution ? { resolution: input.resolution } : {}),
                  ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
                  ...(input.inputImages ? { input_images: input.inputImages } : {}),
                  ...(input.inputVideo ? { input_video: input.inputVideo } : {}),
                  ...(input.enableAudio != null ? { enable_audio: input.enableAudio } : {}),
                },
                refs: {
                  ...(canvasId ? { canvasId } : {}),
                  ...(sessionId ? { sessionId } : {}),
                },
              },
              onRejected: (rejection) => {
                if (rejection.kind === "tier") {
                  pushBillingErrorAndAbort(
                    run, canvasId, options,
                    rejection.error.code, rejection.error.message,
                  );
                } else {
                  pushBillingErrorAndAbort(
                    run, canvasId, options,
                    "insufficient_credits", "Insufficient credits",
                    {
                      currentBalance: rejection.currentBalance,
                      requiredAmount: rejection.requiredAmount,
                      plan: rejection.plan,
                      dailyClaimed: rejection.dailyClaimed,
                    },
                  );
                }
              },
            },
            async (outcome) => outcome,
          );
          if (!job) throw new Error("submitVideoJob: withBilling returned no job");
          jobLap("job_created", { jobId: job.id, creditsCost, sessionId, runId });

          // Poll until terminal state — video generation is slower.
          // Google Vertex Veo can take 300-500s; 600s gives enough headroom
          // to avoid poll timeout while worker is still processing.
          const POLL_INTERVAL = 3000;
          const MAX_WAIT = 600_000; // 10 minutes
          const start = Date.now();
          let pollCount = 0;

          while (Date.now() - start < MAX_WAIT) {
            await delay(POLL_INTERVAL);
            pollCount++;

            if (run.controller.signal.aborted) {
              throw new Error("Run was canceled");
            }

            const current = await jobSvc.getJobAdmin(job.id);

            if (current.status === "succeeded" && current.result) {
              const result = current.result as {
                signed_url?: string;
                duration_seconds?: number;
                width?: number;
                height?: number;
                mime_type?: string;
              };
              jobLap("job_poll_done", { pollCount, status: "succeeded" });

              // Write element directly to canvas (backend-driven insertion)
              let elementId: string | undefined;
              if (canvasId && result.signed_url) {
                try {
                  const writerClient = createClient(accessToken) as UserSupabaseClient;
                  const explicitPlacement = (input as any).placementX != null && (input as any).placementY != null
                    ? {
                        x: (input as any).placementX,
                        y: (input as any).placementY,
                        width: (input as any).placementWidth ?? 640,
                        height: (input as any).placementHeight ?? 360,
                      }
                    : undefined;

                  const insertResult = await insertVideoElement(
                    writerClient,
                    {
                      canvasId,
                      signedUrl: result.signed_url,
                      width: result.width ?? 1280,
                      height: result.height ?? 720,
                      mimeType: result.mime_type ?? "video/mp4",
                      ...(result.duration_seconds != null ? { durationSeconds: result.duration_seconds } : {}),
                      title: (input as any).title,
                      prompt: input.prompt,
                    },
                    explicitPlacement,
                  );
                  elementId = insertResult.elementId;

                  // Notify connected frontends to refresh canvas
                  options.connectionManager?.pushToCanvas(canvasId, {
                    type: "canvas.sync" as const,
                    runId,
                    timestamp: new Date().toISOString(),
                  });
                  jobLap("canvas_element_inserted", { elementId });
                } catch (insertErr) {
                  // Graceful degradation: log error but still return result
                  console.error("[submitVideoJob] canvas insert failed:", insertErr);
                }
              }

              return {
                jobId: job.id,
                ...(elementId != null ? { elementId } : {}),
                videoUrl: result.signed_url ?? "",
                width: result.width ?? 1280,
                height: result.height ?? 720,
                mimeType: result.mime_type ?? "video/mp4",
                ...(result.duration_seconds != null ? { durationSeconds: result.duration_seconds } : {}),
              };
            }

            // `failed` is terminal now (a retryable failure is written as
            // `retrying`), so there is nothing to wait for beyond these two.
            if (current.status === "failed" || current.status === "canceled") {
              jobLap("job_poll_done", { pollCount, status: current.status });
              return {
                jobId: job.id,
                error: current.error_message ?? `Job ${current.status}`,
              };
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          return {
            jobId: job.id,
            error: `Job timed out after ${MAX_WAIT / 1000}s`,
          };
        };

      }

      // Load workspace skills (user-installed skills from DB).
      // Done before backend creation so we know whether to add the
      // /workspace-skills/ Store route.
      // Started above alongside persistence and the brand kit; by now it is
      // usually already resolved.
      const workspaceSkills: WorkspaceSkillEntry[] = await skillsTask;
      rlog.lap("workspace_skills_loaded", { count: workspaceSkills.length });

      // Create backend — production uses StateBackend (no local shell).
      const backendResult = createAgentBackend(
        options.env,
        run.canvasId,
        { hasWorkspaceSkills: workspaceSkills.length > 0 },
      );

      try {
      let agent: LoomicAgent;
      try {
        const resolvedModel = run.modelOverride
          ? (run.modelOverride.includes(":")
            ? run.modelOverride
            : createDefaultModelSpecifier({ agentModel: run.modelOverride }))
          : options.model;

        // Build persistImage closure using the user's Supabase client.
        // Client creation is deferred into the closure so it only runs
        // when an image is actually generated (avoids throwing in tests
        // that don't configure Supabase env vars).
        let persistImage: ((url: string, mime: string, prompt: string) => Promise<string>) | undefined;
        if (options.createUserClient && run.accessToken) {
          const createClient = options.createUserClient;
          const accessToken = run.accessToken;
          persistImage = async (sourceUrl, mimeType, prompt) => {
            const client = createClient(accessToken) as UserSupabaseClient;
            const response = await fetch(sourceUrl);
            if (!response.ok) throw new Error(`Download failed: ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            const ext = mimeType === "image/webp" ? "webp" : "png";
            const slug = prompt.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
            const fileName = `gen-${slug}-${Date.now()}.${ext}`;

            // The RLS policy on storage.objects requires the FIRST path segment
            // to be a workspace UUID the caller belongs to. Falling back to
            // "default" would therefore always be rejected, so fail loudly here
            // instead of building a path that cannot possibly work.
            const { data: ws, error: wsError } = await client
              .from("workspaces")
              .select("id")
              .eq("type", "personal")
              .limit(1)
              .single();
            if (wsError || !ws?.id) {
              throw new Error(
                `Cannot resolve personal workspace for storage path: ${wsError?.message ?? "no row"}`,
              );
            }
            const objectPath = `${ws.id}/${Date.now()}-${fileName}`;

            // LOCAL FORK: retry the upload. Storage latency on a free instance
            // (ours is ap-southeast-2) was measured swinging between 0.5s and
            // 16s, and a single transient DatabaseTimeout used to fall through
            // to the caller's fallback, which embedded the whole image as a
            // base64 data URI in the canvas document.
            const MAX_ATTEMPTS = 3;
            let lastError: unknown;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
              const { error: uploadError } = await client.storage
                .from("project-assets")
                .upload(objectPath, buffer, {
                  contentType: mimeType,
                  upsert: false,
                });
              if (!uploadError) {
                const { data: urlData } = client.storage
                  .from("project-assets")
                  .getPublicUrl(objectPath);
                return urlData.publicUrl;
              }
              lastError = uploadError;
              console.warn(
                `[persistImage] upload attempt ${attempt}/${MAX_ATTEMPTS} failed: ${uploadError.message}`,
              );
              if (attempt < MAX_ATTEMPTS) {
                await new Promise((r) => setTimeout(r, 1500 * attempt));
              }
            }

            throw new Error(
              `Upload failed after ${MAX_ATTEMPTS} attempts: ${
                lastError instanceof Error
                  ? lastError.message
                  : String((lastError as { message?: string })?.message ?? lastError)
              }`,
            );
          };
        }

        // Started above alongside persistence and the skills load.
        const brandKitId: string | null = await brandKitTask;
        rlog.lap("brand_kit_resolved");

        // Pre-write workspace skill SKILL.md files AND associated files
        // (scripts/, references/, assets/) into the Store so the agent can
        // read_file them via the /workspace-skills/ route.
        const store = persistence?.store;
        const skillsFingerprint =
          workspaceSkills.length > 0 ? fingerprintWorkspaceSkills(workspaceSkills) : "";
        const skillsAlreadyWritten =
          !!run.canvasId &&
          skillsFingerprint !== "" &&
          writtenWorkspaceSkills.get(run.canvasId) === skillsFingerprint;

        if (skillsAlreadyWritten) {
          rlog.lap("workspace_skills_cached", { count: workspaceSkills.length });
        } else if (workspaceSkills.length > 0 && store && run.canvasId) {
          const storeNamespace = ["projects", run.canvasId, "workspace-skills"];
          const now_ = new Date().toISOString();

          const writeOps: Promise<void>[] = [];
          for (const skill of workspaceSkills) {
            // Write SKILL.md
            writeOps.push(
              store.put(storeNamespace, `/${skill.name}/SKILL.md`, {
                content: skill.content.split("\n"),
                created_at: now_,
                modified_at: now_,
              }),
            );
            // Write associated files (scripts/, references/, assets/)
            for (const file of skill.files) {
              writeOps.push(
                store.put(storeNamespace, `/${skill.name}/${file.path}`, {
                  content: file.content.split("\n"),
                  created_at: now_,
                  modified_at: now_,
                }),
              );
            }
          }

          // Timed separately: this sits on the critical path before the model is
          // even called, so it is part of what the user sees as "thinking".
          const writeT0 = Date.now();
          await Promise.all(writeOps);
          const writeMs = Date.now() - writeT0;
          // Recorded only after the writes land, so a failed write is retried on
          // the next turn instead of being cached as done.
          writtenWorkspaceSkills.set(run.canvasId, skillsFingerprint);
          const totalFiles = workspaceSkills.reduce((sum, s) => sum + s.files.length, 0);
          rlog.lap("workspace_skills_stored", {
            count: workspaceSkills.length,
            files: totalFiles,
            puts: writeOps.length,
            writeMs,
          });
        }

        agent = resolvedAgentFactory({
          backendResult,
          ...(brandKitId ? { brandKitId } : {}),
          ...(run.canvasId ? { canvasId: run.canvasId } : {}),
          ...(persistence ? { checkpointer: persistence.checkpointer } : {}),
          ...(options.connectionManager ? { connectionManager: options.connectionManager } : {}),
          env: options.env,
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(persistImage ? { persistImage } : {}),
          // 一期关闭 execute（D-24，AG-39），无需在这里传递任何执行工具
          ...(submitImageJob ? { submitImageJob } : {}),
          ...(submitVideoJob ? { submitVideoJob } : {}),
          ...(persistence ? { store: persistence.store } : {}),
          ...(workspaceSkills.length > 0 ? { workspaceSkills } : {}),
        });
        rlog.lap("agent_factory_done");
      } catch (error) {
        const failedEvent = toFailedEvent(runId, now, error);
        run.status = "failed";
        await updatePersistedRunFailure(options.agentRunMetadataService, run, now, error);
        yield failedEvent;
        return;
      }

      let stream: AsyncIterable<unknown>;
      try {
        // Auto-inject canvas state summary so the agent has immediate awareness
        // of what's on the canvas without needing to call inspect_canvas first.
        let canvasSummary: string | null = null;
        if (run.canvasId && run.accessToken && options.createUserClient) {
          try {
            const canvasClient = options.createUserClient(run.accessToken) as any;
            const { data: canvasData } = await canvasClient
              .from("canvases")
              .select("content")
              .eq("id", run.canvasId)
              .single();
            if (canvasData?.content?.elements) {
              canvasSummary = buildCanvasSummaryForContext(
                canvasData.content.elements as Array<Record<string, unknown>>,
              );
            }
          } catch {
            // Non-critical — agent can still call inspect_canvas manually
          }
        }

        const hasAttachments = run.attachments && run.attachments.length > 0;
        let userMessage: HumanMessage;
        let attachmentDataMap: Record<string, string> = {};

        if (hasAttachments) {
          // Download images and build parallel data structures:
          // 1. imageBlocks: base64 content parts for LLM vision
          // 2. downloaded: assetId → base64 mapping for tool resolution
          const downloaded: Array<{ assetId: string; mimeType: string; base64: string }> = [];
          const imageBlocks = await Promise.all(
            run.attachments!.map(async (a) => {
              // What goes into the message decides what gets CHECKPOINTED, and the
              // message list is reloaded, re-sent and rewritten on every single
              // turn. Inlining base64 here grew one thread's `messages` channel to
              // 25.6 MB, which cost ~36s to load, ~40s to upload to the model and
              // ~16s to write back — for a two-character reply. A URL is ~200 bytes
              // and the gateway fetches the image itself (verified against kwjm).
              //
              // `project-assets` is a public bucket and generated images get
              // permanent public URLs, so a URL stored in history keeps working on
              // later turns.
              const isHttpUrl = /^https?:\/\//.test(a.url);

              try {
                let b64: string;
                let mime: string;

                // Handle data URIs directly (canvas-ref images) — no fetch needed
                const dataUriMatch = a.url.match(/^data:([^;]+);base64,(.+)$/);
                if (dataUriMatch) {
                  mime = dataUriMatch[1]!;
                  b64 = dataUriMatch[2]!;
                } else {
                  const res = await fetch(a.url);
                  const buf = Buffer.from(await res.arrayBuffer());
                  mime = a.mimeType || res.headers.get("content-type") || "image/png";
                  b64 = buf.toString("base64");
                }

                // The tool-side map is passed through `configurable`, which is NOT
                // part of the checkpointed graph state — so tools keep their bytes
                // without those bytes ending up in history.
                downloaded.push({ assetId: a.assetId, mimeType: mime, base64: b64 });

                // Use standard LangChain image_url format — works with both
                // Google Gemini and OpenAI adapters. The Anthropic-style
                // { type: "image", source_type: "base64" } format is NOT
                // recognized by @langchain/google-genai and gets serialized
                // as raw text, blowing past the token limit.
                //
                // `image_url` MUST be the `{ url }` object form, not a bare
                // string. @langchain/openai passes unrecognized content parts
                // through verbatim (converters/completions.ts: `return m`), so a
                // string reaches the OpenAI-compatible gateway as-is and is
                // rejected: `invalid type: string "data:image/webp;base64,…",
                // expected struct OpenAICompletionImageUrl`. Gemini accepts both
                // forms, which is why the string form went unnoticed.
                return {
                  type: "image_url" as const,
                  image_url: { url: isHttpUrl ? a.url : `data:${mime};base64,${b64}` },
                };
              } catch {
                return {
                  type: "image_url" as const,
                  image_url: { url: a.url },
                };
              }
            }),
          );

          // Build XML text tags for LLM to reference by assetId
          const { text: enrichedPrompt } = buildUserMessage(
            run.prompt,
            run.attachments!,
            run.imageGenerationPreference,
            run.mentions,
            run.videoGenerationPreference,
            canvasSummary,
          );

          // Build assetId → data URI map for tool-level resolution
          attachmentDataMap = buildAttachmentDataMap(downloaded);

          userMessage = new HumanMessage({
            content: [
              { type: "text" as const, text: enrichedPrompt },
              ...imageBlocks,
            ],
          });
        } else {
          const { text: enrichedPrompt } = buildUserMessage(
            run.prompt,
            [],
            run.imageGenerationPreference,
            run.mentions,
            run.videoGenerationPreference,
            canvasSummary,
          );
          userMessage = new HumanMessage(enrichedPrompt);
        }

        rlog.lap("stream_call_start");
        stream = agent.streamEvents(
          {
            messages: [userMessage],
          },
          {
            ...(run.threadId || run.canvasId || run.accessToken || run.userId || Object.keys(attachmentDataMap).length > 0
              ? {
                  configurable: {
                    ...(run.threadId ? { thread_id: run.threadId } : {}),
                    ...(run.canvasId ? { canvas_id: run.canvasId } : {}),
                    ...(run.accessToken ? { access_token: run.accessToken } : {}),
                    ...(run.userId ? { user_id: run.userId } : {}),
                    ...(Object.keys(attachmentDataMap).length > 0
                      ? { user_attachment_map: attachmentDataMap }
                      : {}),
                  },
                }
              : {}),
            signal: run.controller.signal,
            version: "v2",
          },
        );
        rlog.lap("stream_call_returned");
      } catch (error) {
        const failedEvent = toFailedEvent(runId, now, error);
        run.status = "failed";
        await updatePersistedRunFailure(options.agentRunMetadataService, run, now, error);
        yield failedEvent;
        return;
      }

      try {
      for await (const event of adaptDeepAgentStream({
        conversationId: run.conversationId,
        now,
        runId,
        sessionId: run.sessionId,
        signal: run.controller.signal,
        stream,
      })) {
        run.status = mapEventToStatus(event);
        try {
          await syncPersistedRunFromEvent(
            options.agentRunMetadataService,
            run,
            event,
            now,
          );
        } catch (error) {
          const failedEvent = toFailedEvent(runId, now, error);
          run.status = "failed";
          yield failedEvent;
          return;
        }
        yield event;

        if (!isTerminalEvent(event) && options.eventDelayMs) {
          try {
            await delay(options.eventDelayMs, undefined, {
              signal: run.controller.signal,
            });
          } catch {
            run.status = "canceled";
            yield {
              runId,
              timestamp: now(),
              type: "run.canceled",
            };
            return;
          }
        }
      }
      } catch (streamError) {
        // Catch DB / checkpoint errors that bubble up from the LangGraph stream
        // (e.g. Supabase circuit-breaker, connection pool exhaustion).
        // Instead of crashing the process, yield a clean failure event.
        console.error("[agent-runtime] Stream iteration failed:", streamError);
        const failedEvent = toFailedEvent(runId, now, streamError);
        run.status = "failed";
        await updatePersistedRunFailure(options.agentRunMetadataService, run, now, streamError).catch(
          (persistErr) => console.error("[agent-runtime] Failed to persist run failure:", persistErr),
        );
        yield failedEvent;
        return;
      }
      } finally {
        if (backendResult.sandboxDir) {
          rm(backendResult.sandboxDir, { recursive: true, force: true }).catch(
            (err) => console.warn("[sandbox] cleanup failed:", err.message),
          );
        }
      }
    },
  };
}


function isTerminalEvent(event: StreamEvent) {
  return (
    event.type === "run.canceled" ||
    event.type === "run.completed" ||
    event.type === "run.failed"
  );
}

function mapEventToStatus(event: StreamEvent): RuntimeRunStatus {
  switch (event.type) {
    case "run.canceled":
      return "canceled";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    default:
      return "running";
  }
}

function toFailedEvent(
  runId: string,
  now: () => string,
  error: unknown,
): StreamEvent {
  // Log full error detail server-side
  console.error(`[runtime] Agent run failed for run ${runId}:`, error);

  return {
    error: {
      code: "run_failed",
      message: sanitizeErrorForClient(error),
    },
    runId,
    timestamp: now(),
    type: "run.failed",
  };
}

async function updatePersistedRunStatus(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  status: "running" | "completed",
  options?: {
    completedAt?: string;
  },
) {
  if (!agentRunMetadataService || !run.threadId) {
    return;
  }

  await agentRunMetadataService.updateRun({
    ...(options?.completedAt ? { completedAt: options.completedAt } : {}),
    runId: run.runId,
    status,
  });
}

async function updatePersistedRunFailure(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  now: () => string,
  error: unknown,
) {
  if (!agentRunMetadataService || !run.threadId) {
    return;
  }

  await agentRunMetadataService.updateRun({
    completedAt: now(),
    errorCode: "run_failed",
    errorMessage:
      error instanceof Error ? error.message : "Deep agent runtime failed.",
    runId: run.runId,
    status: "failed",
  });
}

async function syncPersistedRunFromEvent(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  event: StreamEvent,
  now: () => string,
) {
  if (event.type === "run.completed") {
    await updatePersistedRunStatus(agentRunMetadataService, run, "completed", {
      completedAt: now(),
    });
    return;
  }

  if (event.type === "run.failed") {
    await updatePersistedRunFailure(
      agentRunMetadataService,
      run,
      now,
      new Error(event.error.message),
    );
  }
}
