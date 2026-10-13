import { z } from "zod";

import {
  agentAssetReferenceSchema,
  toolArtifactSchema,
  type AgentAssetReference,
} from "./artifacts.js";
import { brandKitAssetTypeSchema } from "./brand-kit-contracts.js";

/**
 * X-52: re-exported through the contract barrel so server and web agree on one
 * definition of "a stable reference to a project asset" — `assetId` first,
 * `objectPath` for diagnostics, `signedUrl` only as this read's projection.
 */
export { agentAssetReferenceSchema };
export type { AgentAssetReference };

export const identifierSchema = z.string().min(1);
export const timestampSchema = z.string().datetime({ offset: true });

export const sessionIdSchema = identifierSchema;
export const conversationIdSchema = identifierSchema;
export const runIdSchema = identifierSchema;
export const messageIdSchema = identifierSchema;
export const toolCallIdSchema = identifierSchema;
export const userIdSchema = identifierSchema;
export const workspaceIdSchema = identifierSchema;
export const projectIdSchema = identifierSchema;
export const canvasIdSchema = identifierSchema;

export const workspaceTypeSchema = z.enum(["personal", "team"]);
export const workspaceRoleSchema = z.enum(["owner", "admin", "member"]);

export const runStatusSchema = z.enum([
  "accepted",
  "running",
  "completed",
  "failed",
]);

export const imageAttachmentSchema = z.object({
  assetId: z.string().min(1),
  /**
   * X-52 (工单14 fixup T1): a BROWSER PROJECTION that the server IGNORES.
   *
   * `assetId` is the only authority for what the model is shown: the runtime
   * re-reads the `asset_objects` row behind it through the caller's JWT and
   * re-signs it, and the bytes come from THAT signature. Because a signature is
   * rotatable, the URL here cannot be compared against a freshly minted one —
   * an expired or sessionStorage-restored preview differs from a new signature
   * without anything being forged, so a byte-equality check rejects exactly the
   * legitimate case it was meant to allow.
   *
   * Optional because a record with an identity but no live projection is still
   * submittable, and an empty string is NOT an acceptable stand-in: it is not a
   * URL and would fail `z.string().url()` before the assetId was ever read.
   * Kept in the shape at all so an older client that still sends one parses.
   */
  url: z.string().url().optional(),
  mimeType: z.string().min(1),
  name: z.string().min(1).optional(),
});

export const imageModelMentionSchema = z.object({
  mentionType: z.literal("image-model"),
  id: z.string().min(1),
  label: z.string().min(1),
});

export const brandKitAssetMentionSchema = z.object({
  mentionType: z.literal("brand-kit-asset"),
  id: z.string().min(1),
  label: z.string().min(1),
  assetType: brandKitAssetTypeSchema,
  textContent: z.string().nullable().optional(),
  fileUrl: z.string().url().nullable().optional(),
});

export const skillMentionSchema = z.object({
  mentionType: z.literal("skill"),
  id: z.string().min(1),
  label: z.string().min(1),
  slug: z.string().min(1),
});

export const messageMentionSchema = z.discriminatedUnion("mentionType", [
  imageModelMentionSchema,
  brandKitAssetMentionSchema,
  skillMentionSchema,
]);

export const imageGenerationPreferenceSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  models: z.array(z.string().min(1)),
});

export const videoGenerationPreferenceSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  models: z.array(z.string().min(1)),
});

export const runCreateRequestSchema = z.object({
  sessionId: sessionIdSchema,
  conversationId: conversationIdSchema,
  prompt: z.string(),
  canvasId: canvasIdSchema.optional(),
  attachments: z.array(imageAttachmentSchema).optional(),
  imageGenerationPreference: imageGenerationPreferenceSchema.optional(),
  videoGenerationPreference: videoGenerationPreferenceSchema.optional(),
  mentions: z.array(messageMentionSchema).optional(),
  accessToken: z.string().optional(),
  model: z.string().optional(),
});

export const runCreateResponseSchema = z.object({
  runId: runIdSchema,
  sessionId: sessionIdSchema,
  conversationId: conversationIdSchema,
  status: z.literal("accepted"),
});

export const viewerProfileSchema = z.object({
  id: userIdSchema,
  email: z.string().email(),
  displayName: z.string().min(1),
  avatarUrl: z.string().url().nullable().optional(),
});

export const workspaceSummarySchema = z.object({
  id: workspaceIdSchema,
  name: z.string().min(1),
  type: workspaceTypeSchema,
  ownerUserId: userIdSchema,
});

export const workspaceMembershipSchema = z.object({
  workspaceId: workspaceIdSchema,
  userId: userIdSchema,
  role: workspaceRoleSchema,
});

export const canvasSummarySchema = z.object({
  id: canvasIdSchema,
  name: z.string().min(1),
  isPrimary: z.boolean(),
});

export const projectSummarySchema = z.object({
  id: projectIdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable(),
  thumbnailUrl: z.string().nullable().optional(),
  workspace: workspaceSummarySchema,
  primaryCanvas: canvasSummarySchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const canvasContentSchema = z.object({
  elements: z.array(z.record(z.unknown())).default([]),
  appState: z.record(z.unknown()).default({}),
  files: z.record(z.record(z.unknown())).default({}),
});

export const canvasDetailSchema = z.object({
  id: canvasIdSchema,
  name: z.string().min(1),
  projectId: projectIdSchema,
  content: canvasContentSchema,
  /**
   * Optimistic concurrency counter. Send it back with a save so a write built on
   * stale content is rejected instead of silently overwriting newer elements —
   * that overwrite is how agent-generated images used to disappear.
   *
   * Optional so an older client still parses a newer server response.
   */
  version: z.number().int().nonnegative().optional(),
});

export const profileUpdateRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
});

export const workspaceSettingsSchema = z.object({
  defaultModel: z.string().min(1),
});

export const modelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
});

export const chatSessionIdSchema = identifierSchema;

export const chatToolActivitySchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(["running", "completed"]),
  input: z.record(z.unknown()).optional(),
  output: z.record(z.unknown()).optional(),
  outputSummary: z.string().optional(),
  artifacts: z.array(toolArtifactSchema).optional(),
});

export const chatSessionSummarySchema = z.object({
  id: chatSessionIdSchema,
  title: z.string(),
  updatedAt: timestampSchema,
});

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const thinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
});

export const toolBlockSchema = z.object({
  type: z.literal("tool"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(["running", "completed"]),
  input: z.record(z.unknown()).optional(),
  output: z.record(z.unknown()).optional(),
  outputSummary: z.string().optional(),
  artifacts: z.array(toolArtifactSchema).optional(),
});

export const imageBlockSchema = z.object({
  type: z.literal("image"),
  assetId: z.string().min(1),
  /**
   * Full-resolution image. When present this is what gets sent to the model, so
   * it must not be a downscaled variant.
   *
   * X-52 (工单14 fixup T2): OPTIONAL. A block that carries its identity but for
   * which no signature could be minted on THIS read is a legal, complete answer
   * — "currently not projectable" — not a malformed one. The safe outcome for a
   * read the caller may not perform is the block WITHOUT a url; re-serving the
   * url already in the row would hand back a token that used to work, and
   * requiring the field here turned that safe outcome into a Zod failure, i.e. a
   * 500 on `/api/sessions/:id/messages` and on message creation. A url, when
   * present, is still a real url: the format check is unchanged.
   */
  url: z.string().url().optional(),
  /**
   * Display-sized variant, used for the inline pill in the message bubble.
   * Optional because older rows predate it — renderers fall back to `url`.
   *
   * Kept separate from `url` on purpose: a pill is ~16px tall, and reusing the
   * full-resolution URL there makes the browser decode multi-megabyte images to
   * draw a thumbnail.
   */
  thumbnailUrl: z.string().url().optional(),
  /**
   * X-52: the stored object key, alongside the identity. Optional — only blocks
   * written after the storage cutover carry it — but declared here so a parsed
   * response keeps the stable identity whole instead of silently stripping it.
   */
  objectPath: z.string().min(1).optional(),
  mimeType: z.string().min(1),
  source: z.enum(["upload", "canvas-ref"]),
  name: z.string().min(1).optional(),
});

export const imageModelMentionBlockSchema = z.object({
  type: z.literal("mention"),
  mentionType: z.literal("image-model"),
  id: z.string().min(1),
  label: z.string().min(1),
});

export const brandKitAssetMentionBlockSchema = z.object({
  type: z.literal("mention"),
  mentionType: z.literal("brand-kit-asset"),
  id: z.string().min(1),
  label: z.string().min(1),
  assetType: brandKitAssetTypeSchema,
  textContent: z.string().nullable().optional(),
  fileUrl: z.string().url().nullable().optional(),
});

export const skillMentionBlockSchema = z.object({
  type: z.literal("mention"),
  mentionType: z.literal("skill"),
  id: z.string().min(1),
  label: z.string().min(1),
  slug: z.string().min(1),
});

export const mentionBlockSchema = z.union([
  imageModelMentionBlockSchema,
  brandKitAssetMentionBlockSchema,
  skillMentionBlockSchema,
]);

export const contentBlockSchema = z.union([
  textBlockSchema,
  thinkingBlockSchema,
  toolBlockSchema,
  imageBlockSchema,
  mentionBlockSchema,
]);

export const chatMessageSchema = z.object({
  id: identifierSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  toolActivities: z.array(chatToolActivitySchema).nullable().optional(),
  contentBlocks: z.array(contentBlockSchema).nullable().optional(),
  createdAt: timestampSchema,
});

export const chatMessageCreateRequestSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  toolActivities: z.array(chatToolActivitySchema).nullable().optional(),
  contentBlocks: z.array(contentBlockSchema).nullable().optional(),
});

// X-52 stage 1C (工单18 T2): `canvases` is the legacy screenshot bucket. It is added
// to the READ contract so a mapped `asset_objects.bucket = 'canvases'` row parses and
// is signed through the one existing signing service. It is deliberately NOT a new
// upload entry point: the bucket keeps no client INSERT policy after the cutover
// migration, so a write against it is refused by RLS rather than by this enum.
export const assetBucketSchema = z.enum([
  "project-assets",
  "user-avatars",
  "canvases",
]);

export const assetObjectSchema = z.object({
  id: identifierSchema,
  bucket: assetBucketSchema,
  objectPath: z.string().min(1),
  mimeType: z.string().min(1).nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  workspaceId: workspaceIdSchema,
  projectId: projectIdSchema.nullable(),
  createdAt: timestampSchema,
});

export type AssetBucket = z.infer<typeof assetBucketSchema>;
export type AssetObject = z.infer<typeof assetObjectSchema>;

export type TextBlock = z.infer<typeof textBlockSchema>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type ToolBlock = z.infer<typeof toolBlockSchema>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export type MessageMention = z.infer<typeof messageMentionSchema>;
export type MentionBlock = z.infer<typeof mentionBlockSchema>;
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>;
export type ImageGenerationPreference = z.infer<
  typeof imageGenerationPreferenceSchema
>;
export type VideoGenerationPreference = z.infer<
  typeof videoGenerationPreferenceSchema
>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type ChatSessionSummary = z.infer<typeof chatSessionSummarySchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatMessageCreateRequest = z.infer<typeof chatMessageCreateRequestSchema>;
export type ChatToolActivity = z.infer<typeof chatToolActivitySchema>;
export type ProfileUpdateRequest = z.infer<typeof profileUpdateRequestSchema>;
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export type RunCreateRequest = z.infer<typeof runCreateRequestSchema>;
export type RunCreateResponse = z.infer<typeof runCreateResponseSchema>;
export type ViewerProfile = z.infer<typeof viewerProfileSchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;
export type CanvasSummary = z.infer<typeof canvasSummarySchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type CanvasContent = z.infer<typeof canvasContentSchema>;
export type CanvasDetail = z.infer<typeof canvasDetailSchema>;
