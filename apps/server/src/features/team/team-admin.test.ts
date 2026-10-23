import { describe, expect, it } from "vitest";

import type { TeamMember } from "@loomic/shared";

import type { TeamAdminReadRepository } from "../../db/team-admin-read-repository.js";
import type { TeamAdminWriteRepository } from "../../db/team-admin-write-repository.js";
import type { TeamMembershipService } from "./team-membership.js";
import {
  TeamAdminError,
  createTeamAdminService,
  type TeamAdminService,
} from "./team-admin.js";

const ACTOR_ID = "00000000-0000-0000-0000-00000000000e";
const TARGET_ID = "00000000-0000-0000-0000-00000000000b";

type WriteCall = { name: string; params: Record<string, unknown> };

type RemoveResult = {
  removed: number;
  projects: number;
  assets: number;
  objects: number;
};

type StubOptions = {
  profile?: { id: string; email?: string } | null;
  /** What the repository's email lookup answers; throws when it is an Error. */
  profileLookupError?: Error;
  /** When set, every write repository method throws an Error with this message. */
  writeErrorMessage?: string;
  /** What addMember / setRole answer. Defaults to true. */
  writeResult?: boolean;
  /** What removeMember answers. */
  removeResult?: RemoveResult;
  /** What the roster repository answers; throws when it is an Error. */
  members?: TeamMember[];
  memberError?: Error;
  /** Build the service without the roster repository (wiring-bug path). */
  withoutReadRepository?: boolean;
  /** Build the service without the write repository (wiring-bug path). */
  withoutWriteRepository?: boolean;
};

function makeHarness(options: StubOptions = {}) {
  const writes: WriteCall[] = [];
  const invalidated: string[] = [];
  const actorIds: string[] = [];
  const lookedUpEmails: string[] = [];
  const lookupActorIds: string[] = [];
  const teamMembership: TeamMembershipService = {
    async get() {
      return null;
    },
    invalidate(userId) {
      invalidated.push(userId);
    },
  };

  const readRepository: TeamAdminReadRepository = {
    async listTeamMembers({ actorId }) {
      actorIds.push(actorId);
      if (options.memberError) throw options.memberError;
      return options.members ?? [];
    },
    async findProfileByEmailForAdmin({ actorId, email }) {
      lookupActorIds.push(actorId);
      lookedUpEmails.push(email);
      if (options.profileLookupError) throw options.profileLookupError;
      return options.profile ?? null;
    },
  };

  function record(name: string, params: Record<string, unknown>) {
    writes.push({ name, params });
    if (options.writeErrorMessage !== undefined) {
      throw new Error(options.writeErrorMessage);
    }
  }

  const writeRepository: TeamAdminWriteRepository = {
    async addMember({ actorId, userId, role }) {
      record("addMember", { actorId, userId, role });
      return options.writeResult ?? true;
    },
    async setRole({ actorId, userId, role }) {
      record("setRole", { actorId, userId, role });
      return options.writeResult ?? true;
    },
    async removeMember({ actorId, userId }) {
      record("removeMember", { actorId, userId });
      return (
        options.removeResult ?? {
          removed: 1,
          projects: 0,
          assets: 0,
          objects: 0,
        }
      );
    },
    async recordForeignRead({ actorId, via, projectId, canvasId, sessionId }) {
      record("recordForeignRead", {
        actorId,
        via,
        projectId,
        canvasId,
        sessionId,
      });
      return true;
    },
    async recordForeignAssetRead({ actorId, assetId }) {
      record("recordForeignAssetRead", { actorId, assetId });
      return true;
    },
  };

  const service: TeamAdminService = createTeamAdminService({
    teamMembership,
    ...(options.withoutReadRepository
      ? {}
      : { teamAdminReadRepository: readRepository }),
    ...(options.withoutWriteRepository
      ? {}
      : { teamAdminWriteRepository: writeRepository }),
  });

  return {
    service,
    writes,
    invalidated,
    actorIds,
    lookedUpEmails,
    lookupActorIds,
  };
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
  it("case 1: addMember resolves the email then calls the audited write", async () => {
    const { service, writes, invalidated, lookedUpEmails, lookupActorIds } =
      makeHarness({
        profile: { id: TARGET_ID },
        writeResult: true,
      });

    const result = await service.addMember(ACTOR_ID, {
      email: "  b@hahart.test  ",
      role: "admin",
    });

    expect(result).toEqual({ added: true });
    // The lookup is the repository's read, and it carries the trimmed email
    // and the real actor.
    expect(lookedUpEmails).toEqual(["b@hahart.test"]);
    expect(lookupActorIds).toEqual([ACTOR_ID]);
    expect(writes).toEqual([
      {
        name: "addMember",
        params: { actorId: ACTOR_ID, userId: TARGET_ID, role: "admin" },
      },
    ]);
    expect(invalidated).toEqual([TARGET_ID]);
  });

  it("case 2: an unknown email is a 404 with no write call and no invalidation", async () => {
    const { service, writes, invalidated, lookedUpEmails } = makeHarness({
      profile: null,
    });

    const error = await capture(() =>
      service.addMember(ACTOR_ID, { email: "nobody@hahart.test", role: "member" }),
    );

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("user_not_found");
    expect(error.message).toBe("No user with email nobody@hahart.test.");
    expect(lookedUpEmails).toEqual(["nobody@hahart.test"]);
    expect(writes.length).toBe(0);
    expect(invalidated.length).toBe(0);
  });

  it("case 3: setRole calls the audited write and invalidates the target", async () => {
    const { service, writes, invalidated } = makeHarness({ writeResult: true });

    const result = await service.setRole(ACTOR_ID, TARGET_ID, "admin");

    expect(result).toEqual({ changed: true });
    expect(writes).toEqual([
      {
        name: "setRole",
        params: { actorId: ACTOR_ID, userId: TARGET_ID, role: "admin" },
      },
    ]);
    expect(invalidated).toEqual([TARGET_ID]);
  });

  it("case 4: removeMember with removed = 0 is a 404 and invalidates nothing", async () => {
    const { service, writes, invalidated } = makeHarness({
      removeResult: { projects: 0, assets: 0, objects: 0, removed: 0 },
    });

    const error = await capture(() => service.removeMember(ACTOR_ID, TARGET_ID));

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("user_not_found");
    expect(writes.length).toBe(1);
    expect(invalidated.length).toBe(0);
  });

  it("case 4b: removeMember passes the transfer counts through", async () => {
    const { service, invalidated } = makeHarness({
      removeResult: { projects: 2, assets: 3, objects: 1, removed: 1 },
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
      const { service } = makeHarness({ writeErrorMessage: message });
      const error = await capture(() =>
        service.setRole(ACTOR_ID, TARGET_ID, "member"),
      );

      expect(error.statusCode, message).toBe(statusCode);
      expect(error.code, message).toBe(code);
    }
  });

  it("case 6: recordForeignRead sends exactly one target and the via value", async () => {
    const { service, writes } = makeHarness();

    await service.recordForeignRead(ACTOR_ID, "project", { projectId: "p-1" });
    await service.recordForeignRead(ACTOR_ID, "canvas", { canvasId: "c-1" });
    await service.recordForeignRead(ACTOR_ID, "messages", { sessionId: "s-1" });

    expect(writes).toEqual([
      {
        name: "recordForeignRead",
        params: {
          actorId: ACTOR_ID,
          via: "project",
          projectId: "p-1",
          canvasId: null,
          sessionId: null,
        },
      },
      {
        name: "recordForeignRead",
        params: {
          actorId: ACTOR_ID,
          via: "canvas",
          projectId: null,
          canvasId: "c-1",
          sessionId: null,
        },
      },
      {
        name: "recordForeignRead",
        params: {
          actorId: ACTOR_ID,
          via: "messages",
          projectId: null,
          canvasId: null,
          sessionId: "s-1",
        },
      },
    ]);
  });

  it("case 6b: an asset target goes through recordForeignAssetRead", async () => {
    const { service, writes } = makeHarness();

    await service.recordForeignRead(ACTOR_ID, "asset", { assetId: "asset-1" });

    expect(writes).toEqual([
      {
        name: "recordForeignAssetRead",
        params: { actorId: ACTOR_ID, assetId: "asset-1" },
      },
    ]);
  });

  it("case 7: a failing recordForeignRead throws instead of being swallowed", async () => {
    const { service } = makeHarness({
      writeErrorMessage: "connection terminated unexpectedly",
    });

    await expect(
      service.recordForeignRead(ACTOR_ID, "project", { projectId: "p-1" }),
    ).rejects.toThrow(/connection terminated unexpectedly/);
  });

  it("case 8: listMembers hands the actor to the repository and returns its rows unchanged", async () => {
    const members: TeamMember[] = [
      {
        userId: TARGET_ID,
        email: "",
        displayName: null,
        role: "member",
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        userId: ACTOR_ID,
        email: "admin@hahart.test",
        displayName: "Admin",
        role: "owner",
        joinedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    const { service, actorIds } = makeHarness({ members });

    const result = await service.listMembers(ACTOR_ID);

    expect(actorIds).toEqual([ACTOR_ID]);
    // Order and projection are the repository's; the service adds nothing and
    // fills nothing in — a member without a profile stays `email: ""`.
    expect(result).toEqual(members);
  });

  it("case 9: listMembers writes nothing and invalidates no cache", async () => {
    const { service, writes, invalidated, actorIds } = makeHarness({
      members: [],
    });

    await service.listMembers(ACTOR_ID);

    expect(writes).toEqual([]);
    expect(invalidated).toEqual([]);
    expect(actorIds).toEqual([ACTOR_ID]);
  });

  it("case 10: a repository failure is a fixed 503 that leaks no driver detail", async () => {
    const { service } = makeHarness({
      memberError: new Error(
        "connect ECONNREFUSED 10.210.134.37:5432 for postgres://user:pw@host/db",
      ),
    });

    const error = await capture(() => service.listMembers(ACTOR_ID));

    expect(error.statusCode).toBe(503);
    expect(error.code).toBe("application_error");
    expect(error.message).toBe("Unable to load team members.");
    expect(error.message).not.toContain("ECONNREFUSED");
    expect(error.message).not.toContain("postgres://");
  });

  it("case 11: without a repository the read is a 503 — never a fallback", async () => {
    const { service, writes } = makeHarness({
      withoutReadRepository: true,
      profile: { id: TARGET_ID },
    });

    const error = await capture(() => service.listMembers(ACTOR_ID));

    expect(error.statusCode).toBe(503);
    expect(error.code).toBe("application_error");
    expect(error.message).toBe("Unable to load team members.");
    expect(writes).toEqual([]);
  });

  it("case 12: an empty roster is an empty list, not an error", async () => {
    const { service, invalidated } = makeHarness({ members: [] });

    await expect(service.listMembers(ACTOR_ID)).resolves.toEqual([]);
    expect(invalidated).toEqual([]);
  });

  it("case 13: each call carries the actor it was given", async () => {
    const { service, actorIds } = makeHarness({ members: [] });

    await service.listMembers(ACTOR_ID);
    await service.listMembers(TARGET_ID);

    expect(actorIds).toEqual([ACTOR_ID, TARGET_ID]);
  });

  it("case 14: the lookup gets the trimmed email and the actor, and its id is what the write receives", async () => {
    const { service, writes, invalidated, lookedUpEmails, lookupActorIds } =
      makeHarness({ profile: { id: TARGET_ID } });

    const result = await service.addMember(ACTOR_ID, {
      email: "  Mixed.Case@Hahart.test  ",
      role: "member",
    });

    expect(result).toEqual({ added: true });
    // Trimmed exactly once, in the service: the case is untouched, because the
    // lookup is an exact equality and lowercasing it would change who is found.
    expect(lookedUpEmails).toEqual(["Mixed.Case@Hahart.test"]);
    expect(lookupActorIds).toEqual([ACTOR_ID]);
    expect(writes).toEqual([
      {
        name: "addMember",
        params: { actorId: ACTOR_ID, userId: TARGET_ID, role: "member" },
      },
    ]);
    expect(invalidated).toEqual([TARGET_ID]);
  });

  it("case 15: an idempotent add still runs the write once and invalidates the target once", async () => {
    const { service, writes, invalidated, lookedUpEmails } = makeHarness({
      profile: { id: TARGET_ID },
      writeResult: false,
    });

    await expect(
      service.addMember(ACTOR_ID, { email: "b@hahart.test", role: "member" }),
    ).resolves.toEqual({ added: false });

    expect(lookedUpEmails).toEqual(["b@hahart.test"]);
    expect(writes).toHaveLength(1);
    expect(invalidated).toEqual([TARGET_ID]);
  });

  it("case 16: a lookup failure is a fixed 503 that leaks no driver detail, with no write and no invalidation", async () => {
    const { service, writes, invalidated, lookedUpEmails } = makeHarness({
      profileLookupError: new Error(
        "connect ECONNREFUSED 10.210.134.37:5432 for postgres://user:pw@host/db",
      ),
    });

    const error = await capture(() =>
      service.addMember(ACTOR_ID, { email: "b@hahart.test", role: "member" }),
    );

    expect(error.statusCode).toBe(503);
    expect(error.code).toBe("application_error");
    expect(error.message).toBe("Unable to add the team member.");
    expect(error.message).not.toContain("ECONNREFUSED");
    expect(error.message).not.toContain("postgres://");
    expect(error.message).not.toContain("team admin read failed");
    // One attempt, and the write never happened.
    expect(lookedUpEmails).toEqual(["b@hahart.test"]);
    expect(writes).toEqual([]);
    expect(invalidated).toEqual([]);
  });

  it("case 17: without a read repository the add is a 503 — never a fallback", async () => {
    const { service, writes, invalidated } = makeHarness({
      withoutReadRepository: true,
      profile: { id: TARGET_ID },
    });

    const error = await capture(() =>
      service.addMember(ACTOR_ID, { email: "b@hahart.test", role: "member" }),
    );

    expect(error.statusCode).toBe(503);
    expect(error.code).toBe("application_error");
    expect(error.message).toBe("Unable to add the team member.");
    expect(writes).toEqual([]);
    expect(invalidated).toEqual([]);
  });

  it("case 18: a refused add keeps the existing mapping and invalidates nothing", async () => {
    const { service, writes, invalidated } = makeHarness({
      profile: { id: TARGET_ID },
      writeErrorMessage: "actor is not a team admin",
    });

    const error = await capture(() =>
      service.addMember(ACTOR_ID, { email: "b@hahart.test", role: "admin" }),
    );

    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("forbidden");
    expect(writes).toHaveLength(1);
    expect(invalidated).toEqual([]);
  });

  it("case 19: an unrecognised write failure stays a 503 with the cache left alone", async () => {
    const { service, writes, invalidated } = makeHarness({
      profile: { id: TARGET_ID },
      writeErrorMessage: "connection terminated unexpectedly",
    });

    const error = await capture(() =>
      service.addMember(ACTOR_ID, { email: "b@hahart.test", role: "member" }),
    );

    expect(error.statusCode).toBe(503);
    expect(error.code).toBe("application_error");
    expect(error.message).toBe("connection terminated unexpectedly");
    expect(writes).toHaveLength(1);
    expect(invalidated).toEqual([]);
  });

  it("case 20: the happy path's only write is the repository's addMember", async () => {
    const { service, writes } = makeHarness({ profile: { id: TARGET_ID } });

    await service.addMember(ACTOR_ID, { email: "b@hahart.test", role: "member" });

    // The service's only database calls are the repository's read and the
    // audited write: it writes no audit row of its own.
    expect(writes.map((call) => call.name)).toEqual(["addMember"]);
  });

  it("case 21: without a write repository the add is a 503 — never a fallback", async () => {
    const { service, writes, invalidated, lookedUpEmails } = makeHarness({
      withoutWriteRepository: true,
      profile: { id: TARGET_ID },
    });

    const error = await capture(() =>
      service.addMember(ACTOR_ID, { email: "b@hahart.test", role: "member" }),
    );

    expect(error.statusCode).toBe(503);
    expect(error.code).toBe("application_error");
    expect(error.message).toBe("Team administration is unavailable.");
    expect(lookedUpEmails).toEqual(["b@hahart.test"]);
    expect(writes).toEqual([]);
    expect(invalidated).toEqual([]);
  });
});
