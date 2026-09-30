import type { TeamMember } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { TeamMembershipService } from "./team-membership.js";

export type ForeignReadTarget =
  | { projectId: string }
  | { canvasId: string }
  | { sessionId: string };

export type TeamAdminService = {
  listMembers(): Promise<TeamMember[]>;
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
    via: "project" | "canvas" | "sessions" | "messages",
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
}): TeamAdminService {
  async function teamWorkspaceId(): Promise<string | null> {
    const admin = options.getAdminClient();
    const { data, error } = await admin
      .from("workspaces")
      .select("id")
      .eq("type", "team")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new TeamAdminError("application_error", error.message, 503);
    }

    return data?.id ?? null;
  }

  return {
    async listMembers() {
      const admin = options.getAdminClient();
      const workspaceId = await teamWorkspaceId();

      if (!workspaceId) {
        return [];
      }

      const { data: members, error: memberError } = await admin
        .from("workspace_members")
        .select("user_id, role, created_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: true });

      if (memberError) {
        throw new TeamAdminError("application_error", memberError.message, 503);
      }

      const userIds = (members ?? []).map((member) => member.user_id);

      if (userIds.length === 0) {
        return [];
      }

      const { data: profiles, error: profileError } = await admin
        .from("profiles")
        .select("id, email, display_name")
        .in("id", userIds);

      if (profileError) {
        throw new TeamAdminError("application_error", profileError.message, 503);
      }

      const profileById = new Map(
        (profiles ?? []).map((profile) => [profile.id, profile]),
      );

      return (members ?? []).map((member) => {
        const profile = profileById.get(member.user_id);

        return {
          userId: member.user_id,
          email: profile?.email ?? "",
          displayName: profile?.display_name ?? null,
          role: member.role,
          joinedAt: member.created_at,
        } satisfies TeamMember;
      });
    },

    async addMember(actorId, input) {
      const admin = options.getAdminClient();
      const email = input.email.trim();

      const { data: profile, error: profileError } = await admin
        .from("profiles")
        .select("id")
        .eq("email", email)
        .maybeSingle();

      if (profileError) {
        throw new TeamAdminError("application_error", profileError.message, 503);
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

      const { error } = await admin.rpc("record_foreign_read", {
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
