// @credits-system — BL-06: the one place the web app names the credit pool a ledger line came from.

/** BL-06: the user-facing name of each credit pool. */
export const POOL_LABELS = { daily: "每日赠送", team: "团队池", topup: "充值" } as const;

/** BL-06: the short name a pool carries inside a split ("每日 5 · 团队 7"). */
const POOL_SHORT_LABELS: Record<keyof typeof POOL_LABELS, string> = {
  daily: "每日",
  team: "团队",
  topup: "充值",
};

/** The order a split lists its parts in — daily, team, topup. */
const POOL_ORDER = ["daily", "team", "topup"] as const;

/** BL-06: the pool cell — one pool by name, a split as "每日 5 · 团队 7", nothing known as "—". */
export function poolLabelOf(t: {
  pool?: "daily" | "team" | "topup" | null | undefined;
  pool_breakdown?: { daily: number; team: number; topup: number } | null | undefined;
}): string {
  if (t.pool) return POOL_LABELS[t.pool];

  const breakdown = t.pool_breakdown;
  if (!breakdown) return "—";

  const parts: string[] = [];
  for (const pool of POOL_ORDER) {
    const amount = Math.abs(breakdown[pool]);
    if (amount === 0) continue;
    parts.push(`${POOL_SHORT_LABELS[pool]} ${amount}`);
  }
  return parts.length === 0 ? "—" : parts.join(" · ");
}
