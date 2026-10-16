import type { WorkspaceSettings } from "@loomic/shared";

import type { WorkspaceSettingsReadRepository } from "../../db/workspace-settings-read-repository.js";
import type { WorkspaceSettingsWriteRepository } from "../../db/workspace-settings-write-repository.js";
import type { AuthenticatedUser } from "../../supabase/user.js";

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
 * Neither direction goes through PostgREST any more. The READ was the last one
 * left, and since workorder 21L `getWorkspaceSettings` runs on
 * `WorkspaceSettingsReadRepository` — one privileged, parameterised statement
 * whose membership predicate is the `workspace_settings_select` policy
 * translated into SQL. This service therefore has no user-scoped client at all:
 * a missing repository and a failing repository are the SAME
 * `settings_read_failed` 500, exactly as a PostgREST error used to be, and there
 * is deliberately nothing to fall back to.
 *
 * WRITE (`updateWorkspaceSettings`) is unchanged by 21L: it is the single-key
 * `workspace_settings.default_model` upsert through
 * `WorkspaceSettingsWriteRepository` (workorder 21E1), and a missing repository,
 * a refusal, or any repository failure is the SAME `settings_update_failed`. The
 * projection the HTTP route publishes did not move with either direction.
 *
 * What also did NOT move is what "no row" means. The repository answers `null`
 * both when the workspace has no settings row AND when the caller is not a
 * member of it — the two were never distinguishable through RLS either — and
 * that null is answered with `defaultModel`. A non-member is therefore served the
 * default model, not a 403: `/api/agent/runs` and the websocket handler start
 * agent runs through this read, and they must keep working for a caller whose
 * workspace has simply never saved a setting.
 */
export function createSettingsService(options: {
  /** Override the fallback model when no workspace setting exists. */
  defaultModel?: string;
  /**
   * ADR-0001 / workorder 21L: the only reader of
   * `workspace_settings.default_model`.
   *
   * Optional so a caller CAN build the service without one; there is
   * deliberately no fallback behind it. A missing repository is handled exactly
   * like a failing one — the same 500 and no read.
   */
  workspaceSettingsReadRepository?: WorkspaceSettingsReadRepository;
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
      // ADR-0001 / workorder 21L: the read moved from the user-scoped PostgREST
      // client to the pure `pg` repository. What did NOT move is the projection:
      // every failure of the read — a broken connection, a SQL error, a row the
      // statement and the mapper disagree about, or no repository at all — is the
      // SAME fixed `settings_read_failed` 500, and no SQL, host or membership
      // information reaches the client.
      const repository = options.workspaceSettingsReadRepository;
      if (!repository) {
        throw settingsReadFailed();
      }

      let stored;
      try {
        stored = await repository.readDefaultModel({
          actorId: user.id,
          workspaceId,
        });
      } catch {
        throw settingsReadFailed();
      }

      // `null` is not a failure: it is "nothing this caller may see", the answer
      // the read gave for a non-member and for a workspace without a settings row
      // alike. Only a stored string overrides the fallback.
      return { defaultModel: stored ?? defaultModel };
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
 * The one failure the settings read can report. It is a function rather than a
 * constant so every caller gets its own error, and it is the ONLY place the code,
 * the wording and the status live: a repository that threw and a repository that
 * was never injected must be indistinguishable from the outside.
 *
 * The wording is the one the removed PostgREST read answered with: an admin or a
 * client that saw this message before sees exactly the same one now.
 */
function settingsReadFailed(): SettingsServiceError {
  return new SettingsServiceError(
    "settings_read_failed",
    "Unable to load workspace settings.",
    500,
  );
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
