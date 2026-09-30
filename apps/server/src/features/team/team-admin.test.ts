import { describe, expect, it } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { TeamMembershipService } from "./team-membership.js";
import {
  TeamAdminError,
  createTeamAdminService,
  type TeamAdminService,
} from "./team-admin.js";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "00000000-0000-0000-0000-00000000000e";
const TARGET_ID = "00000000-0000-0000-0000-00000000000b";

type RpcCall = { name: string; params: Record<string, unknown> };

type StubOptions = {
  profile?: { id: string; email?: string } | null;
  rpcError?: { message: string } | null;
  rpcData?: unknown;
};

function makeAdminStub(options: StubOptions = {}) {
  const rpcs: RpcCall[] = [];

  const client = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          if (table === "profiles") {
            return { data: options.profile ?? null, error: null };
          }
          if (table === "workspaces") {
            return { data: { id: TEAM_ID }, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      };

      return builder;
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcs.push({ name, params });
      if (options.rpcError) {
        return { data: null, error: options.rpcError };
      }
      return { data: options.rpcData ?? true, error: null };
    },
  };

  return { client: client as unknown as AdminSupabaseClient, rpcs };
}

function makeHarness(options: StubOptions = {}) {
  const { client, rpcs } = makeAdminStub(options);
  const invalidated: string[] = [];
  const teamMembership: TeamMembershipService = {
    async get() {
      return null;
    },
    invalidate(userId) {
      invalidated.push(userId);
    },
  };

  const service: TeamAdminService = createTeamAdminService({
    getAdminClient: () => client,
    teamMembership,
  });

  return { service, rpcs, invalidated };
}

async function capture(run: () => Promise<unknown>): Promise<TeamAdminError> {
  const error = await run().then(
    () => null,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(TeamAdminError);
  return error as TeamAdminError;
}

describe("createTeamAdminService", () => {
  it("case 1: addMember resolves the email then calls the audited RPC", async () => {
    const { service, rpcs, invalidated } = makeHarness({
      profile: { id: TARGET_ID },
      rpcData: true,
    });

    const result = await service.addMember(ACTOR_ID, {
      email: "  b@hahart.test  ",
      role: "admin",
    });

    expect(result).toEqual({ added: true });
    expect(rpcs).toEqual([
      {
        name: "admin_add_team_member",
        params: { p_actor: ACTOR_ID, p_user_id: TARGET_ID, p_role: "admin" },
      },
    ]);
    expect(invalidated).toEqual([TARGET_ID]);
  });

  it("case 2: an unknown email is a 404 with no RPC call and no invalidation", async () => {
    const { service, rpcs, invalidated } = makeHarness({ profile: null });

    const error = await capture(() =>
      service.addMember(ACTOR_ID, { email: "nobody@hahart.test", role: "member" }),
    );

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("user_not_found");
    expect(rpcs.length).toBe(0);
    expect(invalidated.length).toBe(0);
  });

  it("case 3: setRole calls the audited RPC and invalidates the target", async () => {
    const { service, rpcs, invalidated } = makeHarness({ rpcData: true });

    const result = await service.setRole(ACTOR_ID, TARGET_ID, "admin");

    expect(result).toEqual({ changed: true });
    expect(rpcs).toEqual([
      {
        name: "admin_set_team_member_role",
        params: { p_actor: ACTOR_ID, p_user_id: TARGET_ID, p_role: "admin" },
      },
    ]);
    expect(invalidated).toEqual([TARGET_ID]);
  });

  it("case 4: removeMember with removed = 0 is a 404 and invalidates nothing", async () => {
    const { service, rpcs, invalidated } = makeHarness({
      rpcData: { projects: 0, assets: 0, objects: 0, removed: 0 },
    });

    const error = await capture(() => service.removeMember(ACTOR_ID, TARGET_ID));

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("user_not_found");
    expect(rpcs.length).toBe(1);
    expect(invalidated.length).toBe(0);
  });

  it("case 4b: removeMember passes the transfer counts through", async () => {
    const { service, invalidated } = makeHarness({
      rpcData: { projects: 2, assets: 3, objects: 1, removed: 1 },
    });

    const result = await service.removeMember(ACTOR_ID, TARGET_ID);

    expect(result).toEqual({
      removed: 1,
      transferred: { projects: 2, assets: 3, objects: 1 },
    });
    expect(invalidated).toEqual([TARGET_ID]);
  });

  it("case 5: database messages map to the documented status codes", async () => {
    const mappings: Array<[string, number, string]> = [
      ["actor is not a team admin", 403, "forbidden"],
      ["cannot change your own role", 400, "invalid_request"],
      ["cannot remove yourself", 400, "invalid_request"],
      ["cannot remove the team owner", 400, "invalid_request"],
      ["cannot change the team owner", 400, "invalid_request"],
      ["role owner is not assignable", 400, "invalid_request"],
      ["user is not a team member", 404, "user_not_found"],
      ["connection terminated unexpectedly", 503, "application_error"],
    ];

    for (const [message, statusCode, code] of mappings) {
      const { service } = makeHarness({ rpcError: { message } });
      const error = await capture(() =>
        service.setRole(ACTOR_ID, TARGET_ID, "member"),
      );

      expect(error.statusCode, message).toBe(statusCode);
      expect(error.code, message).toBe(code);
    }
  });

  it("case 6: recordForeignRead sends exactly one target and the via value", async () => {
    const { service, rpcs } = makeHarness();

    await service.recordForeignRead(ACTOR_ID, "project", { projectId: "p-1" });
    await service.recordForeignRead(ACTOR_ID, "canvas", { canvasId: "c-1" });
    await service.recordForeignRead(ACTOR_ID, "messages", { sessionId: "s-1" });

    expect(rpcs).toEqual([
      {
        name: "record_foreign_read",
        params: {
          p_actor: ACTOR_ID,
          p_via: "project",
          p_project_id: "p-1",
          p_canvas_id: null,
          p_session_id: null,
        },
      },
      {
        name: "record_foreign_read",
        params: {
          p_actor: ACTOR_ID,
          p_via: "canvas",
          p_project_id: null,
          p_canvas_id: "c-1",
          p_session_id: null,
        },
      },
      {
        name: "record_foreign_read",
        params: {
          p_actor: ACTOR_ID,
          p_via: "messages",
          p_project_id: null,
          p_canvas_id: null,
          p_session_id: "s-1",
        },
      },
    ]);
  });

  it("case 6b: an asset target goes through record_foreign_asset_read", async () => {
    const { service, rpcs } = makeHarness();

    await service.recordForeignRead(ACTOR_ID, "asset", { assetId: "asset-1" });

    expect(rpcs).toEqual([
      {
        name: "record_foreign_asset_read",
        params: { p_actor: ACTOR_ID, p_asset_id: "asset-1" },
      },
    ]);
  });

  it("case 7: a failing recordForeignRead throws instead of being swallowed", async () => {
    const { service } = makeHarness({
      rpcError: { message: "connection terminated unexpectedly" },
    });

    await expect(
      service.recordForeignRead(ACTOR_ID, "project", { projectId: "p-1" }),
    ).rejects.toThrow(/connection terminated unexpectedly/);
  });
});
