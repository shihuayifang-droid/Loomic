import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { MemberCreditSummary } from "@loomic/shared";

import { buildApp } from "../app.js";
import type { AdminCreditWriteRepository } from "../db/admin-credit-write-repository.js";
import type { MemberCreditReadRepository } from "../db/member-credit-read-repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { ProjectService } from "../features/projects/project-service.js";
import type { TeamAdminService } from "../features/team/team-admin.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const PERSONAL_ID = "22222222-2222-2222-2222-222222222222";

const ADMIN_ID = "00000000-0000-0000-0000-00000000000e";
const OWNER_ID = "00000000-0000-0000-0000-00000000000f";
const MEMBER_ID = "00000000-0000-0000-0000-00000000000a";
const TARGET_ID = "00000000-0000-0000-0000-00000000000b";

const ROLES: Record<string, string | null> = {
  "member-token": "member",
  "admin-token": "admin",
  "owner-token": "owner",
};

const IDS: Record<string, string> = {
  "member-token": MEMBER_ID,
  "admin-token": ADMIN_ID,
  "owner-token": OWNER_ID,
};

type AdjustCall = {
  workspaceId: string;
  userId: string;
  operatorId: string;
  delta: number;
  reason: string;
};

type CapCall = {
  workspaceId: string;
  userId: string;
  cap: number;
  /** AD-01 / 39O: the route now names the administrator on every cap write. */
  operatorId?: string;
};

type CreateTemplateCall = {
  workspaceId: string;
  name: string;
  cap: number;
};

type ApplyTemplateCall = {
  workspaceId: string;
  templateId: string;
  userIds: string[];
  /** AD-01 / 39O: same optional-operator rule as the cap write above. */
  operatorId?: string;
};

/** AD-01 / BL-21 / 39O: what the generation pause write was asked for. */
type PauseCall = {
  workspaceId: string;
  userId: string;
  operatorId: string;
  paused: boolean;
  reason: string | null;
};

/** AD-01 / 37Z: what the member credit read was asked for. */
type MemberCreditCall = {
  workspaceId: string;
};

/** BL-44 / 38N: what the pool limit write was asked for. */
type PoolLimitCall = {
  workspaceId: string;
  limit: number;
  operatorId: string;
};

let poolLimitCalls: PoolLimitCall[] = [];
let poolLimitFailure: unknown = null;

/** A template id (uuid) and the two names the cases use. */
const TEMPLATE_ID = "33333333-3333-3333-3333-333333333333";

let adjustCalls: AdjustCall[] = [];
let capCalls: CapCall[] = [];
let createTemplateCalls: CreateTemplateCall[] = [];
let applyTemplateCalls: ApplyTemplateCall[] = [];
/** AD-01 / 37Z: the member credit reads the route made, and what it answered. */
let memberCreditCalls: MemberCreditCall[] = [];
let memberCreditsResult: MemberCreditSummary[] = [];
let memberCreditFailure: unknown = null;
/** The refusal / failure the repository double throws, verbatim. */
let writeFailure: unknown = null;
/** The refusal the template methods throw, verbatim. */
let templateFailure: unknown = null;
let transactionIdResult = "tx-1";
let capResult = 30000;
let templatesResult: { id: string; name: string; cap: number }[] = [];
let appliedResult = 1;
/** AD-01 / 39O: the pause writes the route made, and what the double answers. */
let pauseCalls: PauseCall[] = [];
let pauseChangedResult = true;
let pauseFailure: unknown = null;
/** When set, `teamMembership.get` throws instead of answering. */
let membershipFailure: Error | null = null;

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const id = IDS[token];
    if (!id) return null;
    return {
      accessToken: token,
      email: `${token}@hahart.test`,
      id,
      userMetadata: {},
    } satisfies AuthenticatedUser;
  },
};

const teamMembership: TeamMembershipService = {
  async get(userId) {
    if (membershipFailure) throw membershipFailure;
    const role = Object.entries(IDS).find(([, id]) => id === userId)?.[0];
    const membershipRole = role ? ROLES[role] : null;
    if (!membershipRole) return null;
    return {
      workspace: {
        id: TEAM_ID,
        name: "HaHart 团队",
        type: "team",
        ownerUserId: OWNER_ID,
      },
      role: membershipRole as "owner" | "admin" | "member",
    };
  },
  invalidate() {},
};

const adminCreditWriteRepository: AdminCreditWriteRepository = {
  async adjustTopup(input) {
    adjustCalls.push(input);
    if (writeFailure) throw writeFailure;
    return transactionIdResult;
  },
  async setPersonalCap(input) {
    capCalls.push(input);
    if (writeFailure) throw writeFailure;
    return capResult;
  },
  async setTeamPoolLimit(input) {
    poolLimitCalls.push(input);
    if (poolLimitFailure) throw poolLimitFailure;
    return input.limit;
  },
  async createCapTemplate(input) {
    createTemplateCalls.push(input);
    if (templateFailure) throw templateFailure;
    return { id: TEMPLATE_ID, name: input.name, cap: input.cap };
  },
  async listCapTemplates() {
    if (templateFailure) throw templateFailure;
    return templatesResult;
  },
  async applyCapTemplate(input) {
    applyTemplateCalls.push(input);
    if (templateFailure) throw templateFailure;
    return appliedResult;
  },
  async setGenerationPaused(input) {
    pauseCalls.push(input);
    if (pauseFailure) throw pauseFailure;
    return pauseChangedResult;
  },
};

/**
 * AD-01 / 37Z: the per-member credit read. A double like the write repository
 * above, so each case observes which workspace the route asked for and the
 * database is never reached.
 */
const memberCreditReadRepository: MemberCreditReadRepository = {
  async listMemberCredits(input) {
    memberCreditCalls.push(input);
    if (memberCreditFailure) throw memberCreditFailure;
    return memberCreditsResult;
  },
};

const viewerService: ViewerService = {
  async ensureViewer(user) {
    return {
      profile: {
        avatarUrl: null,
        displayName: "Member",
        email: user.email,
        id: user.id,
      },
      workspace: {
        id: PERSONAL_ID,
        name: "Personal",
        ownerUserId: user.id,
        type: "personal",
      },
      membership: { role: "owner", userId: user.id, workspaceId: PERSONAL_ID },
      teamWorkspace: {
        id: TEAM_ID,
        name: "HaHart 团队",
        ownerUserId: OWNER_ID,
        type: "team",
      },
      teamMembership: { role: "member", userId: user.id, workspaceId: TEAM_ID },
    } as never;
  },
};

const teamAdminService = {
  async listMembers() {
    return [];
  },
  async addMember() {
    throw new Error("not used");
  },
  async setRole() {
    throw new Error("not used");
  },
  async removeMember() {
    throw new Error("not used");
  },
  async recordForeignRead() {},
} as unknown as TeamAdminService;

const projectService = {
  async listProjects() {
    return [];
  },
  async createProject() {
    throw new Error("not used");
  },
  async getProject() {
    throw new Error("not used");
  },
  async updateProject() {},
  async archiveProject() {},
  async saveThumbnail() {
    throw new Error("not used");
  },
} as unknown as ProjectService;

const uploadService = {
  async uploadFile() {
    throw new Error("not used");
  },
  async getAssetUrl() {
    return "";
  },
  async deleteAsset() {},
} as unknown as UploadService;

let app: FastifyInstance;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(() => {
  adjustCalls = [];
  capCalls = [];
  poolLimitCalls = [];
  poolLimitFailure = null;
  createTemplateCalls = [];
  applyTemplateCalls = [];
  memberCreditCalls = [];
  memberCreditsResult = [];
  memberCreditFailure = null;
  writeFailure = null;
  templateFailure = null;
  transactionIdResult = "tx-1";
  capResult = 30000;
  templatesResult = [];
  appliedResult = 1;
  pauseCalls = [];
  pauseChangedResult = true;
  pauseFailure = null;
  membershipFailure = null;
  app = buildApp({
    adminCreditWriteRepository,
    auth,
    env: {},
    memberCreditReadRepository,
    projectService,
    teamAdminService,
    teamMembershipService: teamMembership,
    uploadService,
    viewerService,
  });
});

afterEach(async () => {
  await app.close();
});

describe("admin team credit routes", () => {
  it("case 1: BL-12: an admin adds 500 with a reason", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/team/members/${TARGET_ID}/credits`,
      headers: bearer("admin-token"),
      payload: { delta: 500, reason: "补发" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ transactionId: "tx-1" });
    expect(adjustCalls).toEqual([
      {
        workspaceId: TEAM_ID,
        userId: TARGET_ID,
        operatorId: ADMIN_ID,
        delta: 500,
        reason: "补发",
      },
    ]);
  });

  it("case 2: BL-12: taking more than there is says how much can be taken", async () => {
    writeFailure = { code: "P0405", detail: "500" };

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/team/members/${TARGET_ID}/credits`,
      headers: bearer("admin-token"),
      payload: { delta: -900, reason: "扣回" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("adjust_exceeds_topup");
    expect(response.json().error.message).toBe("最多可减 500");
  });

  it("case 3: BL-12: a reason is required", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/team/members/${TARGET_ID}/credits`,
      headers: bearer("admin-token"),
      payload: { delta: 500, reason: "  " },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    expect(adjustCalls.length).toBe(0);
  });

  it("case 4: BL-12: zero is not an adjustment", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/team/members/${TARGET_ID}/credits`,
      headers: bearer("admin-token"),
      payload: { delta: 0, reason: "补发" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    expect(adjustCalls.length).toBe(0);
  });

  it("case 5: AD-01: a member who is not an admin is refused", async () => {
    const refused = await app.inject({
      method: "POST",
      url: `/api/admin/team/members/${TARGET_ID}/credits`,
      headers: bearer("member-token"),
      payload: { delta: 500, reason: "补发" },
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("forbidden");
    expect(adjustCalls.length).toBe(0);

    const allowed = await app.inject({
      method: "POST",
      url: `/api/admin/team/members/${TARGET_ID}/credits`,
      headers: bearer("admin-token"),
      payload: { delta: -250, reason: "扣回" },
    });

    expect(allowed.statusCode).toBe(200);
    expect(adjustCalls.length).toBe(1);
  });

  it("case 6: AD-01: no token is a 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/team/members/${TARGET_ID}/credits`,
      payload: { delta: 500, reason: "补发" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    expect(adjustCalls.length).toBe(0);
  });

  it("case 7: AD-01: a bad user id is a 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/team/members/x/credits",
      headers: bearer("admin-token"),
      payload: { delta: 500, reason: "补发" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    expect(adjustCalls.length).toBe(0);
  });

  it("case 8: BL-01: an admin sets a personal cap", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/team/members/${TARGET_ID}/cap`,
      headers: bearer("admin-token"),
      payload: { cap: 30000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cap: 30000 });
    expect(capCalls).toEqual([
      { workspaceId: TEAM_ID, userId: TARGET_ID, cap: 30000, operatorId: ADMIN_ID },
    ]);
  });

  it("case 9: BL-01: a negative cap is refused", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/team/members/${TARGET_ID}/cap`,
      headers: bearer("admin-token"),
      payload: { cap: -1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    expect(capCalls.length).toBe(0);
  });

  it("case 10: AD-01: membership that cannot be read is a 503", async () => {
    membershipFailure = new Error("identity read failed");

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/team/members/${TARGET_ID}/credits`,
      headers: bearer("admin-token"),
      payload: { delta: 500, reason: "补发" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("application_error");
    expect(adjustCalls.length).toBe(0);
  });

  it("BL-01: an admin creates a template", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/team/cap-templates",
      headers: bearer("admin-token"),
      payload: { name: "实习", cap: 10000 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: TEMPLATE_ID,
      name: "实习",
      cap: 10000,
    });
    expect(createTemplateCalls).toEqual([
      { workspaceId: TEAM_ID, name: "实习", cap: 10000 },
    ]);
  });

  it("BL-01: a duplicate template name is refused", async () => {
    templateFailure = { code: "23505" };

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/team/cap-templates",
      headers: bearer("admin-token"),
      payload: { name: "实习", cap: 10000 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("invalid_request");
    expect(response.json().error.message).toBe("已有同名模板");
  });

  it("BL-01: templates are listed", async () => {
    templatesResult = [
      { id: TEMPLATE_ID, name: "主美", cap: 40000 },
      { id: "44444444-4444-4444-4444-444444444444", name: "美术", cap: 20000 },
    ];

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/team/cap-templates",
      headers: bearer("admin-token"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ templates: templatesResult });
  });

  it("BL-01: applying a template reports how many were changed", async () => {
    appliedResult = 1;

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/team/cap-templates/${TEMPLATE_ID}/apply`,
      headers: bearer("admin-token"),
      payload: { userIds: [TARGET_ID] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ applied: 1 });
    expect(applyTemplateCalls).toEqual([
      {
        workspaceId: TEAM_ID,
        templateId: TEMPLATE_ID,
        userIds: [TARGET_ID],
        operatorId: ADMIN_ID,
      },
    ]);
  });

  it("BL-01: an unknown template is a 404", async () => {
    templateFailure = { code: "22023" };

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/team/cap-templates/${TEMPLATE_ID}/apply`,
      headers: bearer("admin-token"),
      payload: { userIds: [TARGET_ID] },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("invalid_request");
    expect(response.json().error.message).toBe("模板不存在");
  });

  it("AD-01: a non-admin cannot manage templates", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/team/cap-templates",
      headers: bearer("member-token"),
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/team/cap-templates",
      headers: bearer("member-token"),
      payload: { name: "实习", cap: 10000 },
    });
    const applied = await app.inject({
      method: "POST",
      url: `/api/admin/team/cap-templates/${TEMPLATE_ID}/apply`,
      headers: bearer("member-token"),
      payload: { userIds: [TARGET_ID] },
    });

    expect(listed.statusCode).toBe(403);
    expect(created.statusCode).toBe(403);
    expect(applied.statusCode).toBe(403);
    expect(createTemplateCalls.length).toBe(0);
    expect(applyTemplateCalls.length).toBe(0);
  });

  it("AD-01: an admin reads every member's credits", async () => {
    memberCreditsResult = [
      {
        userId: MEMBER_ID,
        personalCap: 20000,
        teamUsed: 30,
        topup: 50,
        dailyRemaining: 0,
      },
      {
        userId: TARGET_ID,
        personalCap: 30000,
        teamUsed: 0,
        topup: 0,
        dailyRemaining: 100,
      },
    ];

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/team/members/credits",
      headers: bearer("admin-token"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ members: memberCreditsResult });
    // 读的是管理员自己的团队工作区，不是个人工作区。
    expect(memberCreditCalls).toEqual([{ workspaceId: TEAM_ID }]);

    // 同一个前缀上的成员列表路由没有被这条路由挤掉。
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/admin/team/members",
          headers: bearer("admin-token"),
        })
      ).statusCode,
    ).toBe(200);
  });

  it("AD-01: a non-admin reads no member credits", async () => {
    memberCreditsResult = [
      {
        userId: MEMBER_ID,
        personalCap: 20000,
        teamUsed: 0,
        topup: 0,
        dailyRemaining: 0,
      },
    ];

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/team/members/credits",
      headers: bearer("member-token"),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("forbidden");
    expect(memberCreditCalls.length).toBe(0);
  });

  it("AD-01: a failing member credit read is a 500", async () => {
    memberCreditFailure = new Error("member credit read failed (listMemberCredits)");

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/team/members/credits",
      headers: bearer("admin-token"),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("application_error");
    expect(response.json().error.message).toBe("Unable to read member credits.");
    // 管理员的团队工作区被问过，而失败的原因没有漏进响应。
    expect(memberCreditCalls).toEqual([{ workspaceId: TEAM_ID }]);
    expect(response.body).not.toMatch(/listMemberCredits|member credit read/);
  });

  it("BL-44: an admin changes the team pool limit", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/team/pool-limit",
      headers: bearer("admin-token"),
      payload: { limit: 50000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ limit: 50000 });
    expect(poolLimitCalls).toEqual([
      { workspaceId: TEAM_ID, limit: 50000, operatorId: ADMIN_ID },
    ]);
  });

  it("BL-44: a non-admin cannot change the team pool limit", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/team/pool-limit",
      headers: bearer("member-token"),
      payload: { limit: 50000 },
    });

    expect(response.statusCode).toBe(403);
    expect(poolLimitCalls.length).toBe(0);
  });

  it("BL-44: a negative or non-integer pool limit is a 400", async () => {
    const negative = await app.inject({
      method: "PUT",
      url: "/api/admin/team/pool-limit",
      headers: bearer("admin-token"),
      payload: { limit: -1 },
    });
    const fraction = await app.inject({
      method: "PUT",
      url: "/api/admin/team/pool-limit",
      headers: bearer("admin-token"),
      payload: { limit: 1.5 },
    });

    expect(negative.statusCode).toBe(400);
    expect(negative.json().error.code).toBe("invalid_request");
    expect(fraction.statusCode).toBe(400);
    expect(poolLimitCalls.length).toBe(0);
  });

  it("BL-44: a database refusal of the limit (22023) is a 400", async () => {
    poolLimitFailure = { code: "22023" };

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/team/pool-limit",
      headers: bearer("admin-token"),
      payload: { limit: 50000 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
  });

  // ── AD-01 / BL-21 / 39O: the existing writes name their operator, and the ──
  // ── pause / resume route exists ─────────────────────────────────────────

  it("AD-01: a cap set through the route is audited", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/team/members/${TARGET_ID}/cap`,
      headers: bearer("admin-token"),
      payload: { cap: 25000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cap: 30000 });
    // 仓储替身收到的就是审计包装的入参：写审计必须知道谁是操作人。
    expect(capCalls).toEqual([
      {
        workspaceId: TEAM_ID,
        userId: TARGET_ID,
        cap: 25000,
        operatorId: ADMIN_ID,
      },
    ]);
  });

  it("AD-01: applying a template passes the operator", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/team/cap-templates/${TEMPLATE_ID}/apply`,
      headers: bearer("admin-token"),
      payload: { userIds: [TARGET_ID, MEMBER_ID] },
    });

    expect(response.statusCode).toBe(200);
    expect(applyTemplateCalls).toEqual([
      {
        workspaceId: TEAM_ID,
        templateId: TEMPLATE_ID,
        userIds: [TARGET_ID, MEMBER_ID],
        operatorId: ADMIN_ID,
      },
    ]);
  });

  it("AD-01: an admin pauses a member with a reason", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/team/members/${TARGET_ID}/generation`,
      headers: bearer("admin-token"),
      payload: { paused: true, reason: "异常消耗" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ paused: true, changed: true });
    expect(pauseCalls).toEqual([
      {
        workspaceId: TEAM_ID,
        userId: TARGET_ID,
        operatorId: ADMIN_ID,
        paused: true,
        reason: "异常消耗",
      },
    ]);
  });

  it("AD-01: pausing without a reason is a 400", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/team/members/${TARGET_ID}/generation`,
      headers: bearer("admin-token"),
      payload: { paused: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    expect(response.json().error.message).toBe("暂停需要填写原因");
    expect(pauseCalls.length).toBe(0);
  });

  it("AD-01: a blank reason is refused before the database sees it", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/team/members/${TARGET_ID}/generation`,
      headers: bearer("admin-token"),
      payload: { paused: true, reason: "   " },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    expect(pauseCalls.length).toBe(0);
  });

  it("AD-01: resuming needs no reason", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/team/members/${TARGET_ID}/generation`,
      headers: bearer("admin-token"),
      payload: { paused: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ paused: false, changed: true });
    expect(pauseCalls).toEqual([
      {
        workspaceId: TEAM_ID,
        userId: TARGET_ID,
        operatorId: ADMIN_ID,
        paused: false,
        reason: null,
      },
    ]);
  });

  it("AD-01: a repeat pause reports changed: false", async () => {
    pauseChangedResult = false;

    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/team/members/${TARGET_ID}/generation`,
      headers: bearer("admin-token"),
      payload: { paused: true, reason: "异常消耗" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ paused: true, changed: false });
  });

  it("AD-01: a non-admin cannot pause", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/team/members/${TARGET_ID}/generation`,
      headers: bearer("member-token"),
      payload: { paused: true, reason: "异常消耗" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("forbidden");
    expect(pauseCalls.length).toBe(0);
  });

  it("AD-01: a database refusal of the pause (22023) is a 400", async () => {
    pauseFailure = { code: "22023" };

    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/team/members/${TARGET_ID}/generation`,
      headers: bearer("admin-token"),
      payload: { paused: true, reason: "异常消耗" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
  });

  it("AD-01: a failing pause is a 500 that leaks no internals", async () => {
    pauseFailure = new Error("set_member_generation_paused raised");

    const response = await app.inject({
      method: "PUT",
      url: `/api/admin/team/members/${TARGET_ID}/generation`,
      headers: bearer("admin-token"),
      payload: { paused: true, reason: "异常消耗" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("application_error");
    expect(response.json().error.message).toBe(
      "Unable to change the member's generation pause.",
    );
    expect(response.body).not.toMatch(/set_member_generation_paused|member_generation/);
  });

  it("AD-01: the member list carries generationPaused", async () => {
    memberCreditsResult = [
      {
        userId: MEMBER_ID,
        personalCap: 20000,
        teamUsed: 0,
        topup: 0,
        dailyRemaining: 0,
        generationPaused: true,
      },
      {
        userId: TARGET_ID,
        personalCap: 20000,
        teamUsed: 0,
        topup: 0,
        dailyRemaining: 0,
      },
    ];

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/team/members/credits",
      headers: bearer("admin-token"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ members: memberCreditsResult });

    const members = (response.json() as { members: Record<string, unknown>[] }).members;
    expect(members[0]?.generationPaused).toBe(true);
    // 未暂停的成员不带这个键，而不是带一个 false。
    expect(Object.hasOwn(members[1] ?? {}, "generationPaused")).toBe(false);
  });
});
