import type { WorkspaceSettings } from "@loomic/shared";

import type { WorkspaceSettingsWriteRepository } from "../../db/workspace-settings-write-repository.js";
import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";

const FALLBACK_MODEL = "gpt-5.4-mini";

export class SettingsServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "settings_not_found"
    | "settings_read_failed"
    | "settings_update_failed";

  constructor(
    code:
      | "settings_not_found"
      | "settings_read_failed"
      | "settings_update_failed",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type SettingsService = {
  getWorkspaceSettings(
    user: AuthenticatedUser,
    workspaceId: string,
  ): Promise<WorkspaceSettings>;
  updateWorkspaceSettings(
    user: AuthenticatedUser,
    workspaceId: string,
    settings: WorkspaceSettings,
  ): Promise<WorkspaceSettings>;
};

/**
 * Workspace settings, split by direction since workorder 21E1.
 *
 * READ (`getWorkspaceSettings`) is unchanged: it still runs on the caller's own
 * user-scoped PostgREST client, under RLS, and still falls back to
 * `defaultModel` when no row exists. Nothing about the read path moved.
 *
 * WRITE (`updateWorkspaceSettings`) no longer goes through PostgREST at all. It
 * is the single-key `workspace_settings.default_model` upsert, and since
 * workorder 21E1 it goes through `WorkspaceSettingsWriteRepository` — one
 * privileged, parameterised statement whose membership gate is inside it. This
 * service therefore has no user-scoped write left to fall back to: a missing
 * repository, a refusal, or any repository failure is the SAME
 * `settings_update_failed`, exactly as a PostgREST error used to be. The
 * projection the HTTP route publishes did not move with the write.
 */
export function createSettingsService(options: {
  /**
   * Used by the READ path only. The write path never calls it, and cannot: the
   * repository above is the only writer this service knows about.
   */
  createUserClient: (accessToken: string) => UserSupabaseClient;
  /** Override the fallback model when no workspace setting exists. */
  defaultModel?: string;
  /**
   * ADR-0001 / workorder 21E1: the only writer of
   * `workspace_settings.default_model`.
   *
   * Optional so a caller CAN build the service without one; there is
   * deliberately no fallback behind it. A missing repository is handled exactly
   * like a failing one — the same 500 and no write.
   */
  workspaceSettingsWriteRepository?: WorkspaceSettingsWriteRepository;
}): SettingsService {
  const defaultModel = options.defaultModel ?? FALLBACK_MODEL;

  return {
    async getWorkspaceSettings(user, workspaceId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("workspace_settings")
        .select("default_model")
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      if (error) {
        throw new SettingsServiceError(
          "settings_read_failed",
          "Unable to load workspace settings.",
          500,
        );
      }

      return {
        defaultModel: data?.default_model ?? defaultModel,
      };
    },

    async updateWorkspaceSettings(user, workspaceId, settings) {
      // ADR-0001 / workorder 21E1: the upsert moved from the user-scoped
      // PostgREST client to the pure `pg` repository. What did NOT move is the
      // projection: every failure of the write — a refusal (not an owner/admin
      // member of that workspace), a zero-row answer, a broken row shape, a SQL
      // or connection error, or no repository at all — is the SAME fixed
      // `settings_update_failed` 500, and no SQL, host or membership
      // information reaches the client.
      const repository = options.workspaceSettingsWriteRepository;
      if (!repository) {
        throw settingsUpdateFailed();
      }

      let row;
      try {
        row = await repository.upsertDefaultModel({
          actorId: user.id,
          workspaceId,
          defaultModel: settings.defaultModel,
        });
      } catch {
        throw settingsUpdateFailed();
      }

      // The answer is projected from what the write RETURNED, not from what the
      // caller asked for: the two are the same value on a successful write, and
      // the confirmed one is the only honest source.
      return { defaultModel: row.defaultModel };
    },
  };
}

/**
 * The one failure the settings write can report. It is a function rather than a
 * constant so every caller gets its own error, and it is the ONLY place the code,
 * the wording and the status live: a refusal, a repository that threw and a
 * repository that was never injected must be indistinguishable from the outside.
 */
function settingsUpdateFailed(): SettingsServiceError {
  return new SettingsServiceError(
    "settings_update_failed",
    "Unable to update workspace settings.",
    500,
  );
}
