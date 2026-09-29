import type { AdminSupabaseClient } from "../../supabase/admin.js";

export type TeamMembership = {
  workspace: { id: string; name: string; type: "team"; ownerUserId: string };
  role: "owner" | "admin" | "member";
};

export type TeamMembershipService = {
  /** 用户在团队工作区的成员身份；不是成员或团队工作区不存在 → null。 */
  get(userId: string): Promise<TeamMembership | null>;
  /** 让某用户的缓存立刻失效（加入 / 改角色 / 移出之后调用）。 */
  invalidate(userId: string): void;
};

const DEFAULT_TTL_MS = 30_000;

/**
 * Reads the single team workspace and the caller's membership row through the
 * admin client, and caches the answer per user.
 *
 * Deliberately separate from `authenticate()` (which caches tokens for 5 min):
 * a member removed from the team must lose access within one TTL, and
 * `invalidate` lets the (workorder 5) member-management endpoints drop it
 * immediately.
 *
 * Query failures **throw**. Swallowing them into `null` would turn a transient
 * Supabase error into "you are not a member" — i.e. a 403 for the whole team
 * that looks exactly like a permissions problem.
 */
export function createTeamMembershipService(options: {
  getAdminClient: () => AdminSupabaseClient;
  ttlMs?: number;
  now?: () => number;
}): TeamMembershipService {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<
    string,
    { value: TeamMembership | null; expiresAt: number }
  >();

  function remember(userId: string, value: TeamMembership | null) {
    cache.set(userId, { value, expiresAt: now() + ttlMs });
    return value;
  }

  return {
    async get(userId) {
      const cached = cache.get(userId);
      if (cached && now() < cached.expiresAt) {
        return cached.value;
      }

      const admin = options.getAdminClient();

      const { data: workspace, error: workspaceError } = await admin
        .from("workspaces")
        .select("id, name, owner_user_id")
        .eq("type", "team")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (workspaceError) {
        throw new Error(
          `team workspace lookup failed: ${workspaceError.message}`,
        );
      }

      if (!workspace) {
        return remember(userId, null);
      }

      const { data: member, error: memberError } = await admin
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", workspace.id)
        .eq("user_id", userId)
        .maybeSingle();

      if (memberError) {
        throw new Error(`team membership lookup failed: ${memberError.message}`);
      }

      if (!member) {
        return remember(userId, null);
      }

      return remember(userId, {
        workspace: {
          id: workspace.id,
          name: workspace.name,
          type: "team",
          ownerUserId: workspace.owner_user_id,
        },
        role: member.role as TeamMembership["role"],
      });
    },

    invalidate(userId) {
      cache.delete(userId);
    },
  };
}
