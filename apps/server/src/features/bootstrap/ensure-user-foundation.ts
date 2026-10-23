import { type ViewerResponse, viewerResponseSchema } from "@loomic/shared";

import type {
  IdentityReadRepository,
  PersonalFoundationRecord,
} from "../../db/identity-read-repository.js";
import type { IdentityWriteRepository } from "../../db/identity-write-repository.js";
import type { TeamMembershipService } from "../team/team-membership.js";
import type { AuthenticatedUser } from "../../supabase/user.js";

const BOOTSTRAP_FAILED_MESSAGE = "Unable to prepare viewer workspace.";

export type ViewerService = {
  ensureViewer(user: AuthenticatedUser): Promise<ViewerResponse>;
};

export class BootstrapError extends Error {
  readonly code = "bootstrap_failed";
  readonly statusCode = 500;

  /**
   * `cause` is optional and never rendered: it exists so the original
   * repository/driver failure can still be inspected by an operator while the
   * HTTP contract keeps the one fixed message.
   */
  constructor(cause?: unknown) {
    super(BOOTSTRAP_FAILED_MESSAGE, cause === undefined ? {} : { cause });
    this.name = "BootstrapError";
  }
}

export function createViewerService(options: {
  identityWriteRepository?: Pick<IdentityWriteRepository, "bootstrapViewer">;
  identityReadRepository: IdentityReadRepository;
  teamMembership: TeamMembershipService;
}): ViewerService {
  return {
    async ensureViewer(user) {
      // The initialisation stays first and stays authoritative: if it fails,
      // the read below must not run and paper over it. A missing repository is
      // the same failure, not a silent skip.
      const writeRepository = options.identityWriteRepository;
      if (!writeRepository) {
        throw new BootstrapError(
          new Error("identity write repository is not configured"),
        );
      }
      try {
        await writeRepository.bootstrapViewer({
          userId: user.id,
          email: user.email,
          userMeta: user.userMetadata,
        });
      } catch (error) {
        throw new BootstrapError(error);
      }

      const foundation = await loadFoundation(
        options.identityReadRepository,
        user.id,
      );

      if (!foundation) {
        throw new BootstrapError();
      }

      // Team identity is additive: `workspace` / `membership` stay the personal
      // workspace (Q1 — credits, generation, skills, settings and payments all
      // keep keying off the personal workspace id). Content (projects, uploads)
      // uses the fields below. A lookup failure propagates: turning it into
      // "not a member" would 403 the whole team on a transient error.
      const team = await options.teamMembership.get(user.id);

      return viewerResponseSchema.parse({
        membership: foundation.membership,
        profile: toViewerProfile(foundation.profile),
        workspace: foundation.workspace,
        teamWorkspace: team ? team.workspace : null,
        teamMembership: team
          ? { workspaceId: team.workspace.id, userId: user.id, role: team.role }
          : null,
      });
    },
  };
}

/**
 * A repository failure is not an empty foundation. Both are 500s through the
 * existing `BootstrapError` → `bootstrap_failed` mapping, but the failure keeps
 * its cause instead of silently reading as "user has no workspace".
 */
async function loadFoundation(
  repository: IdentityReadRepository,
  userId: string,
): Promise<PersonalFoundationRecord | null> {
  try {
    return await repository.findPersonalFoundation(userId);
  } catch (error) {
    throw new BootstrapError(error);
  }
}

/**
 * Defaults are part of the viewer contract and are applied here, not in the
 * repository: the repository reports what the row holds, the service decides
 * what a missing value means to the client.
 */
function toViewerProfile(profile: PersonalFoundationRecord["profile"]) {
  return {
    avatarUrl: profile.avatarUrl ?? null,
    displayName: profile.displayName ?? "Personal",
    email: profile.email ?? "",
    id: profile.id,
  } as const;
}
