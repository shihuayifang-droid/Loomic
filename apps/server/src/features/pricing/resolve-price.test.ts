import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { priceDetailSchema } from "@loomic/shared";
import { describe, expect, it } from "vitest";

import {
  MODEL_NOT_AVAILABLE,
  UNKNOWN_SEARCH_KEY,
  WILDCARD,
  resolvePriceFromCandidates,
  type PricingRuleCandidate,
  type ResolvePriceInput,
  type ResolvePriceOutcome,
} from "./resolve-price.js";

/**
 * GN-07 计价规则匹配（工单 31A · T8）。
 *
 * 这里全部是纯函数用例：没有数据库、没有 HTTP、没有时钟。候选规则是手写的，
 * 因为要验的正是「同样一堆候选，按优先级该命中哪一条」—— 那条逻辑一旦依赖
 * 数据库，就只能靠 PGlite 才能测，而 6 级 × 通配组合的矩阵在 SQL 里根本读不出来。
 * 真实表数据、定时生效、CHECK 约束在隔壁
 * `test-support/db/pricing-rule-repository-db.test.ts`。
 *
 * 用例编号与工单 §3.3 / §4 的验收条目一一对应：
 * - 级 1~6 各一例（case 1~6），另加一例证明「顺序即优先级」（case 7）。
 * - GN-07 验收 2（agent 取 6 / 生成器取 4）= case 8。
 * - GN-01 验收 2（未配置档位走默认行）= case 9。
 * - pending / active / fail closed / 契约 key 集合 = case 10~18。
 * - BL-14 验收 1 的「代码里没有价格常量」= case 19~20。
 */

const MODEL = "kwjm/gpt-image-2";
const OTHER_MODEL = "google/nano-banana";

/** 默认规则 id：内容不重要，但用例要能分辨「命中了哪一条」，所以每条都传。 */
const DEFAULT_RULE_ID = "00000000-0000-0000-0000-000000000001";

/** 候选取值的一半，`rule()` 再把价格状态收成判别联合要求的形状。 */
type RuleSpec = {
  id?: string;
  modelId?: string;
  entryPoint?: PricingRuleCandidate["entryPoint"];
  searchKey?: string;
  timePeriod?: PricingRuleCandidate["timePeriod"];
  unitName?: string;
  unitSize?: number | null;
  effectiveAt?: string;
  extras?: readonly Record<string, unknown>[];
  priceStatus?: PricingRuleCandidate["priceStatus"];
  price?: number | null;
};

/**
 * 造一条候选规则。价格状态按迁移的 CHECK 收口：`pending` 一定不带价格，
 * `active` 一定带非负整数价格 —— 这正是 `PricingRuleCandidate` 那个判别联合说的。
 */
function rule(spec: RuleSpec = {}): PricingRuleCandidate {
  const base = {
    id: spec.id ?? DEFAULT_RULE_ID,
    modelId: spec.modelId ?? MODEL,
    entryPoint: spec.entryPoint ?? WILDCARD,
    searchKey: spec.searchKey ?? WILDCARD,
    timePeriod: spec.timePeriod ?? "normal",
    unitName: spec.unitName ?? "次",
    unitSize: spec.unitSize ?? null,
    effectiveAt: spec.effectiveAt ?? "2026-10-19T00:00:00.000Z",
    extras: spec.extras ?? [],
  } as const;

  if ((spec.priceStatus ?? "pending") === "pending") {
    return { ...base, priceStatus: "pending", price: null };
  }

  return { ...base, priceStatus: "active", price: spec.price ?? 0 };
}

function ask(overrides: Partial<ResolvePriceInput> = {}): ResolvePriceInput {
  return {
    modelId: MODEL,
    entryPoint: "agent",
    searchKey: "2k",
    ...overrides,
  };
}

/**
 * 所有用例只有两种结局；把这个分支收在一处，用例里就能直接读 `detail`，
 * 而 `ok: false` 的那一半会被这里判失败（并带上错误码）。
 */
function expectOk(
  outcome: ResolvePriceOutcome,
): asserts outcome is Extract<ResolvePriceOutcome, { ok: true }> {
  expect(outcome.ok, `expected a resolved price, got ${JSON.stringify(outcome)}`).toBe(true);
}

describe("resolve-price: GN-07 六级优先级", () => {
  it("case 1: 级 1 —— (entryPoint, searchKey, normal) 精确命中", () => {
    const outcome = resolvePriceFromCandidates(
      ask(),
      [rule({ id: "exact", entryPoint: "agent", searchKey: "2k", priceStatus: "active", price: 6 })],
      true,
    );

    expectOk(outcome);
    expect(outcome.ruleId).toBe("exact");
    expect(outcome.detail.total_price).toBe(6);
    expect(outcome.detail.search_key_matched).toBe("2k");
  });

  it("case 2: 级 2 —— 入口通配 (*, searchKey, normal)", () => {
    const outcome = resolvePriceFromCandidates(
      ask(),
      [rule({ id: "any-entry", entryPoint: WILDCARD, searchKey: "2k", priceStatus: "active", price: 4 })],
      true,
    );

    expectOk(outcome);
    expect(outcome.ruleId).toBe("any-entry");
    expect(outcome.detail.total_price).toBe(4);
    // 命中的是具体档位，只有「默认行」才把 matched 抹成 null。
    expect(outcome.detail.search_key_matched).toBe("2k");
  });

  it("case 3: 级 3 —— 时段通配 (entryPoint, searchKey, *)", () => {
    const outcome = resolvePriceFromCandidates(
      ask(),
      [
        rule({
          id: "any-period",
          entryPoint: "agent",
          searchKey: "2k",
          timePeriod: WILDCARD,
          priceStatus: "active",
          price: 7,
        }),
      ],
      true,
    );

    expectOk(outcome);
    expect(outcome.ruleId).toBe("any-period");
    expect(outcome.detail.total_price).toBe(7);
  });

  it("case 4: 级 4 —— (*, searchKey, *)", () => {
    const outcome = resolvePriceFromCandidates(
      ask(),
      [
        rule({
          id: "any-entry-any-period",
          entryPoint: WILDCARD,
          searchKey: "2k",
          timePeriod: WILDCARD,
          priceStatus: "active",
          price: 3,
        }),
      ],
      true,
    );

    expectOk(outcome);
    expect(outcome.ruleId).toBe("any-entry-any-period");
    expect(outcome.detail.total_price).toBe(3);
  });

  it("case 5: 级 5 —— (entryPoint, *) 命中默认行：search_key=unknown、matched=null", () => {
    const outcome = resolvePriceFromCandidates(
      ask(),
      [
        rule({
          id: "entry-default",
          entryPoint: "agent",
          searchKey: WILDCARD,
          priceStatus: "active",
          price: 2,
        }),
      ],
      true,
    );

    expectOk(outcome);
    expect(outcome.ruleId).toBe("entry-default");
    // GN-01 验收 2 / 工单 §3.3：默认行对外报 unknown + null。
    expect(outcome.detail.search_key).toBe(UNKNOWN_SEARCH_KEY);
    expect(outcome.detail.search_key_matched).toBeNull();
    expect(outcome.detail.total_price).toBe(2);
  });

  it("case 6: 级 6 —— (*, *) 全通配（模型默认价）", () => {
    const outcome = resolvePriceFromCandidates(
      ask(),
      [rule({ id: "model-default", searchKey: WILDCARD, priceStatus: "active", price: 1 })],
      true,
    );

    expectOk(outcome);
    expect(outcome.ruleId).toBe("model-default");
    expect(outcome.detail.search_key).toBe(UNKNOWN_SEARCH_KEY);
    expect(outcome.detail.search_key_matched).toBeNull();
    expect(outcome.detail.total_price).toBe(1);
  });

  it("case 7: 六级同时在表里时级 1 胜出 —— 列表顺序就是优先级", () => {
    const candidates = [
      rule({ id: "l6", entryPoint: WILDCARD, searchKey: WILDCARD, priceStatus: "active", price: 6 }),
      rule({ id: "l5", entryPoint: "agent", searchKey: WILDCARD, priceStatus: "active", price: 5 }),
      rule({ id: "l4", entryPoint: WILDCARD, searchKey: "2k", timePeriod: WILDCARD, priceStatus: "active", price: 4 }),
      rule({ id: "l3", entryPoint: "agent", searchKey: "2k", timePeriod: WILDCARD, priceStatus: "active", price: 3 }),
      rule({ id: "l2", entryPoint: WILDCARD, searchKey: "2k", priceStatus: "active", price: 2 }),
      rule({ id: "l1", entryPoint: "agent", searchKey: "2k", priceStatus: "active", price: 1 }),
    ];

    const outcome = resolvePriceFromCandidates(ask(), candidates, true);

    expectOk(outcome);
    expect(outcome.ruleId).toBe("l1");
    expect(outcome.detail.total_price).toBe(1);
  });

  it("case 8: GN-07 验收 2 —— A·agent·2k=6 与 A·*·2k=4 并存时，agent 取 6、canvas_generator 取 4", () => {
    const candidates = [
      rule({ id: "agent-2k", entryPoint: "agent", searchKey: "2k", priceStatus: "active", price: 6 }),
      rule({ id: "any-2k", entryPoint: WILDCARD, searchKey: "2k", priceStatus: "active", price: 4 }),
    ];

    const fromAgent = resolvePriceFromCandidates(ask({ entryPoint: "agent" }), candidates, true);
    const fromGenerator = resolvePriceFromCandidates(
      ask({ entryPoint: "canvas_generator" }),
      candidates,
      true,
    );

    expectOk(fromAgent);
    expectOk(fromGenerator);
    expect(fromAgent.detail.total_price).toBe(6);
    expect(fromGenerator.detail.total_price).toBe(4);
    // GN-07 验收 3：两条都是「命中具体档位」，matched 与规则一致。
    expect(fromAgent.detail.search_key_matched).toBe("2k");
    expect(fromGenerator.detail.search_key_matched).toBe("2k");
    // 入口是请求值原样回传，不是规则行的 `*`。
    expect(fromGenerator.detail.entry_point).toBe("canvas_generator");
  });

  it("case 9: GN-01 验收 2 —— 请求未配置的档位时走默认行，total = 模型默认价", () => {
    const candidates = [
      rule({ id: "hd", entryPoint: WILDCARD, searchKey: "hd", priceStatus: "active", price: 4 }),
      rule({ id: "default", entryPoint: WILDCARD, searchKey: WILDCARD, priceStatus: "active", price: 2 }),
    ];

    const outcome = resolvePriceFromCandidates(ask({ searchKey: "8k" }), candidates, true);

    expectOk(outcome);
    expect(outcome.ruleId).toBe("default");
    expect(outcome.detail.search_key).toBe(UNKNOWN_SEARCH_KEY);
    expect(outcome.detail.search_key_matched).toBeNull();
    expect(outcome.detail.total_price).toBe(2);
  });
});

describe("resolve-price: 价格状态（GN-07 / BL-14）", () => {
  it("case 10: pending 不是错误 —— 三个价格是 0、单位数仍是 1、状态照实报", () => {
    const outcome = resolvePriceFromCandidates(
      ask({ searchKey: "hd" }),
      [rule({ id: "pending-hd", entryPoint: WILDCARD, searchKey: "hd" })],
      true,
    );

    expectOk(outcome);
    expect(outcome.detail.price_status).toBe("pending");
    expect(outcome.detail.base_price).toBe(0);
    expect(outcome.detail.unit_price).toBe(0);
    expect(outcome.detail.total_price).toBe(0);
    expect(outcome.detail.unit_count).toBe(1);
    // 待定价不等于「没配上档位」：档位仍然算命中。
    expect(outcome.detail.search_key_matched).toBe("hd");
  });

  it("case 11: active 且价格为 0 时 total 是 0，但状态是 active —— 与待定价可区分", () => {
    const outcome = resolvePriceFromCandidates(
      ask(),
      [rule({ id: "free", entryPoint: WILDCARD, searchKey: "2k", priceStatus: "active", price: 0 })],
      true,
    );

    expectOk(outcome);
    expect(outcome.detail.price_status).toBe("active");
    expect(outcome.detail.total_price).toBe(0);
  });

  it("case 12: active 时 total = unit_price = base_price = 规则价，unit_count = 1", () => {
    const outcome = resolvePriceFromCandidates(
      ask(),
      [rule({ id: "priced", entryPoint: WILDCARD, searchKey: "2k", priceStatus: "active", price: 12 })],
      true,
    );

    expectOk(outcome);
    expect(outcome.detail.base_price).toBe(12);
    expect(outcome.detail.unit_price).toBe(12);
    expect(outcome.detail.total_price).toBe(12);
    expect(outcome.detail.unit_count).toBe(1);
  });
});

describe("resolve-price: fail closed（GN-07 / AG-10）", () => {
  it("case 13: 未登记的模型一律 model_not_available —— 哪怕候选里恰有同名行", () => {
    const candidates = [rule({ id: "stray", entryPoint: "agent", searchKey: "2k", priceStatus: "active", price: 9 })];

    const outcome = resolvePriceFromCandidates(ask(), candidates, false);

    expect(outcome).toEqual({ ok: false, code: MODEL_NOT_AVAILABLE });
  });

  it("case 14: 已登记但没有任何候选 → model_not_available（不是免费）", () => {
    const outcome = resolvePriceFromCandidates(ask(), [], true);

    expect(outcome).toEqual({ ok: false, code: MODEL_NOT_AVAILABLE });
  });

  it("case 15: 已登记但候选全不匹配 → model_not_available（不是免费）", () => {
    const candidates = [
      rule({ id: "other-model", modelId: OTHER_MODEL, entryPoint: WILDCARD, searchKey: WILDCARD, priceStatus: "active", price: 5 }),
      rule({ id: "other-key", entryPoint: WILDCARD, searchKey: "hd", priceStatus: "active", price: 5 }),
    ];

    const outcome = resolvePriceFromCandidates(ask({ searchKey: "8k" }), candidates, true);

    expect(outcome).toEqual({ ok: false, code: MODEL_NOT_AVAILABLE });
  });
});

describe("resolve-price: price_detail 契约（GN-01）", () => {
  it("case 16: key 集合与 shared 的 priceDetailSchema 完全一致，且能 parse 通过", () => {
    const outcome = resolvePriceFromCandidates(
      ask(),
      [rule({ id: "contract", entryPoint: WILDCARD, searchKey: "2k", priceStatus: "active", price: 8 })],
      true,
    );

    expectOk(outcome);

    // 集合相等，不比顺序：判据是「字段一个不多、一个不少」。
    expect(Object.keys(outcome.detail).sort()).toEqual(
      Object.keys(priceDetailSchema.shape).sort(),
    );
    // 字段齐还不够，类型也要对 —— parse 是真正的契约检查。
    expect(() => priceDetailSchema.parse(outcome.detail)).not.toThrow();
  });

  it("case 17: 规则行的单位 / 附加项与请求入口原样透传，一期恒定值为 normal / false / 1", () => {
    const outcome = resolvePriceFromCandidates(
      ask({ entryPoint: "agent_generator", searchKey: "2k" }),
      [
        rule({
          id: "video",
          entryPoint: WILDCARD,
          searchKey: "2k",
          unitName: "秒",
          unitSize: 5,
          priceStatus: "active",
          price: 30,
          extras: [{ id: "audio", amount: 5 }],
        }),
      ],
      true,
    );

    expectOk(outcome);
    expect(outcome.detail.unit_name).toBe("秒");
    expect(outcome.detail.entry_point).toBe("agent_generator");
    expect(outcome.detail.time_variant_period).toBe("normal");
    expect(outcome.detail.disable_unlimited).toBe(false);
    expect(outcome.detail.extras).toEqual([{ id: "audio", amount: 5 }]);
  });

  it("case 18: 命中规则时回报 ruleId —— 调用方要能说清「命中了哪条规则」", () => {
    const outcome = resolvePriceFromCandidates(
      ask(),
      [rule({ id: "rule-abc", entryPoint: WILDCARD, searchKey: "2k", priceStatus: "active", price: 1 })],
      true,
    );

    expectOk(outcome);
    expect(outcome.ruleId).toBe("rule-abc");
  });
});

/** 去掉注释再扫数字：出处（BL-14 / GN-07 / 工单号）写在注释里，不算价格常量。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * BL-14 验收 1 的后端部分：涉及价格的两个源文件里**不许出现价格常量**。
 *
 * 允许清单是有意收窄的，每一档都有理由：
 * - `0`：待定价的金额、`price >= 0` 这种边界比较必须写得出来。
 * - `1`（仅 resolve-price.ts）：一期 `unit_count` 恒为 1。它是**计价单位数**，
 *   不是价格；把它挪进价目表也不对（BL-14 第 7 条：计价单位是规则行的事，
 *   而「一次询价几个单位」是询价方的事）。
 *
 * 换句话说：这份清单里出现任何别的数字，就说明有价格常量漏进了代码。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");

const GUARDED_FILES: ReadonlyArray<{
  label: string;
  path: string;
  allowedDigits: readonly string[];
}> = [
  {
    label: "packages/shared/src/pricing.ts",
    path: join(REPO_ROOT, "packages", "shared", "src", "pricing.ts"),
    allowedDigits: ["0"],
  },
  {
    label: "apps/server/src/features/pricing/resolve-price.ts",
    path: join(REPO_ROOT, "apps", "server", "src", "features", "pricing", "resolve-price.ts"),
    allowedDigits: ["0", "1"],
  },
];

function offendingDigits(source: string, allowed: readonly string[]): string[] {
  const digits = stripComments(source).match(/\d+/g) ?? [];
  return digits.filter((value) => !allowed.includes(value));
}

describe("BL-14 验收 1：价格代码里没有价格常量", () => {
  it("case 19: 两个源文件里除了允许的那几个数字，没有别的数字字面量", () => {
    for (const guarded of GUARDED_FILES) {
      const source = readFileSync(guarded.path, "utf8");
      // 文件读到了才有意义：路径写错时 readFileSync 会抛，不会静默通过。
      expect(source.length).toBeGreaterThan(0);
      expect(
        offendingDigits(source, guarded.allowedDigits),
        `${guarded.label} 里出现数字字面量`,
      ).toEqual([]);
    }
  });

  it("case 20: 守卫自身有效 —— 伪造的源码里出现 9 会被检出", () => {
    const fake = ["export function f() {", "  return 9;", "}"].join("\n");

    expect(offendingDigits(fake, ["0", "1"])).toEqual(["9"]);
  });
});
