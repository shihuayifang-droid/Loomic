import type { IdentityReadRepository } from "../../db/identity-read-repository.js";

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
 * PostgreSQL identity repository, and caches the answer per user.
 *
 * Deliberately separate from `authenticate()` (which caches tokens for 5 min):
 * a member removed from the team must lose access within one TTL, and
 * `invalidate` lets the (workorder 5) member-management endpoints drop it
 * immediately.
 *
 * Query failures **throw**. Swallowing them into `null` would turn a transient
 * database error into "you are not a member" — i.e. a 403 for the whole team
 * that looks exactly like a permissions problem. `RepositoryReadError` is
 * therefore propagated untouched: the HTTP gate turns it into 503 and the
 * websocket into 1011.
 */
export function createTeamMembershipService(options: {
  identityReadRepository: IdentityReadRepository;
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

      const record = await options.identityReadRepository.findTeamMembership(
        userId,
      );

      // "No team workspace yet" and "not a member" are the same answer to every
      // caller, and both are cached: neither is an error.
      if (!record) {
        return remember(userId, null);
      }

      return remember(userId, {
        workspace: record.workspace,
        role: record.role,
      });
    },

    invalidate(userId) {
      cache.delete(userId);
    },
  };
}
