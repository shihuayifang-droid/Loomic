import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PricingRuleRepository } from "../../db/pricing-rule-repository.js";
import {
  createPriceQuoter,
  type PriceQuoter,
} from "./price-quoter.js";
import type { PricingRuleCandidate } from "./resolve-price.js";

/**
 * 工单31B · T1 —— `price-quoter` 的单元用例（不连数据库）。
 *
 * 这一层只做一件事：把「这个 id 登记过没有」+「此刻可见的候选规则」按 GN-07 变成
 * 一个报价。真 SQL / 真迁移在 `test-support/db/price-quoter-db.test.ts`，这里钉的是
 * 三条仓储读不了的性质：
 *
 * 1. **未登记的模型一次候选读都不发**：没有规则行，候选必然是空数组，读了也没有
 *    新信息；而且多读一次就多一次可能失败的 IO。
 * 2. **仓储错误原样传上去**：一次读失败被吞成「0 元」就是全站免费一秒。
 * 3. **不缓存**：改价必须立即生效（BL-14 第 4 条），所以每次询价都要重新读。
 */

const MODEL = "kwjm/gpt-image-2";
const AT = new Date("2026-10-19T10:00:00.000Z");

/** 一条 `active` 的候选规则（`pricing_rules` 一行的仓储形态）。 */
function candidate(overrides: Partial<PricingRuleCandidate> = {}): PricingRuleCandidate {
  return {
    id: "rule-hd",
    modelId: MODEL,
    entryPoint: "*",
    searchKey: "hd",
    timePeriod: "normal",
    unitName: "次",
    unitSize: null,
    effectiveAt: "2026-10-01T00:00:00.000Z",
    extras: [],
    priceStatus: "active",
    price: 12,
    ...overrides,
  } as PricingRuleCandidate;
}

function makeRepository(overrides: Partial<PricingRuleRepository> = {}) {
  return {
    hasModel: vi.fn(async () => true),
    listCandidateRules: vi.fn(async () => [candidate()]),
    ...overrides,
  } as unknown as PricingRuleRepository &
    Record<string, ReturnType<typeof vi.fn>>;
}

describe("priceQuoter", () => {
  let repository: ReturnType<typeof makeRepository>;
  let quoter: PriceQuoter;

  beforeEach(() => {
    repository = makeRepository();
    quoter = createPriceQuoter({ pricingRuleRepository: repository });
  });

  it("case 1: an unregistered model is model_not_available, and NO candidate read is sent", async () => {
    repository = makeRepository({ hasModel: vi.fn(async () => false) });
    quoter = createPriceQuoter({ pricingRuleRepository: repository });

    const outcome = await quoter.quote({
      modelId: "forged/not-a-real-model",
      entryPoint: "agent",
      searchKey: "hd",
      at: AT,
    });

    expect(outcome).toEqual({ ok: false, code: "model_not_available" });
    expect(repository.hasModel).toHaveBeenCalledWith({ modelId: "forged/not-a-real-model" });
    // GN-07：未登记在匹配之前就返回，所以候选读一次都不发。
    expect(repository.listCandidateRules).not.toHaveBeenCalled();
  });

  it("case 2: a registered model is quoted from the rule the priority order picks", async () => {
    const outcome = await quoter.quote({
      modelId: MODEL,
      entryPoint: "canvas_generator",
      searchKey: "hd",
      at: AT,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`expected a quote, got ${outcome.code}`);

    expect(outcome.ruleId).toBe("rule-hd");
    expect(outcome.detail.total_price).toBe(12);
    expect(outcome.detail.search_key).toBe("hd");
    expect(outcome.detail.search_key_matched).toBe("hd");
    expect(outcome.detail.entry_point).toBe("canvas_generator");
    expect(outcome.detail.price_status).toBe("active");
    // `at` 原样交给候选读：定时生效（BL-14 验收 5）靠的就是这一个时刻。
    expect(repository.listCandidateRules).toHaveBeenCalledWith({ modelId: MODEL, at: AT });
  });

  it("case 3: registered but no rule matched is model_not_available (fail closed, not free)", async () => {
    repository = makeRepository({ listCandidateRules: vi.fn(async () => []) });
    quoter = createPriceQuoter({ pricingRuleRepository: repository });

    await expect(
      quoter.quote({ modelId: MODEL, entryPoint: "agent", searchKey: "hd", at: AT }),
    ).resolves.toEqual({ ok: false, code: "model_not_available" });
  });

  it("case 4: a failing hasModel is rethrown, never turned into a price", async () => {
    const failure = new Error("pricing rule read failed (hasModel)");
    repository = makeRepository({
      hasModel: vi.fn(async () => {
        throw failure;
      }),
    });
    quoter = createPriceQuoter({ pricingRuleRepository: repository });

    await expect(
      quoter.quote({ modelId: MODEL, entryPoint: "agent", searchKey: "hd", at: AT }),
    ).rejects.toBe(failure);
  });

  it("case 5: a failing listCandidateRules is rethrown, never turned into 0", async () => {
    const failure = new Error("pricing rule read failed (listCandidateRules)");
    repository = makeRepository({
      listCandidateRules: vi.fn(async () => {
        throw failure;
      }),
    });
    quoter = createPriceQuoter({ pricingRuleRepository: repository });

    await expect(
      quoter.quote({ modelId: MODEL, entryPoint: "agent", searchKey: "hd", at: AT }),
    ).rejects.toBe(failure);
  });

  it("case 6: nothing is cached — a repriced table is visible on the very next quote (BL-14 第4条)", async () => {
    // The same repository answers differently on its second read: a new rule row
    // became the newest one for this combination between the two quotes.
    const reads = vi
      .fn()
      .mockResolvedValueOnce([candidate()])
      .mockResolvedValueOnce([candidate({ id: "rule-hd-repriced", price: 20 })]);
    repository = makeRepository({ listCandidateRules: reads });
    quoter = createPriceQuoter({ pricingRuleRepository: repository });

    const first = await quoter.quote({
      modelId: MODEL,
      entryPoint: "agent",
      searchKey: "hd",
      at: AT,
    });
    expect(first.ok && first.detail.total_price).toBe(12);

    const second = await quoter.quote({
      modelId: MODEL,
      entryPoint: "agent",
      searchKey: "hd",
      at: AT,
    });

    expect(second.ok && second.detail.total_price).toBe(20);
    expect(second.ok && second.ruleId).toBe("rule-hd-repriced");
    // Two quotes, two reads of each repository: no memoization anywhere.
    expect(repository.hasModel).toHaveBeenCalledTimes(2);
    expect(reads).toHaveBeenCalledTimes(2);
  });
});
