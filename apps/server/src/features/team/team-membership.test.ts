import type {
  IdentityReadRepository,
  TeamMembershipRecord,
} from "../../db/identity-read-repository.js";
import { describe, expect, it } from "vitest";

import { createTeamMembershipService } from "./team-membership.js";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "00000000-0000-0000-0000-00000000000a";

type StubConfig = {
  /** What the repository returns; `null` covers both "no team" and "not a member". */
  record?: TeamMembershipRecord | null;
  /** When set, the repository rejects with this error instead of returning. */
  failure?: Error;
};

/**
 * Fake identity repository. The service under test owns caching and error
 * propagation only — the statement, its parameters and the actor live in
 * `src/db/identity-read-repository.test.ts`. Never touches a real database.
 */
function makeRepositoryStub(config: StubConfig) {
  const calls: string[] = [];

  const repository: IdentityReadRepository = {
    async findPersonalFoundation() {
      throw new Error("findPersonalFoundation is not used by team membership");
    },
    async findTeamMembership(userId) {
      calls.push(userId);
      if (config.failure) throw config.failure;
      return config.record ?? null;
    },
  };

  return { repository, calls };
}

const TEAM_RECORD: TeamMembershipRecord = {
  workspace: { id: TEAM_ID, name: "HaHart 团队", ownerUserId: "owner-1", type: "team" },
  role: "admin",
};

function makeClock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("createTeamMembershipService", () => {
  it("case 1: a team member gets the team workspace id and their role", async () => {
    const { repository, calls } = makeRepositoryStub({ record: TEAM_RECORD });
    const service = createTeamMembershipService({
      identityReadRepository: repository,
    });

    const membership = await service.get(USER_ID);

    expect(membership).toEqual({
      workspace: {
        id: TEAM_ID,
        name: "HaHart 团队",
        type: "team",
        ownerUserId: "owner-1",
      },
      role: "admin",
    });
    expect(calls).toEqual([USER_ID]);
  });

  it("case 2: a non-member gets null", async () => {
    const { repository } = makeRepositoryStub({ record: null });
    const service = createTeamMembershipService({
      identityReadRepository: repository,
    });

    expect(await service.get(USER_ID)).toBeNull();
  });

  it("case 3: no team workspace yet gets null without a second lookup", async () => {
    const { repository, calls } = makeRepositoryStub({ record: null });
    const service = createTeamMembershipService({
      identityReadRepository: repository,
    });

    expect(await service.get(USER_ID)).toBeNull();

    // "No team workspace" and "not a member" are one joined read; the service
    // must not probe the repository again for the membership row.
    expect(calls).toHaveLength(1);
  });

  it("case 4: a second call inside the TTL does not hit the repository again", async () => {
    const { repository, calls } = makeRepositoryStub({
      record: { ...TEAM_RECORD, role: "member" },
    });
    const clock = makeClock();
    const service = createTeamMembershipService({
      identityReadRepository: repository,
      now: clock.now,
      ttlMs: 30_000,
    });

    await service.get(USER_ID);
    const afterFirst = calls.length;

    clock.advance(29_999);
    const second = await service.get(USER_ID);

    expect(second?.role).toBe("member");
    expect(calls.length).toBe(afterFirst);
  });

  it("case 5: a call past the TTL reads again", async () => {
    const { repository, calls } = makeRepositoryStub({
      record: { ...TEAM_RECORD, role: "member" },
    });
    const clock = makeClock();
    const service = createTeamMembershipService({
      identityReadRepository: repository,
      now: clock.now,
      ttlMs: 30_000,
    });

    await service.get(USER_ID);
    const afterFirst = calls.length;

    clock.advance(30_001);
    await service.get(USER_ID);

    expect(calls.length).toBe(afterFirst + 1);
  });

  it("case 6: invalidate forces a fresh lookup", async () => {
    const { repository, calls } = makeRepositoryStub({
      record: { ...TEAM_RECORD, role: "member" },
    });
    const clock = makeClock();
    const service = createTeamMembershipService({
      identityReadRepository: repository,
      now: clock.now,
      ttlMs: 30_000,
    });

    await service.get(USER_ID);
    const afterFirst = calls.length;

    service.invalidate(USER_ID);
    await service.get(USER_ID);

    expect(calls.length).toBe(afterFirst + 1);
  });

  it("case 7: a query error throws instead of reading as 'not a member'", async () => {
    // 成员查询故障必须抛（不能吞成 null，否则整队被误报 403）
    const membershipFailure = makeRepositoryStub({
      failure: new Error("connection reset"),
    });
    const membershipService = createTeamMembershipService({
      identityReadRepository: membershipFailure.repository,
    });

    await expect(membershipService.get(USER_ID)).rejects.toThrow(
      /connection reset/,
    );

    // 团队工作区那一跳出错同样必须抛（两条查询路径都不能吞成 null）
    const workspaceFailure = makeRepositoryStub({
      failure: new Error("tenant not found"),
    });
    const workspaceService = createTeamMembershipService({
      identityReadRepository: workspaceFailure.repository,
    });

    await expect(workspaceService.get(USER_ID)).rejects.toThrow(
      /tenant not found/,
    );
  });
});
