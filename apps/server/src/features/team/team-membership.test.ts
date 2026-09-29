import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { describe, expect, it } from "vitest";

import { createTeamMembershipService } from "./team-membership.js";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "00000000-0000-0000-0000-00000000000a";

type RecordedQuery = { table: string; eqs: Array<[string, unknown]> };

type StubConfig = {
  workspace: { id: string; name: string; owner_user_id: string } | null;
  workspaceError?: { message: string } | null;
  member?: { role: string } | null;
  memberError?: { message: string } | null;
};

/** Chainable fake for the two queries the service makes. Never touches a real DB. */
function makeAdminStub(config: StubConfig) {
  const queries: RecordedQuery[] = [];

  const client = {
    from(table: string) {
      const eqs: Array<[string, unknown]> = [];
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          eqs.push([column, value]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          queries.push({ table, eqs });
          if (table === "workspaces") {
            return { data: config.workspace, error: config.workspaceError ?? null };
          }
          return { data: config.member ?? null, error: config.memberError ?? null };
        },
      };
      return builder;
    },
  };

  return { client: client as unknown as AdminSupabaseClient, queries };
}

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
    const { client, queries } = makeAdminStub({
      workspace: { id: TEAM_ID, name: "HaHart 团队", owner_user_id: "owner-1" },
      member: { role: "admin" },
    });
    const service = createTeamMembershipService({ getAdminClient: () => client });

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
    expect(queries.map((query) => query.table)).toEqual([
      "workspaces",
      "workspace_members",
    ]);
    const memberQuery = queries[1];
    expect(memberQuery?.eqs).toEqual([
      ["workspace_id", TEAM_ID],
      ["user_id", USER_ID],
    ]);
  });

  it("case 2: a non-member gets null", async () => {
    const { client } = makeAdminStub({
      workspace: { id: TEAM_ID, name: "HaHart 团队", owner_user_id: "owner-1" },
      member: null,
    });
    const service = createTeamMembershipService({ getAdminClient: () => client });

    expect(await service.get(USER_ID)).toBeNull();
  });

  it("case 3: no team workspace yet gets null without touching members", async () => {
    const { client, queries } = makeAdminStub({ workspace: null });
    const service = createTeamMembershipService({ getAdminClient: () => client });

    expect(await service.get(USER_ID)).toBeNull();
    expect(queries.map((query) => query.table)).toEqual(["workspaces"]);
  });

  it("case 4: a second call inside the TTL does not hit the database again", async () => {
    const { client, queries } = makeAdminStub({
      workspace: { id: TEAM_ID, name: "HaHart 团队", owner_user_id: "owner-1" },
      member: { role: "member" },
    });
    const clock = makeClock();
    const service = createTeamMembershipService({
      getAdminClient: () => client,
      now: clock.now,
      ttlMs: 30_000,
    });

    await service.get(USER_ID);
    const afterFirst = queries.length;

    clock.advance(29_999);
    const second = await service.get(USER_ID);

    expect(second?.role).toBe("member");
    expect(queries.length).toBe(afterFirst);
  });

  it("case 5: a call past the TTL queries again", async () => {
    const { client, queries } = makeAdminStub({
      workspace: { id: TEAM_ID, name: "HaHart 团队", owner_user_id: "owner-1" },
      member: { role: "member" },
    });
    const clock = makeClock();
    const service = createTeamMembershipService({
      getAdminClient: () => client,
      now: clock.now,
      ttlMs: 30_000,
    });

    await service.get(USER_ID);
    const afterFirst = queries.length;

    clock.advance(30_001);
    await service.get(USER_ID);

    expect(queries.length).toBe(afterFirst + 2);
  });

  it("case 6: invalidate forces a fresh lookup", async () => {
    const { client, queries } = makeAdminStub({
      workspace: { id: TEAM_ID, name: "HaHart 团队", owner_user_id: "owner-1" },
      member: { role: "member" },
    });
    const clock = makeClock();
    const service = createTeamMembershipService({
      getAdminClient: () => client,
      now: clock.now,
      ttlMs: 30_000,
    });

    await service.get(USER_ID);
    const afterFirst = queries.length;

    service.invalidate(USER_ID);
    await service.get(USER_ID);

    expect(queries.length).toBe(afterFirst + 2);
  });

  it("case 7: a query error throws instead of reading as 'not a member'", async () => {
    const membershipFailure = makeAdminStub({
      workspace: { id: TEAM_ID, name: "HaHart 团队", owner_user_id: "owner-1" },
      member: null,
      memberError: { message: "connection reset" },
    });
    const membershipService = createTeamMembershipService({
      getAdminClient: () => membershipFailure.client,
    });

    await expect(membershipService.get(USER_ID)).rejects.toThrow(
      /connection reset/,
    );

    // 团队工作区那一跳出错同样必须抛（两条查询路径都不能吞成 null）
    const workspaceFailure = makeAdminStub({
      workspace: null,
      workspaceError: { message: "tenant not found" },
    });
    const workspaceService = createTeamMembershipService({
      getAdminClient: () => workspaceFailure.client,
    });

    await expect(workspaceService.get(USER_ID)).rejects.toThrow(
      /tenant not found/,
    );
  });
});
