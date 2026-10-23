import { describe, expect, it } from "vitest";

import {
  RepositoryReadError,
  type IdentityReadRepository,
  type PersonalFoundationRecord,
} from "../../db/identity-read-repository.js";
import type { IdentityWriteRepository } from "../../db/identity-write-repository.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
import type { TeamMembership, TeamMembershipService } from "../team/team-membership.js";

import { BootstrapError, createViewerService } from "./ensure-user-foundation.js";

/**
 * Viewer service contract after the identity read moved to the PostgreSQL
 * repository (workorder 20). The PostgREST stub is gone; what is asserted here
 * is the order of the two dependencies, the DTO the client still receives, and
 * that a repository failure stays a bootstrap failure without carrying SQL.
 */

const USER_ID = "00000000-0000-0000-0000-00000000000a";
const PERSONAL_ID = "22222222-2222-2222-2222-222222222222";
const TEAM_ID = "11111111-1111-1111-1111-111111111111";

const USER: AuthenticatedUser = {
  accessToken: "member-token",
  email: "member@hahart.test",
  id: USER_ID,
  userMetadata: { full_name: "Member" },
};

const FOUNDATION: PersonalFoundationRecord = {
  workspace: {
    id: PERSONAL_ID,
    name: "Personal",
    ownerUserId: USER_ID,
    type: "personal",
  },
  profile: {
    id: USER_ID,
    email: "member@hahart.test",
    displayName: "Member",
    avatarUrl: null,
  },
  membership: {
    workspaceId: PERSONAL_ID,
    userId: USER_ID,
    role: "owner",
  },
};

const TEAM: TeamMembership = {
  workspace: {
    id: TEAM_ID,
    name: "HaHart 团队",
    ownerUserId: "owner-1",
    type: "team",
  },
  role: "member",
};

type HarnessOptions = {
  bootstrapError?: Error | null;
  foundation?: PersonalFoundationRecord | null;
  foundationFailure?: Error;
  team?: TeamMembership | null;
};

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const bootstrapCalls: unknown[] = [];

  const writeRepository: Pick<IdentityWriteRepository, "bootstrapViewer"> = {
    async bootstrapViewer(input) {
      events.push("repo:bootstrapViewer");
      bootstrapCalls.push(input);
      if (options.bootstrapError) throw options.bootstrapError;
    },
  };

  const repository: IdentityReadRepository = {
    async findPersonalFoundation(userId) {
      events.push(`foundation:${userId}`);
      if (options.foundationFailure) throw options.foundationFailure;
      return options.foundation ?? null;
    },
    async findTeamMembership() {
      throw new Error("findTeamMembership is not used by the viewer service");
    },
  };

  const teamMembership: TeamMembershipService = {
    async get(userId) {
      events.push(`team:${userId}`);
      return options.team ?? null;
    },
    invalidate() {},
  };

  return {
    events,
    bootstrapCalls,
    service: createViewerService({
      identityWriteRepository: writeRepository,
      identityReadRepository: repository,
      teamMembership,
    }),
  };
}

describe("createViewerService", () => {
  it("case 1: a failed bootstrap never reaches the read repository", async () => {
    const harness = createHarness({ bootstrapError: new Error("bootstrap exploded") });

    await expect(harness.service.ensureViewer(USER)).rejects.toBeInstanceOf(
      BootstrapError,
    );
    expect(harness.events).toEqual(["repo:bootstrapViewer"]);
  });

  it("case 2: a full foundation becomes the unchanged viewer DTO", async () => {
    const harness = createHarness({ foundation: FOUNDATION, team: TEAM });

    const viewer = await harness.service.ensureViewer(USER);

    expect(viewer).toEqual({
      membership: { role: "owner", userId: USER_ID, workspaceId: PERSONAL_ID },
      profile: {
        avatarUrl: null,
        displayName: "Member",
        email: "member@hahart.test",
        id: USER_ID,
      },
      workspace: {
        id: PERSONAL_ID,
        name: "Personal",
        ownerUserId: USER_ID,
        type: "personal",
      },
      teamWorkspace: {
        id: TEAM_ID,
        name: "HaHart 团队",
        ownerUserId: "owner-1",
        type: "team",
      },
      teamMembership: { workspaceId: TEAM_ID, userId: USER_ID, role: "member" },
    });

    // Bootstrap first, foundation read second, team lookup last.
    expect(harness.events).toEqual([
      "repo:bootstrapViewer",
      `foundation:${USER_ID}`,
      `team:${USER_ID}`,
    ]);
  });

  it("case 3: profile defaults are applied to a sparse row", async () => {
    const harness = createHarness({
      foundation: {
        ...FOUNDATION,
        profile: {
          id: USER_ID,
          email: "member@hahart.test",
          displayName: null,
          avatarUrl: null,
        },
      },
    });

    const viewer = await harness.service.ensureViewer(USER);

    expect(viewer.profile).toEqual({
      avatarUrl: null,
      displayName: "Personal",
      email: "member@hahart.test",
      id: USER_ID,
    });
  });

  it("case 4: a missing foundation row is a bootstrap failure", async () => {
    const harness = createHarness({ foundation: null });

    await expect(harness.service.ensureViewer(USER)).rejects.toBeInstanceOf(
      BootstrapError,
    );
    expect(harness.events).toEqual([
      "repo:bootstrapViewer",
      `foundation:${USER_ID}`,
    ]);
  });

  it("case 5: a repository failure stays a bootstrap failure and leaks no SQL", async () => {
    const failure = new RepositoryReadError(
      "findPersonalFoundation",
      new Error(
        "select w.id from public.workspaces failed: " +
          "postgres://loomic:secret@10.210.134.37:5432/loomic",
      ),
    );
    const harness = createHarness({ foundationFailure: failure });

    const error = await harness.service
      .ensureViewer(USER)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BootstrapError);
    const bootstrapError = error as BootstrapError;
    expect(bootstrapError.code).toBe("bootstrap_failed");
    expect(bootstrapError.statusCode).toBe(500);
    expect(bootstrapError.message).toBe("Unable to prepare viewer workspace.");
    expect(bootstrapError.message).not.toMatch(
      /select|public\.|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The original failure is kept for operators, never rendered to a client.
    expect(bootstrapError.cause).toBe(failure);
  });

  it("case 6: no team workspace keeps the additive fields null", async () => {
    const harness = createHarness({ foundation: FOUNDATION, team: null });

    const viewer = await harness.service.ensureViewer(USER);

    expect(viewer.teamWorkspace).toBeNull();
    expect(viewer.teamMembership).toBeNull();
    expect(viewer.workspace.id).toBe(PERSONAL_ID);
  });

  it("case 7: the bootstrap call keeps its parameter contract", async () => {
    const harness = createHarness({ foundation: FOUNDATION, team: TEAM });

    await harness.service.ensureViewer(USER);

    expect(harness.bootstrapCalls).toEqual([
      {
        userId: USER_ID,
        email: "member@hahart.test",
        userMeta: { full_name: "Member" },
      },
    ]);
  });

  it("case 8: no identity write repository is a bootstrap failure", async () => {
    const events: string[] = [];
    const service = createViewerService({
      identityReadRepository: {
        async findPersonalFoundation(userId) {
          events.push(`foundation:${userId}`);
          return FOUNDATION;
        },
        async findTeamMembership() {
          throw new Error("findTeamMembership is not used by the viewer service");
        },
      },
      teamMembership: {
        async get() {
          return null;
        },
        invalidate() {},
      },
    });

    const error = await service.ensureViewer(USER).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BootstrapError);
    expect((error as BootstrapError).statusCode).toBe(500);
    expect(events).toEqual([]);
  });
});
