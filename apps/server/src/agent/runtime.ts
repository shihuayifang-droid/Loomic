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
import type {
  AssetReadRepository,
  AssetReadRow,
} from "../db/asset-read-repository.js";
import type { AssetWriteRepository } from "../db/asset-write-repository.js";
import type { BrandKitReadRepository } from "../db/brand-kit-read-repository.js";
import type {
  CanvasProjectLinkRow,
  CanvasReadRepository,
} from "../db/canvas-read-repository.js";
import type { WorkspaceSkillReadRepository } from "../db/workspace-skill-read-repository.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { AdminSupabaseClient } from "../supabase/admin.js";
import type { AuthenticatedUser, UserSupabaseClient } from "../supabase/user.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import {
  createAgentProjectAssetService,
} from "../features/storage/agent-project-assets.js";
import {
  PROJECT_ASSET_BUCKET,
  signProjectAssetUrl,
} from "../features/storage/project-asset-urls.js";
// 一期关闭 execute（D-24，AG-39）：不注入、也不自定义任何代码执行工具
import type { PersistImageFn, SubmitImageJobFn } from "./tools/image-generate.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import { withBilling } from "../features/credits/with-billing.js";
import type { CreditLedgerWriteRepository } from "../db/credit-ledger-write-repository.js";
import type { PriceQuoter } from "../features/pricing/price-quoter.js";
import {
  getPlanConfig,
  type BillingErrorCode,
  type ImageQualityLevel,
  type VideoResolution,
} from "@loomic/shared";
import { createAgentBackend } from "./backends/index.js";
import { startAgentJobProgress } from "./agent-job-progress.js";
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
  markGenerationSlotFailed,
  removeCanvasElement,
  toRetryRequest,
} from "../features/canvas/canvas-element-writer.js";
import { aspectRatioToDimensions } from "../generation/utils.js";
import { slotOutcomeForStop } from "../features/canvas/generation-slot-outcome.js";

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

/**
 * AG-03: a text asset mentioned with @ is injected into the prompt, but never
 * more than this many characters (counted as JS string length). Longer text is
 * cut and the element says so, so the agent knows it saw only the beginning.
 *
 * Length is `String.prototype.length`, i.e. UTF-16 code units: common CJK
 * characters count as 1. Cutting at this boundary may in principle split a
 * surrogate pair; that edge case is not handled here.
 */
export const MENTION_TEXT_MAX_CHARS = 4000;

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
        const raw = mention.textContent;
        let textContentAttr = "";
        if (raw != null) {
          const cut = raw.length > MENTION_TEXT_MAX_CHARS;
          const text = cut ? raw.slice(0, MENTION_TEXT_MAX_CHARS) : raw;
          textContentAttr = ` text_content="${escapeXmlAttribute(text)}"${cut ? ' truncated="true"' : ""}`;
        }
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

/** What one round of attachment resolution produced. */
export type ResolvedAttachments = {
  /** Content parts for the model, in the order the attachments arrived. */
  imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }>;
  /** The same bytes, for the tool-side map — NOT part of the checkpointed state. */
  downloaded: Array<{ assetId: string; mimeType: string; base64: string }>;
};

/**
 * Resolve the run's attachments to bytes the model can actually receive (X-52).
 *
 * The request carries an `assetId` and, from an older client, a `url`. Only the
 * `assetId` is input. The URL is not read, not compared and not logged: it is
 * the browser's own projection of a SIGNATURE, and a signature is rotatable, so
 * "the client's URL differs from the one I just minted" proves nothing about
 * whether the assetId is forged — an expired token, a sessionStorage-restored
 * preview or a different signing clock all produce that difference for an asset
 * the caller is fully entitled to. The authority is whether the asset ROW is
 * readable by the run's own actor at all, which is what the repository's
 * actor-carrying statement re-applies below.
 *
 * 工单14 fixup T1: the previous byte-equality check (`signedUrl !==
 * attachment.url`) is removed. It rejected exactly the legitimate rotation it
 * was meant to tolerate, and `use-image-attachments.test.ts` case 5 already
 * declares a stale preview legal — the two could not both be true.
 *
 * 工单21S: that row read no longer travels through the caller's PostgREST
 * client. `AssetReadRepository.findReadableAsset` answers it in SQL that carries
 * the run's actor id and re-applies the asset's read ACL inside the statement —
 * the same two branches the replaced policy had, and, like it, with no archive
 * filter. Only the SIGNING step still needs the caller's client, because a
 * signature has to be minted for the token the caller actually holds.
 *
 * The bytes the model sees therefore come from the row behind the `assetId`,
 * read for the CALLER's actor id and signed with the CALLER's JWT by the ONE
 * signing service — never from anything in the request body.
 *
 * Three refusals, all before the model is called:
 *   * the asset does not exist or the caller cannot see it,
 *   * the row cannot be signed for this caller,
 *   * the bytes cannot be fetched from the signed URL.
 *
 * Every way the FIRST refusal can happen — no repository, no actor id, a read
 * that threw, a read that answered no row — produces that one sentence letter
 * for letter. The reason is not disclosed and no driver text is carried into
 * it, so a failed read cannot be told apart from an asset that is not there.
 *
 * A refusal here is deliberate rather than lenient: falling back to the
 * client-supplied URL would mean the model's input is chosen by the request body
 * instead of by the database, which is the whole "客户端assetId配任意URL" trap in
 * the ticket's §5. The error text never contains a URL — a signed URL is a
 * bearer token.
 */
export async function resolveAttachmentContent(
  input: {
    /** Answers the asset row for the run's actor; no row means "not readable". */
    repository: AssetReadRepository | undefined;
    /** The run's own user id — the actor the row has to be readable by. */
    actorId: string | undefined;
    /** Mints the storage signature for the caller. Reads no table of its own. */
    signingClient: UserSupabaseClient;
  },
  attachments: ImageAttachment[],
): Promise<ResolvedAttachments> {
  const { repository, actorId, signingClient } = input;
  const imageBlocks: ResolvedAttachments["imageBlocks"] = [];
  const downloaded: ResolvedAttachments["downloaded"] = [];

  for (const [index, attachment] of attachments.entries()) {
    let assetRow: AssetReadRow | null = null;

    try {
      // A read is only attempted with BOTH an actor and a repository: an
      // actor-less read would be a privileged read for nobody.
      assetRow =
        repository && actorId
          ? await repository.findReadableAsset({
              actorId,
              assetId: attachment.assetId,
            })
          : null;
    } catch {
      // The driver's own text is dropped on purpose: it can carry the
      // statement, a host or a credential, and echoing it would also make a
      // failed read distinguishable from a row that is simply not there.
      assetRow = null;
    }

    if (!assetRow) {
      // Which way the read failed is deliberately not disclosed: a row the
      // caller cannot see, a row that does not exist, a read that could not be
      // attempted and a read that threw must all be indistinguishable, or the
      // error becomes an existence oracle for other people's assets.
      throw new Error(
        `attachment ${index + 1} references an asset that is not available to this user`,
      );
    }

    let signedUrl: string;
    try {
      signedUrl = await signProjectAssetUrl(
        signingClient,
        assetRow.object_path,
        { bucket: assetRow.bucket },
      );
    } catch {
      throw new Error(
        `attachment ${index + 1} could not be authorised for reading`,
      );
    }

    const response = await fetch(signedUrl);
    if (!response.ok) {
      throw new Error(
        `attachment ${index + 1} could not be fetched from storage (${response.status})`,
      );
    }

    const mimeType =
      attachment.mimeType ||
      assetRow.mime_type ||
      response.headers.get("content-type") ||
      "image/png";
    const base64 = Buffer.from(await response.arrayBuffer()).toString("base64");

    downloaded.push({ assetId: attachment.assetId, mimeType, base64 });
    imageBlocks.push({
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${base64}` },
    });
  }

  return { imageBlocks, downloaded };
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
  /**
   * Asset read repository (workorder 21S). The row behind an attachment's
   * `assetId` is a pure read of one asset, so it goes through actor-carrying SQL
   * that re-applies the asset's read ACL instead of the caller's PostgREST
   * client. Optional here and fatal per attachment: without it no attachment can
   * be resolved, which is the same refusal a row the caller cannot read already
   * produced, and never a fallback to the URL in the request body.
   */
  assetReadRepository?: AssetReadRepository;
  /**
   * Asset write repository (workorder 21AC). The compensation that removes the
   * `asset_objects` row of a failed signing is a delete with the asset's own
   * policy, so it goes through the repository the upload service already uses.
   * Required: it is the only way that row can be removed, and a missing one would
   * leave a half-created asset behind.
   */
  assetWriteRepository: AssetWriteRepository;
  /**
   * Brand kit read repository (workorder 21AC). `get_brand_kit`'s two reads are
   * owner-keyed and belong to `brand-kit-read-repository.ts`. Required: without
   * it the tool must not be offered at all, and "offered but unable to read" is
   * the failure mode a required dependency prevents.
   */
  brandKitReadRepository: BrandKitReadRepository;
  /**
   * Canvas read repository (workorder 20C, made REQUIRED by 21AC). The automatic
   * canvas summary, the run's canvas → project link and (since 21AC) the
   * workspace every persisted asset is filed under all read through it, so a
   * missing one would silently drop all three.
   */
  canvasReadRepository: CanvasReadRepository;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => unknown;
  /**
   * Service-role client getter (X-52). Injected from app.ts so Agent-produced
   * media can record its ownership through `record_project_asset`; without it
   * the persist path has no way to write metadata and refuses instead of
   * returning a URL with no owner.
   */
  getAdminClient?: () => AdminSupabaseClient;
  creditService?: CreditService;
  env: ServerEnv;
  eventDelayMs?: number;
  jobService?: JobService;
  model?: BaseLanguageModel | string;
  now?: () => string;
  runIdFactory?: () => string;
  tierGuard?: TierGuard;
  /**
   * Workorder 31B: the price of a generation comes from the price table, and a
   * PENDING price leaves a 0-amount ledger row. Both reach `withBilling` through
   * `{ ...options }`, which refuses to run with billing on and no quoter.
   */
  priceQuoter?: PriceQuoter;
  creditLedgerWriteRepository?: CreditLedgerWriteRepository;
  viewerService?: ViewerService;
  /**
   * Workspace skill read repository (workorder 21AC). The enabled skills of the
   * run's workspace and their bundled files are one repository read each, with
   * the membership and skill-visibility policies written into the statements.
   * Required: the loader degrades to "no skills" on a FAILED read, so an unwired
   * repository would silently remove every workspace skill from every run.
   */
  workspaceSkillReadRepository: WorkspaceSkillReadRepository;
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
 * The canvas's project link for one run, never rejecting (workorder 21R).
 *
 * Three separate pre-flight answers come from this one read: the project's brand
 * kit, the workspace whose skills the run loads, and the project a generation job
 * must be authorised against. The Agent run asks the canvas repository with the
 * REAL actor id, so a canvas the caller cannot read answers `null` rather than
 * leaking a project the caller has no membership in.
 *
 * Every reason not to answer — no repository, no actor, no canvas, an unreadable
 * canvas, a repository error — ends as `null`. The brand kit then simply is not
 * injected and the run loads no workspace skills, which is exactly the
 * degradation the three separate lookups already produced. Extracted so the two
 * properties that matter are testable on their own: what the repository is asked,
 * and that no failure here can fail the run.
 */
export async function readCanvasProjectLinkForRun(input: {
  repository: CanvasReadRepository | undefined;
  actorId: string | undefined;
  canvasId: string | undefined;
}): Promise<CanvasProjectLinkRow | null> {
  const { repository, actorId, canvasId } = input;
  if (!repository || !actorId || !canvasId) return null;

  try {
    return await repository.findReadableCanvasProjectLink({
      actorId,
      canvasId,
    });
  } catch {
    // Non-critical, and the message is fixed text: a driver error that embeds
    // the statement, a host or a credential must not reach a log line through
    // this path.
    console.warn("[runtime] canvas project link lookup failed");
    return null;
  }
}

/**
 * The automatic canvas summary injected before the model's first turn.
 *
 * Read through the canvas repository (workorder 20C) with the REAL actor id and
 * canvas id of the run, so a canvas the caller cannot read returns nothing
 * rather than its content. Extracted from the stream pipeline so the two
 * properties that matter are testable on their own: what the repository is
 * asked, and that no failure here can fail the Agent run.
 *
 * Every reason not to answer — no repository, no actor, no canvas, an
 * unreadable canvas, a repository error — ends as `null`, which is exactly the
 * "no automatic summary" the stream already degrades to. The agent can still
 * call `inspect_canvas` itself.
 */
export async function readCanvasSummaryForRun(input: {
  repository: CanvasReadRepository | undefined;
  actorId: string | undefined;
  canvasId: string | undefined;
}): Promise<string | null> {
  const { repository, actorId, canvasId } = input;
  if (!repository || !actorId || !canvasId) return null;

  try {
    const readable = await repository.findReadableCanvasContent({
      actorId,
      canvasId,
    });

    const elements = (readable?.content as { elements?: unknown } | null)
      ?.elements;
    if (!Array.isArray(elements)) return null;

    return buildCanvasSummaryForContext(
      elements as Array<Record<string, unknown>>,
    );
  } catch {
    // Non-critical — agent can still call inspect_canvas manually
    return null;
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

/**
 * The project a canvas belongs to, for a job that names that canvas.
 *
 * The worker records asset ownership from the job's project, so a job that names
 * a canvas has to carry the project that canvas belongs to. Two reasons this is
 * resolved here rather than accepted from the caller:
 *
 *  - Ownership must follow the canvas/project source of truth. The job's own
 *    workspace is the PERSONAL billing workspace (Q1), which is the wrong
 *    workspace to authorise a team project's media against.
 *  - The repository applies the canvas's project ACL inside the statement, so a
 *    canvas the caller cannot read returns no row and the job is refused rather
 *    than created against a guessed project.
 *
 * This is the gate BEFORE credits are charged, so it is fail-CLOSED and does not
 * share the never-rejecting discipline of `readCanvasProjectLinkForRun`: a
 * missing repository, a thrown read and an unreadable canvas all have to stop the
 * run. Returning an undefined project would create a job that no later step can
 * authorise its output against.
 *
 * The failure messages are fixed text. The read now goes through PostgreSQL
 * rather than PostgREST, whose `{code, message}` pair used to be interpolated
 * here; a driver error can carry the statement, a host or a credential, so none
 * of it is echoed any more.
 */
export async function resolveCanvasProjectId(
  repository: CanvasReadRepository | undefined,
  actorId: string,
  canvasId: string,
  context: string,
): Promise<string> {
  let link: CanvasProjectLinkRow | null;

  try {
    if (!repository) {
      throw new Error("canvas read repository is not configured");
    }
    link = await repository.findReadableCanvasProjectLink({ actorId, canvasId });
  } catch {
    console.log(`[${context}] canvas project lookup failed`);
    throw new Error("Canvas project lookup failed (canvas_read_failed)");
  }

  if (!link) {
    // No project means no way to authorise the generated asset later, so the
    // run fails here — before credits are charged — instead of on the canvas.
    console.log(`[${context}] canvas ${canvasId} has no readable project`);
    throw new Error(
      "Canvas not found or not accessible — refusing to create a job without its project",
    );
  }

  return link.project_id;
}

export type AgentRunService = ReturnType<typeof createAgentRunService>;

/** Fields a finished video job stores in `background_jobs.result`. */
type VideoJobResultFields = {
  signed_url?: string;
  object_path?: string;
  duration_seconds?: number;
  width?: number;
  height?: number;
  mime_type?: string;
};

/** Placement/title fields the generate_video tool passes through. */
type VideoPlacementInput = {
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
  title?: string;
};

/**
 * Persist the canvas element for a finished video job (CV-01).
 *
 * `objectPath` is the storage key the worker already uploaded and recorded in
 * the job result. When it is missing, NOTHING is written and `undefined` comes
 * back: the only other thing the result offers is `signed_url`, a public URL
 * that stops resolving the moment the bucket is private (X-52), so persisting it
 * would silently recreate the very dependency CV-01 removes. A missing key is a
 * worker-side defect, hence a loud log instead of a fallback.
 *
 * Exported so a test can drive the real canvas writer with a fake client; the
 * "never persist the URL" invariant is otherwise only observable by reading this
 * function.
 */
export async function insertVideoElementForJobResult(args: {
  client: UserSupabaseClient;
  canvasId: string;
  jobId: string;
  objectPath: string | undefined;
  result: VideoJobResultFields;
  input: VideoPlacementInput;
  prompt: string;
}): Promise<string | undefined> {
  const { client, canvasId, jobId, objectPath, result, input } = args;

  if (!objectPath) {
    console.error(
      `[submitVideoJob] job ${jobId} succeeded without result.object_path — no ` +
        `canvas element written for canvas ${canvasId}. Its video is reachable ` +
        `only through a public URL, which X-52 will invalidate; the upload step ` +
        `that records object_path needs to be re-run.`,
    );
    return undefined;
  }

  const explicitPlacement =
    input.placementX != null && input.placementY != null
      ? {
          x: input.placementX,
          y: input.placementY,
          width: input.placementWidth ?? 640,
          height: input.placementHeight ?? 360,
        }
      : undefined;

  const insertResult = await insertVideoElement(
    client,
    {
      canvasId,
      objectPath,
      width: result.width ?? 1280,
      height: result.height ?? 720,
      mimeType: result.mime_type ?? "video/mp4",
      ...(result.duration_seconds != null
        ? { durationSeconds: result.duration_seconds }
        : {}),
      ...(input.title != null ? { title: input.title } : {}),
      prompt: args.prompt,
    },
    explicitPlacement,
  );

  return insertResult.elementId;
}

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
        // Workorder 21AC: the three repositories every Agent-side table call now
        // goes through are injected HERE, so a caller that builds the runtime
        // cannot hand the agent a different set than the one it runs on.
        assetWriteRepository: options.assetWriteRepository,
        brandKitReadRepository: options.brandKitReadRepository,
        canvasReadRepository: options.canvasReadRepository,
        ...(options.createUserClient
          ? { createUserClient: options.createUserClient }
          : {}),
        ...(options.getAdminClient
          ? { getAdminClient: options.getAdminClient }
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

      // The canvas → project link is asked ONCE per run and answered from that
      // one read by both the brand kit and the workspace-skill loader: they used
      // to be two separate round trips for the same fact.
      //
      // Both conditions now follow `run.userId` rather than the user client: the
      // link has to be read as a real actor, and a run without one has nobody to
      // read it AS. In practice an access token implies a user id, so this is the
      // same set of runs as before; the difference is that a user-less run now
      // degrades to "no brand kit, no workspace skills" instead of reading
      // through a client with no actor attached.
      const linkTask = readCanvasProjectLinkForRun({
        repository: options.canvasReadRepository,
        actorId: run.userId,
        canvasId: run.canvasId,
      });

      const createUserClient = options.createUserClient;
      const accessToken = run.accessToken;

      const skillsTask: Promise<WorkspaceSkillEntry[]> =
        accessToken && createUserClient
          ? linkTask
              .then((link) =>
                link && run.userId
                  ? loadWorkspaceSkills({
                      // Workorder 21AC: the skills and their files are read by the
                      // repository, as the run's own user — the workspace alone
                      // never authorises another member's private skill.
                      repository: options.workspaceSkillReadRepository,
                      actorId: run.userId,
                      workspaceId: link.workspace_id,
                    })
                  : [],
              )
              .catch((err) => {
                // Non-fatal: the agent runs without workspace skills.
                console.warn("[runtime] Failed to load workspace skills:", err);
                return [];
              })
          : Promise.resolve([]);

      const brandKitTask: Promise<string | null> = linkTask.then(
        (link) => link?.brand_kit_id ?? null,
      );

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

          // Billing stays on the personal workspace above; the PROJECT comes from
          // the canvas, so the generated asset can be authorised against the team
          // project that asked for it.
          const projectId = canvasId
            ? await resolveCanvasProjectId(
                options.canvasReadRepository,
                userId,
                canvasId,
                "submitImageJob",
              )
            : undefined;

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
              entryPoint: "agent",
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
                  ...(projectId ? { projectId } : {}),
                  ...(sessionId ? { sessionId } : {}),
                },
              },
              onRejected: (rejection) => {
                if (rejection.kind === "tier") {
                  pushBillingErrorAndAbort(
                    run, canvasId, options,
                    rejection.error.code, rejection.error.message,
                  );
                } else if (rejection.kind === "model_not_available") {
                  // 工单31B / GN-07: the price table knows nothing about this
                  // model, so the run stops before a job exists. Same channel as
                  // the other billing refusals — code + message, then abort — so
                  // the client shows one kind of failure for all of them.
                  pushBillingErrorAndAbort(
                    run, canvasId, options,
                    "model_not_available",
                    `Model "${rejection.modelId}" is not available.`,
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

          // GN-30 / T-58 ③: this job is on the queue now, so report its progress
          // to the client the same way a generator-panel job does. The polling
          // loop below still owns persisting the result onto the canvas; the
          // watcher only pushes progress.
          startAgentJobProgress(
            { jobService: jobSvc, connectionManager: options.connectionManager },
            { jobId: job.id, userId, jobType: "image_generation" },
          );

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
          // GN-19: set only when the job itself failed (or the wait timed out).
          // A canceled job, or an aborted run, leaves this null and keeps the old
          // "remove the slot" behaviour.
          let slotFailure: { message: string; jobId: string } | null = null;
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
              // GN-19: a failed job keeps its slot on the canvas, marked failed
              // with a user-facing reason. `canceled` means the user actively
              // stopped it, so that slot is still removed below.
              if (current.status === "failed") {
                slotFailure = {
                  message: sanitizeErrorForClient(
                    new Error(current.error_message ?? "Job failed"),
                  ),
                  jobId: job.id,
                };
              }
              return {
                jobId: job.id,
                error: current.error_message ?? `Job ${current.status}`,
              };
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          // GN-19: same treatment as `failed` — the user waited for a result and
          // gets a slot that says why there is none.
          slotFailure = { message: "生成超时，请重试", jobId: job.id };
          return {
            jobId: job.id,
            error: `Job timed out after ${MAX_WAIT / 1000}s`,
          };
          } finally {
            // Covers every exit path — failure, timeout, the abort throw, and
            // success.
            if (canvasId && placeholderElementId && !placeholderFilled) {
              try {
                if (slotFailure) {
                  // GN-19: keep the request the user submitted, so "retry" can
                  // re-submit it without rebuilding it (and without the URLs).
                  const retry = toRetryRequest(
                    "image",
                    input as Record<string, unknown>,
                  );
                  await markGenerationSlotFailed(
                    createClient(accessToken) as UserSupabaseClient,
                    canvasId,
                    placeholderElementId,
                    { ...slotFailure, ...(retry ? { retryRequest: retry } : {}) },
                  );
                  options.connectionManager?.pushToCanvas(canvasId, {
                    type: "canvas.sync" as const,
                    runId,
                    timestamp: new Date().toISOString(),
                  });
                  jobLap("canvas_placeholder_failed", {
                    elementId: placeholderElementId,
                    jobId: slotFailure.jobId,
                  });
                } else {
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
                }
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

          const projectId = canvasId
            ? await resolveCanvasProjectId(
                options.canvasReadRepository,
                userId,
                canvasId,
                "submitVideoJob",
              )
            : undefined;

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
              entryPoint: "agent",
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
                  ...(projectId ? { projectId } : {}),
                  ...(sessionId ? { sessionId } : {}),
                },
              },
              onRejected: (rejection) => {
                if (rejection.kind === "tier") {
                  pushBillingErrorAndAbort(
                    run, canvasId, options,
                    rejection.error.code, rejection.error.message,
                  );
                } else if (rejection.kind === "model_not_available") {
                  // 工单31B / GN-07: the price table knows nothing about this
                  // model, so the run stops before a job exists. Same channel as
                  // the other billing refusals — code + message, then abort — so
                  // the client shows one kind of failure for all of them.
                  pushBillingErrorAndAbort(
                    run, canvasId, options,
                    "model_not_available",
                    `Model "${rejection.modelId}" is not available.`,
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

          // GN-30 / T-58 ③: same reporting as the image path above. The poll loop
          // below keeps owning the canvas write; the watcher only pushes progress.
          startAgentJobProgress(
            { jobService: jobSvc, connectionManager: options.connectionManager },
            { jobId: job.id, userId, jobType: "video_generation" },
          );

          // GN-19: reserve the canvas slot NOW, before the job is polled — the
          // same rule as the image path above. Upstream inserted nothing until
          // the job succeeded, so the canvas sat empty for the whole 300-600s
          // generation with no indication that anything was happening.
          const placementInput = input as VideoPlacementInput;
          const explicitPlacement =
            placementInput.placementX != null && placementInput.placementY != null
              ? {
                  x: placementInput.placementX,
                  y: placementInput.placementY,
                  width: placementInput.placementWidth ?? 640,
                  height: placementInput.placementHeight ?? 360,
                }
              : undefined;

          let placeholderElementId: string | undefined;
          // Set once the real video element is on the canvas, so the cleanup
          // below knows the slot was filled rather than abandoned.
          let slotFilled = false;
          // Why the slot was abandoned. Left undefined while the loop is still
          // waiting; the cleanup treats "no reason recorded" as an aborted run.
          let stopReason:
            | { reason: "job_failed"; jobId: string; errorMessage: string | null }
            | { reason: "job_canceled"; jobId: string }
            | { reason: "timeout"; jobId: string }
            | undefined;

          if (canvasId) {
            try {
              const slot = await insertImagePlaceholder(
                createClient(accessToken) as UserSupabaseClient,
                {
                  canvasId,
                  width: explicitPlacement?.width ?? 640,
                  height: explicitPlacement?.height ?? 360,
                  kind: "video",
                  ...(placementInput.title
                    ? { title: placementInput.title }
                    : {}),
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
              // Non-fatal: without a slot the video simply gets appended later.
              console.error("[submitVideoJob] placeholder insert failed:", slotErr);
            }
          }

          try {
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
                object_path?: string;
                duration_seconds?: number;
                width?: number;
                height?: number;
                mime_type?: string;
              };
              jobLap("job_poll_done", { pollCount, status: "succeeded" });

              // CV-01: the storage key is the durable half of the result. It is
              // what the canvas persists; signed_url is only what the client may
              // fetch with *today*.
              const objectPath =
                typeof result.object_path === "string" &&
                result.object_path.length > 0
                  ? result.object_path
                  : undefined;

              // Write element directly to canvas (backend-driven insertion)
              let elementId: string | undefined;
              if (canvasId) {
                try {
                  const writerClient = createClient(accessToken) as UserSupabaseClient;
                  // GN-19: the reserved slot goes away before the video lands, so
                  // the canvas holds one element for this job, not two.
                  if (placeholderElementId) {
                    await removeCanvasElement(
                      writerClient,
                      canvasId,
                      placeholderElementId,
                    );
                    placeholderElementId = undefined;
                  }
                  elementId = await insertVideoElementForJobResult({
                    client: writerClient,
                    canvasId,
                    jobId: job.id,
                    objectPath,
                    result,
                    // When the caller stated a rectangle, the video takes the
                    // slot's rectangle so the result lands where the user was
                    // already looking.
                    input: {
                      ...placementInput,
                      ...(explicitPlacement
                        ? {
                            placementX: explicitPlacement.x,
                            placementY: explicitPlacement.y,
                            placementWidth: explicitPlacement.width,
                            placementHeight: explicitPlacement.height,
                          }
                        : {}),
                    },
                    prompt: input.prompt,
                  });

                  if (elementId != null) {
                    slotFilled = true;
                    // Notify connected frontends to refresh canvas
                    options.connectionManager?.pushToCanvas(canvasId, {
                      type: "canvas.sync" as const,
                      runId,
                      timestamp: new Date().toISOString(),
                    });
                    jobLap("canvas_element_inserted", { elementId });
                  }
                } catch (insertErr) {
                  // Graceful degradation: log error but still return result
                  console.error("[submitVideoJob] canvas insert failed:", insertErr);
                }
              }

              return {
                jobId: job.id,
                ...(elementId != null ? { elementId } : {}),
                videoUrl: result.signed_url ?? "",
                ...(objectPath != null ? { objectPath } : {}),
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
              // GN-19: a failed job keeps its slot, marked failed with a
              // user-facing reason; a canceled one is the user's own choice, so
              // its slot is removed by the cleanup below.
              stopReason =
                current.status === "failed"
                  ? {
                      reason: "job_failed",
                      jobId: job.id,
                      errorMessage: current.error_message ?? null,
                    }
                  : { reason: "job_canceled", jobId: job.id };
              return {
                jobId: job.id,
                error: current.error_message ?? `Job ${current.status}`,
              };
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          // GN-19: same treatment as `failed` — the user waited for a result and
          // gets a slot that says why there is none.
          stopReason = { reason: "timeout", jobId: job.id };
          return {
            jobId: job.id,
            error: `Job timed out after ${MAX_WAIT / 1000}s`,
          };
          } finally {
            // Covers every exit path — failure, timeout, the abort throw, and
            // success.
            if (canvasId && placeholderElementId && !slotFilled) {
              const outcome = slotOutcomeForStop(
                stopReason ?? { reason: "aborted" },
              );
              if (outcome.kind !== "filled") {
                try {
                  const cleanupClient = createClient(accessToken) as UserSupabaseClient;
                  if (outcome.kind === "failed") {
                    // GN-19: same as the image path — keep the request so the
                    // failed slot can be retried with the original parameters.
                    const retry = toRetryRequest(
                      "video",
                      input as Record<string, unknown>,
                    );
                    await markGenerationSlotFailed(
                      cleanupClient,
                      canvasId,
                      placeholderElementId,
                      {
                        message: outcome.message,
                        jobId: outcome.jobId,
                        ...(retry ? { retryRequest: retry } : {}),
                      },
                    );
                    options.connectionManager?.pushToCanvas(canvasId, {
                      type: "canvas.sync" as const,
                      runId,
                      timestamp: new Date().toISOString(),
                    });
                    jobLap("canvas_placeholder_failed", {
                      elementId: placeholderElementId,
                      jobId: outcome.jobId,
                    });
                  } else {
                    await removeCanvasElement(
                      cleanupClient,
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
                  }
                } catch (cleanupErr) {
                  console.error(
                    "[submitVideoJob] placeholder cleanup failed:",
                    cleanupErr,
                  );
                }
              }
            }
          }
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

        // Build the persistImage closure (X-52).
        //
        // It downloads the provider's bytes and hands them to the ONE persistence
        // entry point, which uploads with this user's JWT, records ownership from
        // the CANVAS through the service role, and returns
        // { assetId, objectPath, mimeType, byteSize, signedUrl }.
        //
        // Two things about the previous version are deliberately gone:
        //   * the public-URL helper — a permanent, unauthenticated URL is exactly
        //     what stops working the moment the bucket is private;
        //   * the personal-workspace lookup used to BUILD the object path — the
        //     job's billing workspace is not what authorises a project's media
        //     (Q1). Ownership now comes from `record_project_asset(canvasId)`.
        //
        // Client creation is deferred into the closure so it only runs when an
        // image is actually generated (avoids throwing in tests that do not
        // configure Supabase env vars).
        let persistImage: PersistImageFn | undefined;
        if (
          options.createUserClient &&
          options.getAdminClient &&
          run.accessToken &&
          run.canvasId &&
          run.userId
        ) {
          const createClient = options.createUserClient;
          const getAdminClient = options.getAdminClient;
          const accessToken = run.accessToken;
          const canvasId = run.canvasId;
          const createdBy = run.userId;

          persistImage = async (sourceUrl, mimeType, prompt) => {
            const response = await fetch(sourceUrl);
            if (!response.ok) throw new Error(`Download failed: ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            const ext = mimeType === "image/webp" ? "webp" : "png";
            const slug = prompt.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
            const fileName = `gen-${slug}-${Date.now()}.${ext}`;

            const agentAssets = createAgentProjectAssetService({
              // Workorder 21AC: the canvas → project link and the compensation
              // delete are the two repositories' jobs now; the ordering and the
              // error codes of this sequence are unchanged.
              canvasReadRepository: options.canvasReadRepository,
              assetWriteRepository: options.assetWriteRepository,
              createUserClient: (token) =>
                createClient(token) as UserSupabaseClient,
              getAdminClient,
            });

            // LOCAL FORK: retry. Storage latency on a free instance (ours is
            // ap-southeast-2) was measured swinging between 0.5s and 16s, and a
            // single transient DatabaseTimeout used to fall through to the
            // caller's fallback, which embedded the whole image as a base64 data
            // URI in the canvas document.
            //
            // The retry now wraps upload + metadata recording together. A metadata
            // failure deletes the object it just uploaded, so re-running the whole
            // step cannot accumulate unowned objects.
            const MAX_ATTEMPTS = 3;
            let lastError: unknown;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
              try {
                return await agentAssets.persist({
                  accessToken,
                  canvasId,
                  createdBy,
                  content: buffer,
                  mimeType,
                  fileName,
                  pathPrefix: "generated",
                });
              } catch (error) {
                lastError = error;
                console.warn(
                  `[persistImage] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
                if (attempt < MAX_ATTEMPTS) {
                  await new Promise((r) => setTimeout(r, 1500 * attempt));
                }
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

        if (
          !persistImage &&
          options.createUserClient &&
          run.accessToken &&
          (!options.getAdminClient || !run.canvasId || !run.userId)
        ) {
          // Stated rather than silent: without an admin client, a canvas and the
          // acting user there is no owner to derive, so generated media cannot be
          // filed as a project asset at all. `generate_image` says so instead of
          // returning a URL that would die with the public bucket.
          console.warn(
            "[runtime] persistImage unavailable: needs getAdminClient, canvasId and userId " +
              "(X-52: media with no derivable owner is not persisted)",
          );
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
          // Workorder 21AC. `resolvedAgentFactory` injects these too, but the
          // factory's own signature requires them at every call site — which is the
          // point: a custom `agentFactory` cannot be handed a runtime whose
          // repositories it does not know about.
          assetWriteRepository: options.assetWriteRepository,
          brandKitReadRepository: options.brandKitReadRepository,
          canvasReadRepository: options.canvasReadRepository,
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
        // Read through the canvas repository with the run's own actor id — see
        // readCanvasSummaryForRun; it never throws.
        const canvasSummary = run.canvasId
          ? await readCanvasSummaryForRun({
              repository: options.canvasReadRepository,
              actorId: run.userId,
              canvasId: run.canvasId,
            })
          : null;

        const hasAttachments = run.attachments && run.attachments.length > 0;
        let userMessage: HumanMessage;
        let attachmentDataMap: Record<string, string> = {};

        if (hasAttachments) {
          // X-52: the bytes the model sees come from the `asset_objects` row
          // behind each `assetId`, read for the run's own actor and re-signed —
          // NOT from the URL in the request, which is not read at all.
          // `resolveAttachmentContent` refuses (before the model is called) when
          // the asset is absent, not visible to this user, or cannot be signed
          // for them. A rotated or stale preview URL is NOT a refusal: the
          // assetId is the authority and a signature is expected to rotate.
          //
          // What goes into the message decides what gets CHECKPOINTED, and the
          // message list is reloaded, re-sent and rewritten on every single turn.
          // Inlining a user's uploaded bytes there grew one thread's `messages`
          // channel to 25.6 MB, which cost ~36s to load, ~40s to upload and ~16s
          // to write back — for a two-character reply. These are the caller's own
          // bytes for one turn, so they go in as data URLs and are NOT persisted
          // into chat history by this path.
          if (!options.createUserClient) {
            throw new Error(
              "Cannot resolve image attachments without a user-scoped client.",
            );
          }

          const attachmentClient = options.createUserClient(
            run.accessToken ?? "",
          ) as UserSupabaseClient;

          const { imageBlocks, downloaded } = await resolveAttachmentContent(
            {
              repository: options.assetReadRepository,
              actorId: run.userId,
              signingClient: attachmentClient,
            },
            run.attachments!,
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

          // Build assetId → data URI map for tool-level resolution. Passed
          // through `configurable`, which is NOT part of the checkpointed graph
          // state — so tools keep their bytes without those bytes ending up in
          // history.
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
          const next = eventAfterPersistFailure(runId, now, event, error);
          run.status = mapEventToStatus(next);
          yield next;
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

/**
 * AG-35 §3: what to emit after persisting `event` failed. A completed run stays
 * completed — the artifacts already landed, so the run must not be shown as
 * failed because its status row could not be written; the failure is logged.
 * Every other event keeps the existing answer: a run.failed in its place.
 */
export function eventAfterPersistFailure(
  runId: string,
  now: () => string,
  event: StreamEvent,
  error: unknown,
): StreamEvent {
  if (event.type === "run.completed") {
    console.error(`[runtime] run ${runId} completed but its status could not be saved:`, error);
    return event;
  }
  return toFailedEvent(runId, now, error);
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
