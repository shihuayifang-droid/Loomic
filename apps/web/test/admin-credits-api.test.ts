// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  adjustMemberTopup,
  applyCapTemplate,
  createCapTemplate,
  fetchCapTemplates,
  fetchMemberCredits,
  fetchTeamMembers,
  setMemberCap,
  setMemberGenerationPaused,
} from "../src/lib/admin-credits-api";
import { ApiApplicationError, ApiAuthError } from "../src/lib/server-api";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const MEMBER = {
  userId: "u1",
  personalCap: 50000,
  teamUsed: 1200,
  topup: 800,
  dailyRemaining: 30,
};

/** Run a call that must throw, and hand back whatever it threw. */
async function captureThrow(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("admin credits API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  it("fetchMemberCredits GETs the team member credits and returns members", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: [MEMBER] }),
    });

    const members = await fetchMemberCredits("t");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/admin/team/members/credits",
      expect.objectContaining({
        headers: { Authorization: "Bearer t" },
      }),
    );
    expect(members).toEqual([MEMBER]);
  });

  it("fetchTeamMembers GETs the team member list and returns members", async () => {
    const members = [
      {
        userId: "u1",
        email: "wang@example.com",
        displayName: "小王",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00Z",
      },
    ];
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members }),
    });

    const result = await fetchTeamMembers("t");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/admin/team/members",
      expect.objectContaining({
        headers: { Authorization: "Bearer t" },
      }),
    );
    expect(result).toEqual(members);
  });

  it("adjustMemberTopup POSTs delta and reason and returns the transaction id", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ transactionId: "tx-1" }),
    });

    const transactionId = await adjustMemberTopup("t", "u1", {
      delta: 500,
      reason: "补发",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/admin/team/members/u1/credits",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer t",
          "content-type": "application/json",
        },
        body: '{"delta":500,"reason":"补发"}',
      }),
    );
    expect(transactionId).toBe("tx-1");
  });

  it("BL-12: 409 adjust_exceeds_topup keeps the server's 最多可减 N message", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: "adjust_exceeds_topup", message: "最多可减 500" },
      }),
    });

    const thrown = await captureThrow(() =>
      adjustMemberTopup("t", "u1", { delta: -600, reason: "扣减" }),
    );

    expect(thrown).toBeInstanceOf(ApiApplicationError);
    expect(thrown).toMatchObject({
      code: "adjust_exceeds_topup",
      message: "最多可减 500",
    });
  });

  it("setMemberCap PUTs the cap and returns it", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cap: 30000 }),
    });

    const cap = await setMemberCap("t", "u1", 30000);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/admin/team/members/u1/cap",
      expect.objectContaining({
        method: "PUT",
        headers: {
          Authorization: "Bearer t",
          "content-type": "application/json",
        },
        body: '{"cap":30000}',
      }),
    );
    expect(cap).toBe(30000);
  });

  it("fetchCapTemplates GETs the template list", async () => {
    const templates = [{ id: "t1", name: "实习", cap: 10000 }];
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates }),
    });

    const result = await fetchCapTemplates("t");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/admin/team/cap-templates",
      expect.objectContaining({
        headers: { Authorization: "Bearer t" },
      }),
    );
    expect(result).toEqual(templates);
  });

  it("createCapTemplate POSTs name and cap and returns the created template", async () => {
    const created = { id: "t2", name: "实习", cap: 10000 };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => created,
    });

    const template = await createCapTemplate("t", { name: "实习", cap: 10000 });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/admin/team/cap-templates",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer t",
          "content-type": "application/json",
        },
        body: '{"name":"实习","cap":10000}',
      }),
    );
    expect(template).toEqual(created);
  });

  it("applyCapTemplate POSTs the member ids and returns how many it changed", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ applied: 1 }),
    });

    const applied = await applyCapTemplate("t", "t1", ["u1", "u2"]);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/admin/team/cap-templates/t1/apply",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer t",
          "content-type": "application/json",
        },
        body: '{"userIds":["u1","u2"]}',
      }),
    );
    expect(applied).toBe(1);
  });

  it("a 401 throws ApiAuthError", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: "unauthorized", message: "unauthorized" },
      }),
    });

    const thrown = await captureThrow(() => fetchMemberCredits("t"));

    expect(thrown).toBeInstanceOf(ApiAuthError);
  });

  it("a body that does not match the schema throws application_error", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: "x" }),
    });

    const thrown = await captureThrow(() => fetchMemberCredits("t"));

    expect(thrown).toBeInstanceOf(ApiApplicationError);
    expect(thrown).toMatchObject({ code: "application_error" });
  });

  it("AD-01: setMemberGenerationPaused sends paused and reason", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ paused: true, changed: true }),
    });

    const result = await setMemberGenerationPaused("t", "u1", {
      paused: true,
      reason: "异常消耗",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/admin/team/members/u1/generation",
      expect.objectContaining({
        method: "PUT",
        headers: {
          Authorization: "Bearer t",
          "content-type": "application/json",
        },
        body: '{"paused":true,"reason":"异常消耗"}',
      }),
    );
    expect(result).toEqual({ paused: true, changed: true });
  });
});
