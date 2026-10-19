import type { PGlite } from "@electric-sql/pglite";
import { IMAGE_MODEL_CATALOG, VIDEO_MODEL_CATALOG } from "@loomic/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPricingRuleRepository,
  type PricingRuleRepository,
} from "../../db/pricing-rule-repository.js";
import { resolvePriceFromCandidates } from "../../features/pricing/resolve-price.js";
import { TOOL_DEFINITIONS } from "../../features/tools/tool-definitions.js";
import type { TransactionPool } from "../../db/transaction.js";
import { createMigratedDb, createPGliteTransactionPool } from "./pglite-db.js";

/**
 * BL-14 价目表 / GN-07 计价规则的真 SQL 用例（工单 31A · T6）
 *
 * 这一文件量的是「表本身」与「仓储 + 纯函数合起来」在**真 PostgreSQL 解析器**
 * 下的行为：种子行数、CHECK 约束、定时生效、外键级联。PGlite 在进程内、无 socket、
 * 无 `DATABASE_URL`，`beforeAll` 迁移一次，`afterAll` 关掉。
 *
 * 行数口径来自 **catalog 实测**而不是工单正文：
 * - 工具 18 = 12 个 `consumes === true` 的工具默认行 + upscale(2k/4k/8k) + edit_text(1k/2k/4k)
 * - 图片 80 = `IMAGE_MODEL_CATALOG` 20 个模型 × (默认行 + standard/hd/ultra)
 * - 视频 25 = `VIDEO_MODEL_CATALOG` 25 个模型 × 1 行默认行
 *
 * ⚠️ 工单 31A §1 裁决 6 写的是「VIDEO 有 24 个 → 合计 122 行」，实测 catalog 是
 * **25 个**且 25 个都被 providers 引用。按工单自己的规则（每个模型一行默认行、
 * 模型 id 从 catalog 抄），种子必须覆盖 25 个，于是是 123 行。本文件因此按
 * **123** 断言、并把构成拆开写 —— 偏离与证据见 `02-回传\工单31A-回传.md`。
 *
 * 所有插入都落在 `test/` 前缀的模型 id 上，不去改种子行：种子行数在 `beforeAll`
 * 里就量好并留档，所以后面再插多少行都不会让「恰好 123 行」这条判据失效。
 */

const PRICING_MIGRATION = "20261019000001_hahart_pricing_rules.sql";

const IMAGE_MODEL_IDS = Object.keys(IMAGE_MODEL_CATALOG);
const VIDEO_MODEL_IDS = Object.keys(VIDEO_MODEL_CATALOG);

/** 21AB 工具表里所有计费工具（`consumes === true`）。 */
const BILLING_TOOLS = TOOL_DEFINITIONS.filter((tool) => tool.consumes);
/** 零消耗工具（调整 / 裁剪 / 翻转 / 下载 / Mockup）：BL-14 规定不进价目表。 */
const FREE_TOOLS = TOOL_DEFINITIONS.filter((tool) => !tool.consumes);

/** 图片模型沿用的三档（口径 2）+ 默认行。 */
const IMAGE_SEARCH_KEYS = ["*", "standard", "hd", "ultra"];

const TOOL_ROW_COUNT =
  BILLING_TOOLS.length +
  BILLING_TOOLS.reduce((total, tool) => total + (tool.pricing?.tiers.length ?? 0), 0);
const IMAGE_ROW_COUNT = IMAGE_MODEL_IDS.length * IMAGE_SEARCH_KEYS.length;
const VIDEO_ROW_COUNT = VIDEO_MODEL_IDS.length;
const SEEDED_ROW_COUNT = TOOL_ROW_COUNT + IMAGE_ROW_COUNT + VIDEO_ROW_COUNT;

const OPERATOR_ID = "00000000-0000-0000-0000-0000000000c1";

/** 定时生效用的固定时刻：PGlite 的 `now()` 在同一进程内不前进，所以必须显式给。 */
const FUTURE_AT = "2030-01-01T00:00:00.000Z";
const AFTER_FUTURE_AT = new Date("2030-01-02T00:00:00.000Z");

let db: PGlite;
let pool: TransactionPool;
let repository: PricingRuleRepository;

/** `beforeAll` 里量好的种子事实，供不依赖执行顺序的用例断言。 */
const seeded = {
  applied: [] as string[],
  total: 0,
  pending: 0,
  priced: 0,
  byKind: { tools: 0, images: 0, videos: 0 },
};

type CountRow = { n: number };

async function count(sql: string, params: readonly unknown[] = []): Promise<number> {
  const result = await db.query<CountRow>(sql, [...params]);
  const first = result.rows[0];

  if (first === undefined) throw new Error("count query returned no row");

  return first.n;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createPricingRuleRepository({ getTransactionPool: () => pool });

  seeded.applied = created.applied;
  seeded.total = await count("select count(*)::int as n from public.pricing_rules");
  seeded.pending = await count(
    "select count(*)::int as n from public.pricing_rules where price_status = 'pending'",
  );
  seeded.priced = await count(
    "select count(*)::int as n from public.pricing_rules where price is not null",
  );
  seeded.byKind.tools = await count(
    "select count(*)::int as n from public.pricing_rules where model_id like 'tool:%'",
  );
  seeded.byKind.images = await count(
    "select count(*)::int as n from public.pricing_rules where model_id in (select unnest($1::text[]))",
    [IMAGE_MODEL_IDS],
  );
  seeded.byKind.videos = await count(
    "select count(*)::int as n from public.pricing_rules where model_id in (select unnest($1::text[]))",
    [VIDEO_MODEL_IDS],
  );
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("pricing rules: 迁移与种子数据", () => {
  it("case 1: 迁移被加载，两张表都在 public schema 里", async () => {
    expect(seeded.applied).toContain(PRICING_MIGRATION);

    const tables = await db.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name in ('pricing_rules', 'price_change_log')
        order by table_name`,
    );

    expect(tables.rows.map((entry) => entry.table_name)).toEqual([
      "price_change_log",
      "pricing_rules",
    ]);
  });

  it("case 2: 种子行数 = 18 工具 + 80 图片 + 25 视频，全部 pending 且价格为空", () => {
    // 三项独立之和，别把总数当成唯一判据：某一类多一行、另一类少一行时总和也能对上。
    expect(TOOL_ROW_COUNT).toBe(18);
    expect(IMAGE_ROW_COUNT).toBe(80);
    expect(VIDEO_ROW_COUNT).toBe(25);
    expect(SEEDED_ROW_COUNT).toBe(123);

    expect(seeded.byKind.tools).toBe(TOOL_ROW_COUNT);
    expect(seeded.byKind.images).toBe(IMAGE_ROW_COUNT);
    expect(seeded.byKind.videos).toBe(VIDEO_ROW_COUNT);
    expect(seeded.total).toBe(SEEDED_ROW_COUNT);

    // BL-14 第 2 条：一期只建行、不填价。
    expect(seeded.pending).toBe(SEEDED_ROW_COUNT);
    expect(seeded.priced).toBe(0);
  });

  it("case 3: 工具行与 21AB 的计费 generator 集合一致，零消耗工具没有行", async () => {
    const rows = await db.query<{ model_id: string }>(
      "select model_id from public.pricing_rules where model_id like 'tool:%' group by model_id order by model_id",
    );
    const seededTools = rows.rows.map((entry) => entry.model_id);

    const fromGenerators = BILLING_TOOLS.map((tool) => `tool:${tool.pricing?.generator ?? ""}`);
    // 工具价按工具定价（口径 1）：generator 与工具 id 在这 12 个工具上一致，
    // 两边都断一次，将来二者分叉时能立刻看到是哪一边变了。
    const fromIds = BILLING_TOOLS.map((tool) => `tool:${tool.id}`);

    expect([...seededTools].sort()).toEqual([...fromGenerators].sort());
    expect([...seededTools].sort()).toEqual([...fromIds].sort());

    const freeIds = FREE_TOOLS.map((tool) => `tool:${tool.id}`);
    expect(freeIds.length).toBeGreaterThan(0);
    expect(
      await count("select count(*)::int as n from public.pricing_rules where model_id = any($1::text[])", [
        freeIds,
      ]),
    ).toBe(0);
    // 具体到 BL-14 点名的四个零消耗操作。
    expect(
      await count(
        "select count(*)::int as n from public.pricing_rules where model_id in ('tool:adjust','tool:crop','tool:flip_rotate','tool:download')",
      ),
    ).toBe(0);
  });

  it("case 4: 工具档位行就是工具定义里的 tiers（upscale 2k/4k/8k、edit_text 1k/2k/4k）", async () => {
    for (const tool of BILLING_TOOLS) {
      const rows = await db.query<{ search_key: string }>(
        "select search_key from public.pricing_rules where model_id = $1 order by search_key",
        [`tool:${tool.id}`],
      );
      const expected = ["*", ...(tool.pricing?.tiers ?? [])].sort();

      expect(rows.rows.map((entry) => entry.search_key).sort(), `tool:${tool.id}`).toEqual(
        expected,
      );
    }
  });

  it("case 5: 图片每个模型四行（默认行 + 三档）、视频每个模型一行且单位是秒", async () => {
    expect(
      await count(
        "select count(*)::int as n from public.pricing_rules where model_id = any($1::text[]) and search_key = any($2::text[])",
        [IMAGE_MODEL_IDS, IMAGE_SEARCH_KEYS],
      ),
    ).toBe(IMAGE_ROW_COUNT);

    for (const modelId of IMAGE_MODEL_IDS) {
      expect(
        await count("select count(*)::int as n from public.pricing_rules where model_id = $1", [
          modelId,
        ]),
        modelId,
      ).toBe(IMAGE_SEARCH_KEYS.length);
    }

    for (const modelId of VIDEO_MODEL_IDS) {
      const rows = await db.query<{ search_key: string; unit_name: string; unit_size: number | null }>(
        "select search_key, unit_name, unit_size from public.pricing_rules where model_id = $1",
        [modelId],
      );

      // 视频只建默认行；GN-08 的秒数单位还没定，`unit_size` 一期留空。
      expect(rows.rows, modelId).toEqual([
        { search_key: "*", unit_name: "秒", unit_size: null },
      ]);
    }

    // 图片与工具的单位是「次」。
    expect(
      await count(
        "select count(*)::int as n from public.pricing_rules where unit_name <> '秒' and model_id = any($1::text[])",
        [IMAGE_MODEL_IDS],
      ),
    ).toBe(IMAGE_ROW_COUNT);
  });

  it("case 6: 每一行都是 entry_point='*'、time_period='normal'、extras=[]", async () => {
    expect(
      await count(
        "select count(*)::int as n from public.pricing_rules where entry_point <> '*'",
      ),
    ).toBe(0);
    expect(
      await count(
        "select count(*)::int as n from public.pricing_rules where time_period <> 'normal'",
      ),
    ).toBe(0);
    expect(
      await count(
        "select count(*)::int as n from public.pricing_rules where extras <> '[]'::jsonb",
      ),
    ).toBe(0);
  });
});

describe("pricing rules: CHECK 约束（BL-14 / 口径 5）", () => {
  it("case 7: active 必须带非负整数价、pending 必须没有价 —— 四种违规都被拒绝", async () => {
    const insert = (modelId: string, values: string) =>
      db.query(
        `insert into public.pricing_rules (model_id, entry_point, search_key, time_period, price, price_status)
         values ('${modelId}', ${values})`,
      );

    // active 但没有价格
    await expect(insert("test/check-active-null", "'*', '*', 'normal', null, 'active'")).rejects.toThrow();
    // pending 却带着价格
    await expect(insert("test/check-pending-priced", "'*', '*', 'normal', 5, 'pending'")).rejects.toThrow();
    // 负价
    await expect(insert("test/check-negative", "'*', '*', 'normal', -1, 'active'")).rejects.toThrow();
    // 非法 entry_point
    await expect(insert("test/check-entry-point", "'free_form', '*', 'normal', null, 'pending'")).rejects.toThrow();
    // 非法 time_period
    await expect(insert("test/check-time-period", "'*', '*', 'peak', null, 'pending'")).rejects.toThrow();
    // 非法 price_status
    await expect(insert("test/check-status", "'*', '*', 'normal', null, 'quoted'")).rejects.toThrow();
    // unit_size 必须是正数
    await expect(
      db.query(
        `insert into public.pricing_rules (model_id, entry_point, search_key, unit_name, unit_size, price_status)
         values ('test/check-unit-size', '*', '*', '秒', 0, 'pending')`,
      ),
    ).rejects.toThrow();

    // 一行都没落库。
    expect(
      await count("select count(*)::int as n from public.pricing_rules where model_id like 'test/check-%'"),
    ).toBe(0);
  });

  it("case 8: active 且价 0 是合法的 —— 「已定价的免费项」与待定价不是同一件事", async () => {
    await db.query(
      `insert into public.pricing_rules (model_id, entry_point, search_key, price, price_status)
       values ('test/free-active', '*', '*', 0, 'active')`,
    );

    expect(
      await count("select count(*)::int as n from public.pricing_rules where model_id = 'test/free-active'"),
    ).toBe(1);
  });
});

describe("pricing rules: 定时生效（BL-14 验收 5）", () => {
  const FUTURE_MODEL = "test/future-price";

  it("case 9: 今天读仍是 pending 行；过了生效时间读才是新价", async () => {
    // 现在生效的 pending 默认行
    await db.query(
      `insert into public.pricing_rules (model_id, entry_point, search_key, price, price_status)
       values ($1, '*', '*', null, 'pending')`,
      [FUTURE_MODEL],
    );
    // 明天（2030 年）才生效的 active 价
    await db.query(
      `insert into public.pricing_rules (model_id, entry_point, search_key, price, price_status, effective_at)
       values ($1, '*', '*', $2, 'active', $3::timestamptz)`,
      [FUTURE_MODEL, 7, FUTURE_AT],
    );

    const now = new Date();
    const beforeActivation = await repository.listCandidateRules({
      modelId: FUTURE_MODEL,
      at: now,
    });
    const afterActivation = await repository.listCandidateRules({
      modelId: FUTURE_MODEL,
      at: AFTER_FUTURE_AT,
    });

    // 每个 (entry_point, search_key, time_period) 组合只有一行：新价生效后不是两行并存。
    expect(beforeActivation).toHaveLength(1);
    expect(afterActivation).toHaveLength(1);

    const quotedNow = resolvePriceFromCandidates(
      { modelId: FUTURE_MODEL, entryPoint: "agent", searchKey: "*" },
      beforeActivation,
      true,
    );
    const quotedLater = resolvePriceFromCandidates(
      { modelId: FUTURE_MODEL, entryPoint: "agent", searchKey: "*" },
      afterActivation,
      true,
    );

    expect(quotedNow.ok).toBe(true);
    expect(quotedLater.ok).toBe(true);
    if (!quotedNow.ok || !quotedLater.ok) throw new Error("expected both quotes to resolve");

    expect(quotedNow.detail.price_status).toBe("pending");
    expect(quotedNow.detail.total_price).toBe(0);
    expect(quotedLater.detail.price_status).toBe("active");
    expect(quotedLater.detail.total_price).toBe(7);
  });
});

describe("pricing rules: 仓储 + 纯函数端到端", () => {
  it("case 10: kwjm/gpt-image-2 + hd 返回待定价、total 0、档位命中", async () => {
    const candidates = await repository.listCandidateRules({
      modelId: "kwjm/gpt-image-2",
      at: new Date(),
    });

    expect(await repository.hasModel({ modelId: "kwjm/gpt-image-2" })).toBe(true);
    // 20 个图片模型里的这一个：默认行 + 三档 = 4 条候选。
    expect(candidates).toHaveLength(4);

    const outcome = resolvePriceFromCandidates(
      { modelId: "kwjm/gpt-image-2", entryPoint: "agent", searchKey: "hd" },
      candidates,
      true,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`expected a quote, got ${outcome.code}`);

    expect(outcome.detail.price_status).toBe("pending");
    expect(outcome.detail.total_price).toBe(0);
    expect(outcome.detail.unit_price).toBe(0);
    expect(outcome.detail.base_price).toBe(0);
    expect(outcome.detail.unit_count).toBe(1);
    expect(outcome.detail.unit_name).toBe("次");
    expect(outcome.detail.search_key).toBe("hd");
    expect(outcome.detail.search_key_matched).toBe("hd");
  });

  it("case 11: 伪造的 model 一律 model_not_available，且候选为空", async () => {
    const forged = "forged/not-a-real-model";

    expect(await repository.hasModel({ modelId: forged })).toBe(false);
    expect(await repository.listCandidateRules({ modelId: forged, at: new Date() })).toEqual([]);

    const outcome = resolvePriceFromCandidates(
      { modelId: forged, entryPoint: "agent", searchKey: "hd" },
      [],
      false,
    );

    expect(outcome).toEqual({ ok: false, code: "model_not_available" });
  });

  it("case 12: 工具行按档位命中，未配置的档位回落到默认行并报 unknown", async () => {
    const candidates = await repository.listCandidateRules({
      modelId: "tool:upscale",
      at: new Date(),
    });

    expect(candidates).toHaveLength(4);

    const tier = resolvePriceFromCandidates(
      { modelId: "tool:upscale", entryPoint: "tool", searchKey: "8k" },
      candidates,
      true,
    );
    const fallback = resolvePriceFromCandidates(
      { modelId: "tool:upscale", entryPoint: "tool", searchKey: "16k" },
      candidates,
      true,
    );

    expect(tier.ok).toBe(true);
    expect(fallback.ok).toBe(true);
    if (!tier.ok || !fallback.ok) throw new Error("expected both tool quotes to resolve");

    expect(tier.detail.search_key).toBe("8k");
    expect(tier.detail.search_key_matched).toBe("8k");
    // GN-01 验收 2：配不上的档位不是错误，走默认行并如实报 unknown。
    expect(fallback.detail.search_key).toBe("unknown");
    expect(fallback.detail.search_key_matched).toBeNull();
    expect(fallback.detail.price_status).toBe("pending");
  });

  it("case 13: 视频默认行的单位是「秒」", async () => {
    const candidates = await repository.listCandidateRules({
      modelId: "openai/sora-2",
      at: new Date(),
    });

    expect(candidates).toHaveLength(1);

    const outcome = resolvePriceFromCandidates(
      { modelId: "openai/sora-2", entryPoint: "agent_generator", searchKey: "default" },
      candidates,
      true,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`expected a quote, got ${outcome.code}`);

    expect(outcome.detail.unit_name).toBe("秒");
    expect(outcome.detail.price_status).toBe("pending");
    expect(outcome.detail.search_key_matched).toBeNull();
  });
});

describe("pricing rules: 改价历史表", () => {
  it("case 14: reason 空串被拒绝，operator_id 不加外键（任意 uuid 都能落库）", async () => {
    const inserted = await db.query<{ id: string }>(
      `insert into public.pricing_rules (model_id, entry_point, search_key, price, price_status)
       values ('test/change-log', '*', '*', 3, 'active')
       returning id`,
    );
    const ruleId = inserted.rows[0]?.id;
    if (ruleId === undefined) throw new Error("rule insert returned no id");

    const logSql = `
      insert into public.price_change_log
        (rule_id, operator_id, old_price, new_price, old_status, new_status, effective_at, reason)
      values ($1, $2, null, 3, 'pending', 'active', now(), $3)
    `;

    await expect(db.query(logSql, [ruleId, OPERATOR_ID, ""])).rejects.toThrow();
    // 空串被拒之后，一条正常的历史仍然能写。
    await db.query(logSql, [ruleId, OPERATOR_ID, "首次定价"]);

    expect(
      await count("select count(*)::int as n from public.price_change_log where rule_id = $1", [
        ruleId,
      ]),
    ).toBe(1);
  });

  it("case 15: 规则被删时历史跟着级联删除", async () => {
    const inserted = await db.query<{ id: string }>(
      `insert into public.pricing_rules (model_id, entry_point, search_key, price, price_status)
       values ('test/change-log-cascade', '*', '*', 4, 'active')
       returning id`,
    );
    const ruleId = inserted.rows[0]?.id;
    if (ruleId === undefined) throw new Error("rule insert returned no id");

    await db.query(
      `insert into public.price_change_log
         (rule_id, operator_id, old_price, new_price, old_status, new_status, effective_at, reason)
       values ($1, $2, null, 4, 'pending', 'active', now(), '级联用例')`,
      [ruleId, OPERATOR_ID],
    );

    await db.query("delete from public.pricing_rules where id = $1", [ruleId]);

    expect(
      await count("select count(*)::int as n from public.price_change_log where rule_id = $1", [
        ruleId,
      ]),
    ).toBe(0);
  });
});
