import type { TeamMember } from "@loomic/shared";

import type { TeamAdminReadRepository } from "../../db/team-admin-read-repository.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { TeamMembershipService } from "./team-membership.js";

export type ForeignReadTarget =
  | { projectId: string }
  | { canvasId: string }
  | { sessionId: string }
  | { assetId: string };

export type ForeignReadVia =
  | "project"
  | "canvas"
  | "sessions"
  | "messages"
  | "recoverable"
  | "asset";

export type TeamAdminService = {
  listMembers(actorId: string): Promise<TeamMember[]>;
  addMember(
    actorId: string,
    input: { email: string; role: "member" | "admin" },
  ): Promise<{ added: boolean }>;
  setRole(
    actorId: string,
    userId: string,
    role: "member" | "admin",
  ): Promise<{ changed: boolean }>;
  removeMember(
    actorId: string,
    userId: string,
  ): Promise<{
    removed: 1;
    transferred: { projects: number; assets: number; objects: number };
  }>;
  /** 成功读取之后调用；读的是别人的项目才写审计。出错必须抛。 */
  recordForeignRead(
    actorId: string,
    via: ForeignReadVia,
    target: ForeignReadTarget,
  ): Promise<void>;
};

export class TeamAdminError extends Error {
  readonly code:
    | "invalid_request"
    | "forbidden"
    | "user_not_found"
    | "application_error";
  readonly statusCode: 400 | 403 | 404 | 503;

  constructor(
    code: "invalid_request" | "forbidden" | "user_not_found" | "application_error",
    message: string,
    statusCode: 400 | 403 | 404 | 503,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

type RpcError = { message?: string } | null;

/**
 * The one answer a failed roster read gives. Fixed text on purpose: the
 * repository's own error carries driver detail (and, one level down, the
 * statement), and none of it may reach an HTTP body or a log line through this
 * service.
 */
const TEAM_MEMBER_LIST_FAILED_MESSAGE = "Unable to load team members.";

/**
 * The one answer a failed email lookup gives (workorder 20F-B). Fixed text for
 * the same reason as the roster message: the repository's error carries driver
 * detail (and, one level down, the statement), and the PostgREST error this
 * lookup used to surface carried the same kind of text. None of it may reach an
 * HTTP body or a log line through this service.
 */
const TEAM_MEMBER_ADD_FAILED_MESSAGE = "Unable to add the team member.";

/**
 * Every mutation runs inside a single database function that also writes the
 * audit row, so this service never writes the audit table itself. The mapping
 * below turns the database's exception text into an HTTP answer; anything not
 * recognised is a 503 rather than a guess.
 */
function mapDatabaseError(error: RpcError): TeamAdminError {
  const message = error?.message ?? "Unknown database error";

  if (message.includes("actor is not a team admin")) {
    return new TeamAdminError("forbidden", message, 403);
  }

  if (
    message.includes("cannot change your own role") ||
    message.includes("cannot remove yourself") ||
    message.includes("cannot remove the team owner") ||
    message.includes("cannot change the team owner") ||
    message.includes("role owner is not assignable")
  ) {
    return new TeamAdminError("invalid_request", message, 400);
  }

  if (message.includes("user is not a team member")) {
    return new TeamAdminError("user_not_found", message, 404);
  }

  return new TeamAdminError("application_error", message, 503);
}

export function createTeamAdminService(options: {
  getAdminClient: () => AdminSupabaseClient;
  teamMembership: TeamMembershipService;
  /**
   * ADR-0001 / workorder 20F-A: the member list is the PostgreSQL repository's
   * read. Workorder 20F-B moved `addMember`'s email lookup into the same
   * repository, under the same ACL. Optional only because unrelated call sites
   * build this service without one; calling either read without it is a wiring bug
   * and answers exactly what a failed read answers (503 `application_error`)
   * instead of falling back to PostgREST.
   *
   * The repository's SQL is the authorization for these reads: it requires the
   * actor to hold an admin/owner membership row in the team workspace, so the
   * HTTP gate and the route are not the only thing standing between a plain
   * member and the roster, nor between a plain member and an email lookup.
   */
  teamAdminReadRepository?: TeamAdminReadRepository;
}): TeamAdminService {
  return {
    async listMembers(actorId) {
      const repository = options.teamAdminReadRepository;

      if (!repository) {
        throw new TeamAdminError(
          "application_error",
          TEAM_MEMBER_LIST_FAILED_MESSAGE,
          503,
        );
      }

      try {
        // The actor is passed through to the repository and becomes the userId
        // of the privileged transaction, so the audit trail keeps who asked.
        return await repository.listTeamMembers({ actorId });
      } catch {
        throw new TeamAdminError(
          "application_error",
          TEAM_MEMBER_LIST_FAILED_MESSAGE,
          503,
        );
      }
    },

    async addMember(actorId, input) {
      const admin = options.getAdminClient();
      const email = input.email.trim();

      // Workorder 20F-B: the profile behind the email is the repository's read.
      // Optional only because unrelated call sites build this service without one
      // (the same wiring note as `listMembers`); without it the add fails closed
      // with the same 503 instead of falling back to PostgREST. The trim above is
      // the service's, and it happens before the lookup: the repository binds the
      // value verbatim, so the SQL stays an exact equality match.
      const repository = options.teamAdminReadRepository;

      if (!repository) {
        throw new TeamAdminError(
          "application_error",
          TEAM_MEMBER_ADD_FAILED_MESSAGE,
          503,
        );
      }

      let profile: { id: string } | null;

      try {
        profile = await repository.findProfileByEmailForAdmin({
          actorId,
          email,
        });
      } catch {
        // The repository's error is fixed text, but it still names its operation
        // and carries the driver error as `cause`: neither may leave this service.
        throw new TeamAdminError(
          "application_error",
          TEAM_MEMBER_ADD_FAILED_MESSAGE,
          503,
        );
      }

      if (!profile) {
        throw new TeamAdminError(
          "user_not_found",
          `No user with email ${email}.`,
          404,
        );
      }

      const { data, error } = await admin.rpc("admin_add_team_member", {
        p_actor: actorId,
        p_user_id: profile.id,
        p_role: input.role,
      });

      if (error) {
        throw mapDatabaseError(error);
      }

      options.teamMembership.invalidate(profile.id);

      return { added: Boolean(data) };
    },

    async setRole(actorId, userId, role) {
      const admin = options.getAdminClient();

      const { data, error } = await admin.rpc("admin_set_team_member_role", {
        p_actor: actorId,
        p_user_id: userId,
        p_role: role,
      });

      if (error) {
        throw mapDatabaseError(error);
      }

      options.teamMembership.invalidate(userId);

      return { changed: Boolean(data) };
    },

    async removeMember(actorId, userId) {
      const admin = options.getAdminClient();

      const { data, error } = await admin.rpc("admin_remove_team_member", {
        p_actor: actorId,
        p_user_id: userId,
      });

      if (error) {
        throw mapDatabaseError(error);
      }

      const result = (data ?? {}) as {
        projects?: number;
        assets?: number;
        objects?: number;
        removed?: number;
      };

      if (result.removed !== 1) {
        throw new TeamAdminError(
          "user_not_found",
          "That user is not a team member.",
          404,
        );
      }

      options.teamMembership.invalidate(userId);

      return {
        removed: 1,
        transferred: {
          projects: result.projects ?? 0,
          assets: result.assets ?? 0,
          objects: result.objects ?? 0,
        },
      };
    },

    async recordForeignRead(actorId, via, target) {
      const admin = options.getAdminClient();

      // Assets are addressed by their own id (GET /api/uploads/:assetId/url) and
      // that id does not resolve to a project for project-less assets, so they
      // go through a dedicated function. Everything else shares one.
      const { error } =
        "assetId" in target
          ? await admin.rpc("record_foreign_asset_read", {
              p_actor: actorId,
              p_asset_id: target.assetId,
            })
          : await admin.rpc("record_foreign_read", {
              p_actor: actorId,
              p_via: via,
              p_project_id: "projectId" in target ? target.projectId : null,
              p_canvas_id: "canvasId" in target ? target.canvasId : null,
              p_session_id: "sessionId" in target ? target.sessionId : null,
            });

      if (error) {
        throw mapDatabaseError(error);
      }
    },
  };
}
