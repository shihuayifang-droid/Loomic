// @credits-system — BL-45 / BL-04 / BL-44: the ONE available-credit reading and
// deduction-split rule. Every surface (X-P4 preflight, GN-01 quote, GN-03 status,
// BL-15 summary) reads these functions instead of re-deriving the three pools.

/** BL-45 / D-17: the most one member may take from the team pool in a calendar month. */
export const PERSONAL_MONTHLY_CAP = 20_000;

/** BL-44 / Q-18: default team pool per member per month. */
export const TEAM_POOL_PER_MEMBER = 20_000;

export type PoolBalances = {
  /** Daily gift pool balance (personal). */
  daily: number;
  /** Team periodic pool remaining (workspace-shared). */
  teamRemaining: number;
  /** How much this member has already drawn from the team pool this month. */
  personalTeamUsed: number;
  /** This member's monthly cap (defaults to PERSONAL_MONTHLY_CAP). */
  personalCap: number;
  /** Top-up pool balance (personal). */
  topup: number;
};

/** Dirty-data guard: any non-finite or negative number reads as 0. */
function nonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function normalized(b: PoolBalances): PoolBalances {
  return {
    daily: nonNegative(b.daily),
    teamRemaining: nonNegative(b.teamRemaining),
    personalTeamUsed: nonNegative(b.personalTeamUsed),
    personalCap: nonNegative(b.personalCap),
    topup: nonNegative(b.topup),
  };
}

/** BL-44: default monthly team pool for a workspace of `memberCount` members. */
export function defaultTeamPool(memberCount: number): number {
  if (!Number.isFinite(memberCount)) return 0;
  return Math.max(0, Math.floor(memberCount)) * TEAM_POOL_PER_MEMBER;
}

/** BL-45: how much of the team pool this member may still draw. */
export function teamAllowance(b: PoolBalances): number {
  const { teamRemaining, personalTeamUsed, personalCap } = normalized(b);
  return Math.max(0, Math.min(teamRemaining, personalCap - personalTeamUsed));
}

/** BL-45: the ONE available-credit figure every surface shows. */
export function availableCredits(b: PoolBalances): number {
  const { daily, topup } = normalized(b);
  return daily + teamAllowance(b) + topup;
}

export type PoolSplit = { daily: number; team: number; topup: number };

export type DeductPlan =
  | { ok: true; split: PoolSplit }
  | {
      ok: false;
      code: "personal_cap_reached" | "team_pool_exhausted" | "insufficient_credits";
    };

function emptySplit(): PoolSplit {
  return { daily: 0, team: 0, topup: 0 };
}

/**
 * BL-04: take `amount` from daily first, then team (within the member's
 * allowance), then top-up. Refuse with the BL-45 priority order when it does
 * not fit. Negative inputs are read as 0; this never throws.
 */
export function planDeduction(b: PoolBalances, amount: number): DeductPlan {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: true, split: emptySplit() };
  }

  const { daily, teamRemaining, personalTeamUsed, personalCap, topup } =
    normalized(b);

  let remaining = amount;

  const fromDaily = Math.min(daily, remaining);
  remaining -= fromDaily;

  const teamLeft = Math.min(teamRemaining, personalCap - personalTeamUsed);
  const fromTeam = Math.min(Math.max(0, teamLeft), remaining);
  remaining -= fromTeam;

  const fromTopup = Math.min(topup, remaining);
  remaining -= fromTopup;

  if (remaining > 0) {
    const capLeft = personalCap - personalTeamUsed;
    // Neither the team pool nor the member's cap is in play at all.
    if (teamRemaining <= 0 && capLeft <= 0) {
      return { ok: false, code: "insufficient_credits" };
    }
    // The member's monthly cap runs out first.
    if (capLeft <= teamRemaining) {
      return { ok: false, code: "personal_cap_reached" };
    }
    // The shared team pool runs out first.
    return { ok: false, code: "team_pool_exhausted" };
  }

  return { ok: true, split: { daily: fromDaily, team: fromTeam, topup: fromTopup } };
}
