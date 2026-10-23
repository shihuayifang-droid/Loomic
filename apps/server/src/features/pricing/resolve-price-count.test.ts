import { describe, expect, it } from "vitest";

import {
  WILDCARD,
  resolvePriceFromCandidates,
  type PricingRuleCandidate,
} from "./resolve-price.js";

/** AG-07: the image count is a linear multiplier on the quote; unit_price never moves. */

const MODEL = "kwjm/gpt-image-2";

const RULE: PricingRuleCandidate = {
  id: "00000000-0000-0000-0000-0000000000a1",
  modelId: MODEL,
  entryPoint: WILDCARD,
  searchKey: WILDCARD,
  timePeriod: "normal",
  unitName: "x",
  unitSize: null,
  effectiveAt: "2026-10-19T00:00:00.000Z",
  extras: [],
  priceStatus: "active",
  price: 7,
};

function detailFor(unitCount?: number) {
  const outcome = resolvePriceFromCandidates(
    {
      modelId: MODEL,
      entryPoint: "canvas_generator",
      searchKey: "2k",
      ...(unitCount === undefined ? {} : { unitCount }),
    },
    [RULE],
    true,
  );
  if (!outcome.ok) throw new Error(`expected a price, got ${outcome.code}`);
  return outcome.detail;
}

describe("resolve-price: AG-07 unitCount", () => {
  it("unitCount 10 -> unit_count 10 and total_price = unit_price x 10", () => {
    const detail = detailFor(10);
    expect(detail.unit_count).toBe(10);
    expect(detail.unit_price).toBe(7);
    expect(detail.total_price).toBe(detail.unit_price * 10);
  });

  it.each([
    ["absent", undefined],
    ["0", 0],
    ["11", 11],
    ["2.5", 2.5],
  ])("unitCount %s -> unit_count 1", (_label, value) => {
    const detail = detailFor(value as number | undefined);
    expect(detail.unit_count).toBe(1);
    expect(detail.total_price).toBe(detail.unit_price);
  });
});