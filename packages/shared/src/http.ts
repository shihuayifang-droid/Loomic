import { z } from "zod";

import {
  assetObjectSchema,
  canvasContentSchema,
  canvasDetailSchema,
  chatMessageSchema,
  chatSessionSummarySchema,
  modelInfoSchema,
  projectSummarySchema,
  runIdSchema,
  timestampSchema,
  userIdSchema,
  viewerProfileSchema,
  workspaceMembershipSchema,
  workspaceRoleSchema,
  workspaceSettingsSchema,
  workspaceSummarySchema,
} from "./contracts.js";

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("loomic-server"),
  version: z.string().min(1),
});

export const runCancelResponseSchema = z.object({
  runId: runIdSchema,
  status: z.enum(["canceling", "canceled"]),
});

export const viewerCreditsSchema = z.object({
  balance: z.number().int(),
  plan: z.string(),
  dailyClaimed: z.boolean(),
  limits: z.object({
    maxConcurrentJobs: z.number().int(),
    maxResolution: z.string(),
    monthlyCredits: z.number().int(),
    dailyCredits: z.number().int(),
  }),
});

export const viewerResponseSchema = z.object({
  profile: viewerProfileSchema,
  workspace: workspaceSummarySchema,
  membership: workspaceMembershipSchema,
  // Team identity is additive: `workspace` stays the personal workspace (Q1), so
  // credits / generation / skills / settings keep working unchanged. Optional so
  // existing contract fixtures that predate the team workspace still parse; the
  // server always sets both fields explicitly (null for non-members).
  teamWorkspace: workspaceSummarySchema.nullable().optional(),
  teamMembership: workspaceMembershipSchema.nullable().optional(),
  credits: viewerCreditsSchema.optional(),
});

export const projectListResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
});

export const projectCreateRequestSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
});

export const projectCreateResponseSchema = z.object({
  project: projectSummarySchema,
});

// --- AD-08 §3 team member administration -----------------------------------
//
// `role` never accepts "owner" on the wire: the team owner is fixed by
// `ensure_team_workspace` and the database refuses to assign the role anyway.

export const teamMemberSchema = z.object({
  userId: userIdSchema,
  email: z.string(),
  displayName: z.string().nullable(),
  role: workspaceRoleSchema,
  joinedAt: timestampSchema,
});

export const teamMemberListResponseSchema = z.object({
  members: z.array(teamMemberSchema),
});

export const teamMemberAddRequestSchema = z.object({
  email: z.string().trim().min(1),
  role: z.enum(["member", "admin"]),
});

export const teamMemberAddResponseSchema = z.object({
  added: z.boolean(),
});

export const teamMemberRoleRequestSchema = z.object({
  role: z.enum(["member", "admin"]),
});

export const teamMemberRoleResponseSchema = z.object({
  changed: z.boolean(),
});

export const teamMemberRemoveResponseSchema = z.object({
  removed: z.literal(1),
  transferred: z.object({
    projects: z.number().int(),
    assets: z.number().int(),
    objects: z.number().int(),
  }),
});

export const unauthenticatedErrorResponseSchema = z.object({
  error: z.object({
    code: z.literal("unauthorized"),
    message: z.string().min(1),
  }),
});

export const applicationErrorCodeSchema = z.enum([
  "application_error",
  "bootstrap_failed",
  "brand_kit_not_found",
  "brand_kit_create_failed",
  "brand_kit_update_failed",
  "brand_kit_delete_failed",
  "brand_kit_query_failed",
  "brand_kit_asset_not_found",
  "brand_kit_asset_create_failed",
  "canvas_not_found",
  "canvas_save_failed",
  "chat_error",
  "profile_update_failed",
  "project_query_failed",
  "project_create_failed",
  "project_delete_failed",
  "project_not_found",
  "project_slug_taken",
  "project_update_failed",
  "session_not_found",
  "settings_not_found",
  "settings_update_failed",
  "upload_failed",
  "asset_not_found",
  "job_not_found",
  "job_create_failed",
  "job_query_failed",
  "job_cancel_failed",
  "skill_not_found",
  "skill_create_failed",
  "skill_update_failed",
  "skill_delete_failed",
  "skill_query_failed",
  "skill_install_failed",
  "skill_uninstall_failed",
  "skill_toggle_failed",
  "skill_import_failed",
  "skill_file_query_failed",
  "marketplace_search_failed",
  "marketplace_detail_failed",
  "marketplace_install_failed",
  // LOCAL FORK: these three were being sent by the server but were absent here,
  // so applicationErrorResponseSchema.parse() threw inside the error path and the
  // client received Fastify's generic zod dump instead of the intended response —
  // the real cause was replaced by noise. Found while verifying the P0-2 refund
  // fix: /api/agent/generate-image's "No provider registered" branch had never
  // once produced its intended reply.
  // Widening an enum is backward compatible, so adding them is safe.
  "invalid_request",
  "provider_not_configured",
  "service_unavailable",
  "insufficient_credits",
  "credit_query_failed",
  "credit_claim_failed",
  "credit_deduct_failed",
  "credit_refund_failed",
  "credit_plan_update_failed",
  "model_not_accessible",
  "resolution_not_allowed",
  "concurrency_limit",
  "variant_not_found",
  "checkout_failed",
  "generation_failed",
  // AD-08 / PJ-11: the team-member gate rejects a valid token that is not in the
  // HaHart team workspace. Client must be able to tell this apart from 401.
  "not_team_member",
  // AD-08 §3 admin surface: the caller is a team member but not an admin/owner.
  "forbidden",
  // Member administration addresses people by email; unknown address.
  "user_not_found",
]);

export const applicationErrorResponseSchema = z.object({
  error: z.object({
    code: applicationErrorCodeSchema,
    message: z.string().min(1),
  }),
});

export const canvasGetResponseSchema = z.object({
  canvas: canvasDetailSchema,
});

export const canvasSaveRequestSchema = z.object({
  content: canvasContentSchema,
  /**
   * The version this content was built from. Omit only from clients that predate
   * optimistic concurrency; the write is then unconditional and can still lose a
   * concurrent update.
   */
  baseVersion: z.number().int().nonnegative().optional(),
});

export const canvasSaveResponseSchema = z.object({
  ok: z.literal(true),
  /** The version after this save. Clients must keep it for their next save. */
  version: z.number().int().nonnegative().optional(),
});

/**
 * 409 body. Carries the server's current state so the client can merge instead of
 * having to re-fetch, and so a `beforeunload` save (which has no chance to do a
 * round trip) still leaves enough information in the response for diagnosis.
 */
export const canvasConflictResponseSchema = z.object({
  error: z.object({
    code: z.literal("canvas_version_conflict"),
    message: z.string(),
  }),
  currentVersion: z.number().int().nonnegative(),
  currentContent: canvasContentSchema,
});

/**
 * A generation that succeeded and whose file is still in Storage, but which no
 * element on the canvas references any more.
 *
 * This exists because the canvas layout (canvases.content) and the artifact
 * record (background_jobs + asset_objects) are separate stores: before
 * optimistic concurrency landed, a stale whole-content save could drop an
 * element while the file itself stayed perfectly intact. Those images are still
 * recoverable — nothing was ever deleted from Storage.
 */
export const recoverableArtifactSchema = z.object({
  jobId: z.string().uuid(),
  objectPath: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mimeType: z.string().min(1),
  createdAt: z.string().min(1),
  /** The prompt that produced it, so the user can tell which image this is. */
  prompt: z.string().optional(),
  /** Direct URL for a thumbnail, so the user can look before restoring. */
  previewUrl: z.string().optional(),
});

export const canvasRecoverableResponseSchema = z.object({
  artifacts: z.array(recoverableArtifactSchema),
});

export const canvasRecoverRequestSchema = z.object({
  /**
   * Which artifacts to put back. The server re-checks each one against current
   * canvas content, so a stale list cannot cause duplicate inserts.
   */
  jobIds: z.array(z.string().uuid()).min(1),
});

export const canvasRecoverResponseSchema = z.object({
  recovered: z.number().int().nonnegative(),
  /** Ids that were asked for but were already on the canvas, or unusable. */
  skipped: z.array(z.string().uuid()),
  /** The version after the inserts, so the open editor can keep saving. */
  version: z.number().int().nonnegative().optional(),
});

export type RecoverableArtifact = z.infer<typeof recoverableArtifactSchema>;
export type CanvasRecoverableResponse = z.infer<
  typeof canvasRecoverableResponseSchema
>;
export type CanvasRecoverRequest = z.infer<typeof canvasRecoverRequestSchema>;
export type CanvasRecoverResponse = z.infer<typeof canvasRecoverResponseSchema>;

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type RunCancelResponse = z.infer<typeof runCancelResponseSchema>;
export type ViewerCredits = z.infer<typeof viewerCreditsSchema>;
export type ViewerResponse = z.infer<typeof viewerResponseSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;
export type ProjectCreateResponse = z.infer<typeof projectCreateResponseSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
export type TeamMemberListResponse = z.infer<typeof teamMemberListResponseSchema>;
export type TeamMemberAddRequest = z.infer<typeof teamMemberAddRequestSchema>;
export type TeamMemberAddResponse = z.infer<typeof teamMemberAddResponseSchema>;
export type TeamMemberRoleRequest = z.infer<typeof teamMemberRoleRequestSchema>;
export type TeamMemberRoleResponse = z.infer<typeof teamMemberRoleResponseSchema>;
export type TeamMemberRemoveResponse = z.infer<
  typeof teamMemberRemoveResponseSchema
>;
export type UnauthenticatedErrorResponse = z.infer<
  typeof unauthenticatedErrorResponseSchema
>;
export type ApplicationErrorCode = z.infer<typeof applicationErrorCodeSchema>;
export type ApplicationErrorResponse = z.infer<
  typeof applicationErrorResponseSchema
>;
export const profileUpdateResponseSchema = z.object({
  profile: viewerProfileSchema,
});

export const workspaceSettingsResponseSchema = z.object({
  settings: workspaceSettingsSchema,
});

export const workspaceSettingsUpdateRequestSchema = workspaceSettingsSchema;

export const modelListResponseSchema = z.object({
  models: z.array(modelInfoSchema),
});

export const sessionListResponseSchema = z.object({
  sessions: z.array(chatSessionSummarySchema),
});

export const sessionCreateResponseSchema = z.object({
  session: chatSessionSummarySchema,
});

export const messageListResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
});

export const messageCreateResponseSchema = z.object({
  message: chatMessageSchema,
});

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type SessionCreateResponse = z.infer<typeof sessionCreateResponseSchema>;
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;
export type MessageCreateResponse = z.infer<typeof messageCreateResponseSchema>;
export type CanvasGetResponse = z.infer<typeof canvasGetResponseSchema>;
export type CanvasSaveRequest = z.infer<typeof canvasSaveRequestSchema>;
export type CanvasSaveResponse = z.infer<typeof canvasSaveResponseSchema>;
export type ProfileUpdateResponse = z.infer<typeof profileUpdateResponseSchema>;
export type WorkspaceSettingsResponse = z.infer<typeof workspaceSettingsResponseSchema>;
export type WorkspaceSettingsUpdateRequest = z.infer<typeof workspaceSettingsUpdateRequestSchema>;
export type ModelListResponse = z.infer<typeof modelListResponseSchema>;

export const uploadResponseSchema = z.object({
  asset: assetObjectSchema,
  url: z.string().min(1),
});

export const assetSignedUrlResponseSchema = z.object({
  url: z.string().min(1),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
export type AssetSignedUrlResponse = z.infer<typeof assetSignedUrlResponseSchema>;

export const projectUpdateRequestSchema = z.object({
  brand_kit_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(100).optional(),
});
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;
