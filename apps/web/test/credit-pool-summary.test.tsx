// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BL-02 / BL-45: the settings Usage tab opens with a three-pool summary. The
 * server sends the pools (`useCredits().pools`); the summary only formats them,
 * so every number below is a literal from the fixture and the bar is the
 * server's `personalTeamUsed / personalCap`.
 */
type Pools = {
  balances: {
    daily: number;
    teamRemaining: number;
    personalTeamUsed: number;
    personalCap: number;
    topup: number;
  };
  available: number;
};

const h = vi.hoisted(() => ({
  pools: null as Pools | null | undefined,
}));

vi.mock("@/hooks/use-credits", () => ({
  useCredits: () => ({
    balance: h.pools?.available ?? 0,
    pools: h.pools,
    plan: "free",
    dailyClaimed: false,
    limits: null,
    loading: false,
    error: null,
    refresh: async () => {},
    claimDaily: async () => true,
  }),
}));

import { CreditPoolSummary } from "../src/components/credits/credit-pool-summary";

/** 50 今日赠送 + 15,000 团队剩余 + 200 充值 = 15,250 可用 */
const POOLS: Pools = {
  balances: {
    daily: 50,
    teamRemaining: 30000,
    personalTeamUsed: 5000,
    personalCap: 20000,
    topup: 200,
  },
  available: 15250,
};

function renderSummary(pools: Pools | null | undefined) {
  h.pools = pools;
  return render(<CreditPoolSummary />);
}

/** The colored fill inside the progress bar carries the percentage width. */
function barWidth(): string {
  const bar = screen.getByTestId("credits-pool-cap-progress");
  const fill = bar.firstElementChild as HTMLElement;
  return fill.style.width;
}

describe("CreditPoolSummary", () => {
  beforeEach(() => {
    h.pools = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("BL-45: the summary shows the one available figure and three pools", () => {
    renderSummary(POOLS);

    expect(screen.getByTestId("credits-pool-available")).toHaveTextContent(
      "15,250",
    );
    expect(screen.getByTestId("credits-pool-daily")).toHaveTextContent("50");
    expect(screen.getByTestId("credits-pool-team")).toHaveTextContent(
      "15,000",
    );
    expect(screen.getByTestId("credits-pool-topup")).toHaveTextContent("200");
  });

  it("BL-02: the progress bar is used / limit from the server", () => {
    renderSummary(POOLS);

    const bar = screen.getByTestId("credits-pool-cap-progress");
    expect(bar).toHaveAttribute("role", "progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "5000");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "20000");

    expect(screen.getByTestId("credits-pool-cap-text")).toHaveTextContent(
      "本月已用 5,000 / 上限 20,000",
    );
    // 5,000 / 20,000 = 25%
    expect(barWidth()).toBe("25%");
  });

  it("BL-45: the pools add up to the available figure", () => {
    renderSummary(POOLS);

    const read = (testid: string): number =>
      Number(screen.getByTestId(testid).textContent?.replace(/,/g, ""));

    const daily = read("credits-pool-daily");
    const team = read("credits-pool-team");
    const topup = read("credits-pool-topup");

    expect(daily).toBe(50);
    expect(team).toBe(15000);
    expect(topup).toBe(200);
    expect(daily + team + topup).toBe(15250);
    expect(
      Number(
        screen.getByTestId("credits-pool-available").textContent?.replace(
          /,/g,
          "",
        ),
      ),
    ).toBe(15250);
  });

  it("BL-45: with no pools nothing is shown", () => {
    const { container } = renderSummary(null);

    expect(container).toBeEmptyDOMElement();
  });

  it("BL-45: a response without the pools key shows nothing either", () => {
    const { container } = renderSummary(undefined);

    expect(container).toBeEmptyDOMElement();
  });

  it("BL-02: a zero cap shows an empty bar", () => {
    renderSummary({
      balances: {
        daily: 50,
        teamRemaining: 30000,
        personalTeamUsed: 0,
        personalCap: 0,
        topup: 200,
      },
      available: 30050,
    });

    const bar = screen.getByTestId("credits-pool-cap-progress");
    expect(bar).toHaveAttribute("aria-valuemax", "0");
    expect(barWidth()).toBe("0%");
    expect(screen.getByTestId("credits-pool-cap-text")).toHaveTextContent(
      "本月已用 0 / 上限 0",
    );
  });
});
