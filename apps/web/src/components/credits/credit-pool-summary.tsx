// @credits-system — BL-02 / BL-45: the three pools behind the one available figure
"use client";

import type { JSX } from "react";

import { useCredits } from "@/hooks/use-credits";

function formatCredits(value: number): string {
  return value.toLocaleString("zh-CN");
}

/**
 * BL-45: reads the pools the server already sends and shows them as the one
 * available figure plus a row per pool. BL-02: the progress bar is the server's
 * `personalTeamUsed / personalCap`, never a number recomputed on the client.
 *
 * `pools` is null when the credit switch is off or the caller has no team
 * workspace (`undefined` only for a response without the key), and then the
 * component renders nothing so the settings page looks exactly as it did.
 */
export function CreditPoolSummary(): JSX.Element | null {
  const { pools } = useCredits();

  if (!pools) return null;

  const { balances, available } = pools;
  const { daily, teamRemaining, personalTeamUsed, personalCap, topup } = balances;

  // BL-45: the team row is what is left of the personal cap inside the team
  // pool — never a negative number.
  const teamAvailable = Math.max(
    0,
    Math.min(teamRemaining, personalCap - personalTeamUsed),
  );

  // BL-02: the bar is `used / limit` from the server; a zero cap has no bar.
  const capPercent =
    personalCap > 0 ? Math.min(100, (personalTeamUsed / personalCap) * 100) : 0;

  return (
    <div className="mb-6 space-y-3 rounded-lg border p-4">
      <div>
        <p className="text-xs text-muted-foreground">可用额度</p>
        <p
          data-testid="credits-pool-available"
          className="text-2xl font-semibold tabular-nums text-foreground"
        >
          {formatCredits(available)}
        </p>
      </div>

      <dl className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">今日赠送</dt>
          <dd
            data-testid="credits-pool-daily"
            className="tabular-nums text-foreground"
          >
            {formatCredits(daily)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">团队额度（本月剩余可用）</dt>
          <dd
            data-testid="credits-pool-team"
            className="tabular-nums text-foreground"
          >
            {formatCredits(teamAvailable)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">充值余额</dt>
          <dd
            data-testid="credits-pool-topup"
            className="tabular-nums text-foreground"
          >
            {formatCredits(topup)}
          </dd>
        </div>
      </dl>

      <div className="space-y-1">
        <div
          data-testid="credits-pool-cap-progress"
          role="progressbar"
          aria-valuenow={personalTeamUsed}
          aria-valuemin={0}
          aria-valuemax={personalCap}
          aria-label="本月已从团队池用 / 个人上限"
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${capPercent}%` }}
          />
        </div>
        <p
          data-testid="credits-pool-cap-text"
          className="text-xs tabular-nums text-muted-foreground"
        >
          本月已用 {formatCredits(personalTeamUsed)} / 上限{" "}
          {formatCredits(personalCap)}
        </p>
      </div>
    </div>
  );
}
