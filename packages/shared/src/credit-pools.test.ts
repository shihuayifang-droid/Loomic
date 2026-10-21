import { describe, expect, it } from "vitest";

import {
  availableCredits,
  defaultTeamPool,
  PERSONAL_MONTHLY_CAP,
  planDeduction,
  TEAM_POOL_PER_MEMBER,
  teamAllowance,
} from "./credit-pools.js";
import type { PoolBalances } from "./credit-pools.js";

function pools(over: Partial<PoolBalances> = {}): PoolBalances {
  return {
    daily: 0,
    teamRemaining: 0,
    personalTeamUsed: 0,
    personalCap: PERSONAL_MONTHLY_CAP,
    topup: 0,
    ...over,
  };
}

describe("credit pools (BL-45 / BL-04 / BL-44)", () => {
  it("BL-44: a three-member team starts the month with 60000", () => {
    expect(defaultTeamPool(3)).toBe(60000);
    expect(PERSONAL_MONTHLY_CAP).toBe(20000);
    expect(TEAM_POOL_PER_MEMBER).toBe(20000);
  });

  it("BL-45: available = daily + min(team left, cap left) + top-up", () => {
    const b = pools({
      daily: 50,
      teamRemaining: 30000,
      personalTeamUsed: 5000,
      personalCap: 20000,
      topup: 200,
    });
    expect(availableCredits(b)).toBe(15250);
  });

  it("BL-45: the team pool caps what one member may draw", () => {
    const b = pools({
      teamRemaining: 3000,
      personalTeamUsed: 0,
      personalCap: 20000,
    });
    expect(teamAllowance(b)).toBe(3000);
  });

  it("BL-04: daily is spent first", () => {
    const b = pools({ daily: 100, teamRemaining: 500, topup: 500 });
    expect(planDeduction(b, 30)).toEqual({
      ok: true,
      split: { daily: 30, team: 0, topup: 0 },
    });
  });

  it("BL-04: then the team pool, then top-up", () => {
    const b = pools({
      daily: 10,
      teamRemaining: 100,
      personalTeamUsed: 0,
      personalCap: 20000,
      topup: 50,
    });
    expect(planDeduction(b, 130)).toEqual({
      ok: true,
      split: { daily: 10, team: 100, topup: 20 },
    });
  });

  it("BL-45: a member at 19990 of the cap cannot take a 12-credit job", () => {
    const capped = pools({
      daily: 0,
      teamRemaining: 50000,
      personalTeamUsed: 19990,
      personalCap: 20000,
      topup: 0,
    });
    expect(planDeduction(capped, 12)).toEqual({
      ok: false,
      code: "personal_cap_reached",
    });

    const withTopup = pools({
      daily: 0,
      teamRemaining: 50000,
      personalTeamUsed: 19990,
      personalCap: 20000,
      topup: 100,
    });
    expect(planDeduction(withTopup, 12)).toEqual({
      ok: true,
      split: { daily: 0, team: 10, topup: 2 },
    });
  });

  it("BL-45: an empty team pool says so", () => {
    const b = pools({
      daily: 0,
      teamRemaining: 0,
      personalTeamUsed: 0,
      personalCap: 20000,
      topup: 0,
    });
    expect(planDeduction(b, 1)).toEqual({
      ok: false,
      code: "team_pool_exhausted",
    });
  });

  it("BL-45: someone with no team allowance at all is just out of credits", () => {
    const b = pools({
      daily: 5,
      teamRemaining: 0,
      personalTeamUsed: 0,
      personalCap: 0,
      topup: 0,
    });
    expect(planDeduction(b, 10)).toEqual({
      ok: false,
      code: "insufficient_credits",
    });
  });

  it("BL-45: negative inputs are treated as zero", () => {
    const dirty = pools({
      daily: -50,
      teamRemaining: -10,
      personalTeamUsed: -100,
      personalCap: -5,
      topup: -1,
    });
    expect(availableCredits(dirty)).toBe(0);
    expect(teamAllowance(dirty)).toBe(0);
    expect(planDeduction(dirty, 10)).toEqual({
      ok: false,
      code: "insufficient_credits",
    });
    expect(defaultTeamPool(-3)).toBe(0);
  });

  it("BL-04: the split always sums to the amount", () => {
    const cases: Array<[PoolBalances, number]> = [
      [pools({ daily: 100, teamRemaining: 0, personalCap: 0 }), 30],
      [
        pools({
          daily: 10,
          teamRemaining: 100,
          personalTeamUsed: 0,
          personalCap: 20000,
          topup: 50,
        }),
        130,
      ],
      [
        pools({
          daily: 0,
          teamRemaining: 50000,
          personalTeamUsed: 19990,
          personalCap: 20000,
          topup: 100,
        }),
        12,
      ],
    ];
    for (const [b, amount] of cases) {
      const plan = planDeduction(b, amount);
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.split.daily + plan.split.team + plan.split.topup).toBe(amount);
      }
    }
  });

  it("BL-45: a non-positive amount moves nothing", () => {
    const b = pools({ daily: 100, teamRemaining: 500, topup: 500 });
    expect(planDeduction(b, 0)).toEqual({
      ok: true,
      split: { daily: 0, team: 0, topup: 0 },
    });
    expect(planDeduction(b, -5)).toEqual({
      ok: true,
      split: { daily: 0, team: 0, topup: 0 },
    });
  });
});
