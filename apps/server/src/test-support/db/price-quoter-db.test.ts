import type { PGlite } from "@electric-sql/pglite";
import { IMAGE_MODEL_CATALOG } from "@loomic/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPricingRuleRepository,
  type PricingRuleRepository,
} from "../../db/pricing-rule-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  createPriceQuoter,
  type PriceQuoter,
} from "../../features/pricing/price-quoter.js";
import { createMigratedDb, createPGliteTransactionPool } from "./pglite-db.js";

/**
 * 工单31B · T7 —— `price-quoter` 的真 SQL 用例（GN-07 验收 2）。
 *
 * `price-quoter.test.ts` 用替身钉住「读了几次、错误怎么传」；这一文件钉住的是
 * **真 PostgreSQL 解析器**下的三件事，替身证明不了：
 *
 * 1. GN-07 验收 2 的两级命中：同一个档位 `2k` 上，`agent` 命中自己那条 6，
 *    `canvas_generator` 回落到通配入口那条 4，两边 `search_key_matched` 都是 `2k`。
 * 2. 种子模型（20 个图片模型之一）用 `hd` 询价 → `pending`、`total_price` 0。
 *    BL-14 第 2 条：一期种子只建行、不填价，所以这就是预期结果。
 * 3. 伪造的 model id → `model_not_available`，且候选为空（fail closed）。
 *
 * 所有插入都落在 `tool:quick_edit` 这个**已有种子模型**上，插入的是新的 active 行；
 * 种子行本身不改（种子行数在别的文件里已经有断言）。
 */

const SEEDED_TOOL_MODEL = "tool:quick_edit";

/** 种子里的图片模型之一（`IMAGE_MODEL_CATALOG` 的键），四行全 pending。 */
const SEEDED_IMAGE_MODEL = "kwjm/gpt-image-2";

const FORGED_MODEL = "forged/not-a-real-model";

/** 两条规则都要求「早于当前时间」生效，所以显式给一个过去的时刻（不依赖 now()）。 */
const EFFECTIVE_AT = new Date(Date.now() - 60_000).toISOString();

const INSERT_RULE_SQL = `
insert into public.pricing_rules (
  model_id, entry_point, search_key, time_period, unit_name, price, price_status, effective_at
) values ($1::text, $2::text, $3::text, 'normal', '次', $4::int, 'active', $5::timestamptz)
returning id::text as id
`;

let db: PGlite;
let pool: TransactionPool;
let repository: PricingRuleRepository;
let quoter: PriceQuoter;

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createPricingRuleRepository({ getTransactionPool: () => pool });
  quoter = createPriceQuoter({ pricingRuleRepository: repository });

  // GN-07 验收 2 的两条规则：入口精确的贵、通配入口的便宜。
  await db.query(INSERT_RULE_SQL, [SEEDED_TOOL_MODEL, "agent", "2k", 6, EFFECTIVE_AT]);
  await db.query(INSERT_RULE_SQL, [SEEDED_TOOL_MODEL, "*", "2k", 4, EFFECTIVE_AT]);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("price quoter: GN-07 验收 2（入口优先级）", () => {
  it("case 1: agent 用 2k 询价命中自己那条 6，档位报 2k", async () => {
    const outcome = await quoter.quote({
      modelId: SEEDED_TOOL_MODEL,
      entryPoint: "agent",
      searchKey: "2k",
      at: new Date(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`expected a quote, got ${outcome.code}`);

    expect(outcome.detail.total_price).toBe(6);
    expect(outcome.detail.base_price).toBe(6);
    expect(outcome.detail.unit_price).toBe(6);
    expect(outcome.detail.search_key_matched).toBe("2k");
    expect(outcome.detail.search_key).toBe("2k");
    expect(outcome.detail.entry_point).toBe("agent");
    expect(outcome.detail.price_status).toBe("active");
    // 命中的是 agent 那条规则，不是通配那条。
    const agentRule = await db.query<{ id: string }>(
      "select id::text as id from public.pricing_rules where model_id = $1 and entry_point = 'agent' and search_key = '2k'",
      [SEEDED_TOOL_MODEL],
    );
    expect(outcome.ruleId).toBe(agentRule.rows[0]?.id);
  });

  it("case 2: canvas_generator 用同一个 2k 询价回落到通配入口那条 4，档位仍报 2k", async () => {
    const outcome = await quoter.quote({
      modelId: SEEDED_TOOL_MODEL,
      entryPoint: "canvas_generator",
      searchKey: "2k",
      at: new Date(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`expected a quote, got ${outcome.code}`);

    expect(outcome.detail.total_price).toBe(4);
    expect(outcome.detail.search_key_matched).toBe("2k");
    expect(outcome.detail.search_key).toBe("2k");
    expect(outcome.detail.entry_point).toBe("canvas_generator");

    const wildcardRule = await db.query<{ id: string }>(
      "select id::text as id from public.pricing_rules where model_id = $1 and entry_point = '*' and search_key = '2k'",
      [SEEDED_TOOL_MODEL],
    );
    expect(outcome.ruleId).toBe(wildcardRule.rows[0]?.id);
  });

  it("case 3: 两次询价的价格不同，说明命中的确实是两条不同的规则行", async () => {
    const [viaAgent, viaCanvas] = await Promise.all([
      quoter.quote({
        modelId: SEEDED_TOOL_MODEL,
        entryPoint: "agent",
        searchKey: "2k",
        at: new Date(),
      }),
      quoter.quote({
        modelId: SEEDED_TOOL_MODEL,
        entryPoint: "canvas_generator",
        searchKey: "2k",
        at: new Date(),
      }),
    ]);

    if (!viaAgent.ok || !viaCanvas.ok) throw new Error("expected both quotes to resolve");
    expect(viaAgent.detail.total_price).toBe(6);
    expect(viaCanvas.detail.total_price).toBe(4);
    expect(viaAgent.ruleId).not.toBe(viaCanvas.ruleId);
  });
});

describe("price quoter: 种子与未登记（BL-14 第 2 条 / GN-07 fail closed）", () => {
  it("case 4: 种子图片模型用 hd 询价是待定价、total_price 0，不是错误", async () => {
    // 前提：这个模型确实在种子里（否则下面的断言会因为「未登记」而通过）。
    expect(Object.keys(IMAGE_MODEL_CATALOG)).toContain(SEEDED_IMAGE_MODEL);
    expect(await repository.hasModel({ modelId: SEEDED_IMAGE_MODEL })).toBe(true);

    const outcome = await quoter.quote({
      modelId: SEEDED_IMAGE_MODEL,
      entryPoint: "canvas_generator",
      searchKey: "hd",
      at: new Date(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`expected a quote, got ${outcome.code}`);

    expect(outcome.detail.price_status).toBe("pending");
    expect(outcome.detail.total_price).toBe(0);
    expect(outcome.detail.base_price).toBe(0);
    expect(outcome.detail.unit_price).toBe(0);
    // 档位是配上了的（种子里有 hd 行），只是价格还没填。
    expect(outcome.detail.search_key_matched).toBe("hd");
  });

  it("case 5: 伪造的 model id 直接 model_not_available，且候选为空", async () => {
    expect(await repository.hasModel({ modelId: FORGED_MODEL })).toBe(false);
    expect(await repository.listCandidateRules({ modelId: FORGED_MODEL, at: new Date() })).toEqual(
      [],
    );

    const outcome = await quoter.quote({
      modelId: FORGED_MODEL,
      entryPoint: "agent",
      searchKey: "hd",
      at: new Date(),
    });

    expect(outcome).toEqual({ ok: false, code: "model_not_available" });
  });

  it("case 6: 工具默认行（档位没配上）报 unknown / null，价格仍是待定价", async () => {
    const outcome = await quoter.quote({
      modelId: SEEDED_TOOL_MODEL,
      entryPoint: "agent",
      searchKey: "16k",
      at: new Date(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`expected a quote, got ${outcome.code}`);

    // GN-01 验收 2：命中默认行时报 unknown，`search_key_matched` 为 null。
    expect(outcome.detail.search_key).toBe("unknown");
    expect(outcome.detail.search_key_matched).toBeNull();
    expect(outcome.detail.price_status).toBe("pending");
    expect(outcome.detail.total_price).toBe(0);
  });
});
