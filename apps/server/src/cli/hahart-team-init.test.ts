import { describe, expect, it } from "vitest";

import type { AdminSupabaseClient } from "../supabase/admin.js";
import {
  main,
  parseTeamInitArgs,
  runTeamInit,
  type TeamInitReport,
} from "./hahart-team-init.js";

const OWNER_EMAIL = "owner@hahart.test";
const MEMBER_A = "a@hahart.test";
const MEMBER_B = "b@hahart.test";
const MEMBER_MISSING = "ghost@hahart.test";

const OWNER_ID = "00000000-0000-0000-0000-00000000000f";
const MEMBER_A_ID = "00000000-0000-0000-0000-00000000000a";
const MEMBER_B_ID = "00000000-0000-0000-0000-00000000000b";
const TEAM_ID = "11111111-1111-1111-1111-111111111111";

type RpcCall = { name: string; params: Record<string, unknown> | undefined };

type StubOptions = {
  profiles: Record<string, string>;
  /** RPC name -> either a result value or an error code. */
  rpc: Record<string, { data?: unknown; error?: { code?: string } | null }>;
};

function makeAdminStub(options: StubOptions) {
  const rpcs: RpcCall[] = [];

  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        maybeSingle: async () => {
          if (table !== "profiles") return { data: null, error: null };
          const email = String(filters.email ?? "");
          const id = options.profiles[email];
          return { data: id ? { id } : null, error: null };
        },
      };
      return builder;
    },
    rpc: async (name: string, params?: Record<string, unknown>) => {
      rpcs.push({ name, params });
      const configured = options.rpc[name];
      if (!configured) return { data: null, error: null };
      if (configured.error) return { data: null, error: configured.error };
      return { data: configured.data ?? null, error: null };
    },
  };

  return { client: client as unknown as AdminSupabaseClient, rpcs };
}

const MIGRATION_RESULT = {
  projects_moved: 3,
  assets_moved: 1,
  created_by_backfilled: 1,
  slugs_renamed: 1,
  projects_left_in_personal: 1,
};

function happyPath(overrides: StubOptions["rpc"] = {}): StubOptions {
  return {
    profiles: {
      [OWNER_EMAIL]: OWNER_ID,
      [MEMBER_A]: MEMBER_A_ID,
      [MEMBER_B]: MEMBER_B_ID,
    },
    rpc: {
      ensure_team_workspace: { data: TEAM_ID },
      add_team_member: { data: true },
      migrate_personal_projects_to_team: { data: MIGRATION_RESULT },
      ...overrides,
    },
  };
}

async function capture(run: () => Promise<unknown>): Promise<Error> {
  const error = await run().then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("parseTeamInitArgs", () => {
  it("case 0: parses owner, members and the migrate flag", () => {
    expect(
      parseTeamInitArgs([
        "--owner-email",
        OWNER_EMAIL,
        "--members",
        `${MEMBER_A}, ${MEMBER_B}`,
        "--migrate",
      ]),
    ).toEqual({
      ownerEmail: OWNER_EMAIL,
      memberEmails: [MEMBER_A, MEMBER_B],
      migrate: true,
    });

    expect(() => parseTeamInitArgs([])).toThrow(/--owner-email is required/);
  });

  it("case 0b: main() exits 2 on bad arguments without touching the environment", async () => {
    // The parse failure happens before loadServerEnv()/createAdminSupabaseClient,
    // so this asserts the exit-code contract without ever opening a connection.
    await expect(main([])).resolves.toBe(2);
  });
});

describe("runTeamInit", () => {
  it("case 1: an unknown owner throws before any RPC", async () => {
    const { client, rpcs } = makeAdminStub({
      profiles: {},
      rpc: {},
    });

    const error = await capture(() =>
      runTeamInit(client, {
        ownerEmail: OWNER_EMAIL,
        memberEmails: [MEMBER_A],
        migrate: true,
      }),
    );

    expect(error.message).toContain("owner not found");
    expect(rpcs.length).toBe(0);
  });

  it("case 2: the RPC order is ensure -> add*N -> migrate, with the fixed team name", async () => {
    const { client, rpcs } = makeAdminStub(happyPath());

    const report = await runTeamInit(client, {
      ownerEmail: OWNER_EMAIL,
      memberEmails: [MEMBER_A, MEMBER_B],
      migrate: true,
    });

    expect(rpcs.map((call) => call.name)).toEqual([
      "ensure_team_workspace",
      "add_team_member",
      "add_team_member",
      "migrate_personal_projects_to_team",
    ]);
    expect(rpcs[0]?.params).toEqual({
      p_owner_user_id: OWNER_ID,
      p_name: "HaHart 团队",
    });
    expect(rpcs[1]?.params).toEqual({ p_user_id: MEMBER_A_ID, p_role: "member" });
    expect(report).toEqual({
      teamWorkspaceId: TEAM_ID,
      membersAdded: [MEMBER_A, MEMBER_B],
      membersAlreadyIn: [],
      membersNotFound: [],
      migration: MIGRATION_RESULT,
    } satisfies TeamInitReport);
  });

  it("case 3: without --migrate the migration function is never called", async () => {
    const { client, rpcs } = makeAdminStub(happyPath());

    const report = await runTeamInit(client, {
      ownerEmail: OWNER_EMAIL,
      memberEmails: [MEMBER_A],
      migrate: false,
    });

    expect(rpcs.some((call) => call.name === "migrate_personal_projects_to_team")).toBe(
      false,
    );
    expect(report.migration).toBeNull();
  });

  it("case 4: an unknown member email is reported and does not stop the others", async () => {
    const { client, rpcs } = makeAdminStub(happyPath());

    const report = await runTeamInit(client, {
      ownerEmail: OWNER_EMAIL,
      memberEmails: [MEMBER_MISSING, MEMBER_A],
      migrate: false,
    });

    expect(report.membersNotFound).toEqual([MEMBER_MISSING]);
    expect(report.membersAdded).toEqual([MEMBER_A]);
    expect(rpcs.filter((call) => call.name === "add_team_member").length).toBe(1);
  });

  it("case 5: a member who is already in goes to membersAlreadyIn", async () => {
    const { client } = makeAdminStub(happyPath({ add_team_member: { data: false } }));

    const report = await runTeamInit(client, {
      ownerEmail: OWNER_EMAIL,
      memberEmails: [MEMBER_A, MEMBER_B],
      migrate: false,
    });

    expect(report.membersAdded).toEqual([]);
    expect(report.membersAlreadyIn).toEqual([MEMBER_A, MEMBER_B]);
  });

  it("case 6: any RPC error aborts the whole run", async () => {
    const ensureFails = makeAdminStub(
      happyPath({ ensure_team_workspace: { error: { code: "42501" } } }),
    );
    await expect(
      runTeamInit(ensureFails.client, {
        ownerEmail: OWNER_EMAIL,
        memberEmails: [],
        migrate: false,
      }),
    ).rejects.toThrow(/ensure_team_workspace failed/);

    const addFails = makeAdminStub(
      happyPath({ add_team_member: { error: { code: "42501" } } }),
    );
    await expect(
      runTeamInit(addFails.client, {
        ownerEmail: OWNER_EMAIL,
        memberEmails: [MEMBER_A],
        migrate: false,
      }),
    ).rejects.toThrow(/add_team_member failed/);

    const migrateFails = makeAdminStub(
      happyPath({ migrate_personal_projects_to_team: { error: { code: "P0002" } } }),
    );
    await expect(
      runTeamInit(migrateFails.client, {
        ownerEmail: OWNER_EMAIL,
        memberEmails: [],
        migrate: true,
      }),
    ).rejects.toThrow(/migrate_personal_projects_to_team failed/);
  });
});
