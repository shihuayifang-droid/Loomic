import { describe, expect, it } from "vitest";

import {
  HAS_MODEL,
  LIST_CANDIDATE_RULES,
  PricingRuleRepositoryError,
  createPricingRuleRepository,
} from "./pricing-rule-repository.js";
import {
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * 价目表读仓储（工单 31A · T5）—— 记录型 fake，没有数据库、没有 `DATABASE_URL`。
 *
 * 这里要钉住的是**仓储自己发出的那一条 SQL**：只有一条、参数是 bind、模型 id
 * 只出现在参数里、`effective_at` 由 SQL 的 `distinct on` + `order by` 决定「每组最新一条」。
 * 至于 PostgreSQL 真的能跑、种子行数、CHECK 约束、定时生效，在隔壁
 * `test-support/db/pricing-rule-repository-db.test.ts`（PGlite）里量。
 *
 * 语句序列的断言**只数领域语句**（含 `public.` 的那条），不数 `set_config` / 事务
 * 语句的条数：那是 `db/transaction.ts` 的实现细节，已经变过一次（四次 `set_config`
 * 合并成一次），将来还会变。case 7 用「多塞几条非领域语句」把这件事写成断言。
 */

const MODEL_ID = "kwjm/gpt-image-2";
const OTHER_MODEL_ID = "google/nano-banana";
const RULE_ID = "00000000-0000-0000-0000-0000000000b1";
/** 一个固定时刻：定时生效的用例必须显式给 `at`，不能靠 `now()`。 */
const AT = new Date("2026-10-19T06:00:00.000Z");

type QueryRecord = { sql: string; params?: readonly unknown[] };

type Harness = {
  pool: TransactionPool;
  queries: QueryRecord[];
  connectAttempts: () => number;
};

/**
 * 一个连接，记录每条语句，领域语句由 `respond` 回答。
 *
 * `helperStatements` 模拟「事务助手多发了几条非领域语句」：用来证明仓储的
 * 断言不依赖那些语句的条数。
 */
function createHarness(
  respond: (sql: string) => unknown[] | Promise<unknown[]>,
  options: { connectError?: Error; helperStatements?: number } = {},
): Harness {
  const queries: QueryRecord[] = [];
  let connectAttempts = 0;

  const connection: TransactionConnection = {
    async query(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, ...(params === undefined ? {} : { params }) });

      if (
        sql === TRANSACTION_STATEMENTS.begin ||
        sql === TRANSACTION_STATEMENTS.commit ||
        sql === TRANSACTION_STATEMENTS.rollback ||
        sql === TRANSACTION_STATEMENTS.setLocalSetting
      ) {
        return { rows: [] };
      }

      return { rows: await respond(sql) };
    },
    release() {},
  };

  return {
    pool: {
      async connect() {
        connectAttempts += 1;
        if (options.connectError) throw options.connectError;

        // 额外的「事务助手」语句：名字里不含 `public.`，所以不算领域语句。
        for (let index = 0; index < (options.helperStatements ?? 0); index += 1) {
          await connection.query("select set_config($1, $2, true)", ["app.x", "y"]);
        }

        return connection;
      },
    },
    queries,
    connectAttempts: () => connectAttempts,
  };
}

/** 仓储自己的领域语句：`public.` 是唯一可靠的分界。 */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public."));
}

function statements(queries: readonly QueryRecord[]): string[] {
  return queries.map((entry) => entry.sql);
}

function repositoryFor(harness: Harness) {
  return createPricingRuleRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** 一行合法的 `pricing_rules`：默认是「active / 未定价」之外的 pending 行。 */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RULE_ID,
    model_id: MODEL_ID,
    entry_point: "agent",
    search_key: "2k",
    time_period: "normal",
    unit_name: "次",
    unit_size: null,
    price: null,
    price_status: "pending",
    effective_at: AT,
    extras: [],
    ...overrides,
  };
}

const ACTIVE_ROW = row({ price: 6, price_status: "active" });

function listCandidates(repository: ReturnType<typeof repositoryFor>) {
  return repository.listCandidateRules({ modelId: MODEL_ID, at: AT });
}

describe("pricing-rule-repository: listCandidateRules 的语句", () => {
  it("case 1: 一个事务、恰好一条领域语句、一次连接", async () => {
    const harness = createHarness(() => [ACTIVE_ROW]);

    await listCandidates(repositoryFor(harness));

    const issued = statements(harness.queries);
    expect(issued[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(issued.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    // 一条领域语句：没有回读、没有逐组合补查、也没有第二次「这个模型登记过吗」。
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 2: 模型 id 与时刻都是 bind 参数，SQL 里不出现它们的值", async () => {
    const harness = createHarness(() => [ACTIVE_ROW]);

    await listCandidates(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([MODEL_ID, AT.toISOString()]);
    expect(statement?.sql).toContain("$1::text");
    expect(statement?.sql).toContain("$2::timestamptz");
    expect(statement?.sql).not.toContain(MODEL_ID);
    expect(statement?.sql).not.toContain(AT.toISOString());
    expect(statement?.sql).not.toContain("${");
  });

  it("case 3: 每组只留最新一条 —— distinct on 三个维度 + effective_at 降序 + 只看已生效", async () => {
    const harness = createHarness(() => [ACTIVE_ROW]);

    await listCandidates(repositoryFor(harness));

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";

    // 「同一个 (entry_point, search_key, time_period) 组合里 effective_at 最新的那一条」
    // 是 SQL 的责任：DISTINCT ON 的表达式必须与 ORDER BY 的最左前缀一致，
    // 最后一列 `effective_at desc` 决定每组里留下谁。
    expect(sql).toContain("distinct on (r.entry_point, r.search_key, r.time_period)");
    expect(sql).toContain("order by r.entry_point,");
    expect(sql).toContain("r.effective_at desc");
    // 定时生效（BL-14 验收 5）：读的时候按 `effective_at <= at` 过滤，不需要调度器。
    expect(sql).toContain("r.effective_at <= $2::timestamptz");
    // 一条只读语句：不许出现写动词，也不许分号拼第二条。
    expect(sql).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b|\bupsert\b/i);
    expect(sql).not.toContain(";");
    // 只读两张表里的一张，且不碰改价历史。
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.pricing_rules"]);
  });

  it("case 4: 零行是合法答案 —— 空数组、事务照常提交", async () => {
    const harness = createHarness(() => []);

    await expect(listCandidates(repositoryFor(harness))).resolves.toEqual([]);
    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(statements(harness.queries)).not.toContain(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 5: 一行映射成候选规则 —— 时间归一成 ISO、价格状态收成判别联合", async () => {
    const harness = createHarness(() => [
      row({
        price: 12,
        price_status: "active",
        unit_name: "秒",
        unit_size: 5,
        extras: [{ id: "audio", amount: 3 }],
      }),
    ]);

    await expect(listCandidates(repositoryFor(harness))).resolves.toEqual([
      {
        id: RULE_ID,
        modelId: MODEL_ID,
        entryPoint: "agent",
        searchKey: "2k",
        timePeriod: "normal",
        unitName: "秒",
        unitSize: 5,
        effectiveAt: AT.toISOString(),
        extras: [{ id: "audio", amount: 3 }],
        priceStatus: "active",
        price: 12,
      },
    ]);
  });

  it("case 6: 行形态漂移一律失败并回滚 —— 含「pending 带价格」「active 没价格」", async () => {
    const answers: unknown[] = [
      // 不是对象 / 缺列 / 类型不对
      null,
      "not a row",
      [row()],
      row({ id: "" }),
      row({ model_id: 7 }),
      row({ search_key: null }),
      row({ unit_name: 3 }),
      // 枚举外
      row({ entry_point: "free_form" }),
      row({ time_period: "peak" }),
      row({ price_status: "quoted" }),
      // 数字形态
      row({ price: 1.5, price_status: "active" }),
      row({ price: "6", price_status: "active" }),
      row({ price: -1, price_status: "active" }),
      row({ price_status: "active" }),
      row({ price: 6 }),
      row({ unit_size: 0, price_status: "active", price: 1 }),
      row({ unit_size: 2.5, price_status: "active", price: 1 }),
      // extras 不是对象数组
      row({ extras: null }),
      row({ extras: {} }),
      row({ extras: ["nope"] }),
      // 时间不可用
      row({ effective_at: null }),
      row({ effective_at: "yesterday" }),
      row({ effective_at: new Date(Number.NaN) }),
    ];

    for (const answer of answers) {
      const harness = createHarness(() => [answer]);
      const error = await listCandidates(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(PricingRuleRepositoryError);
      expect((error as PricingRuleRepositoryError).operation).toBe(
        LIST_CANDIDATE_RULES,
      );
      expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });
});

describe("pricing-rule-repository: hasModel 的语句", () => {
  it("case 7: 认登记只问「有没有任何规则」，不看生效时间", async () => {
    const harness = createHarness(() => [{ present: true }]);

    await expect(
      repositoryFor(harness).hasModel({ modelId: MODEL_ID }),
    ).resolves.toBe(true);

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(sql).toContain("select exists (");
    expect(sql).toContain("r.model_id = $1::text");
    // 一条写在未来生效的规则也说明「这个模型登记过」，所以这里没有时间条件。
    expect(sql).not.toContain("effective_at");
    expect(domainCalls(harness.queries)[0]?.params).toEqual([MODEL_ID]);
  });

  it("case 8: 没登记过就是 false；零行/多行是语句与映射器不一致，不是 false", async () => {
    const absent = createHarness(() => [{ present: false }]);
    await expect(
      repositoryFor(absent).hasModel({ modelId: OTHER_MODEL_ID }),
    ).resolves.toBe(false);

    for (const answer of [[], [{ present: true }, { present: false }], [{ present: "yes" }]]) {
      const harness = createHarness(() => answer);
      const error = await repositoryFor(harness)
        .hasModel({ modelId: MODEL_ID })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(PricingRuleRepositoryError);
      expect((error as PricingRuleRepositoryError).operation).toBe(HAS_MODEL);
      expect(statements(harness.queries).at(-1)).toBe(
        TRANSACTION_STATEMENTS.rollback,
      );
    }
  });
});

describe("pricing-rule-repository: 失败与参数", () => {
  it("case 9: SQL 失败回滚、保留 cause、消息不泄漏语句/表名/主机", async () => {
    const failure = new Error(
      "select distinct on (...) from public.pricing_rules failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await listCandidates(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(PricingRuleRepositoryError);
    const repositoryError = error as PricingRuleRepositoryError;
    expect(repositoryError.message).toBe(
      `pricing rule read failed (${LIST_CANDIDATE_RULES})`,
    );
    expect(repositoryError.cause).toBe(failure);
    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(repositoryError.message).not.toMatch(
      /pricing_rules|distinct|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
  });

  it("case 10: 连接失败是固定错误，且一条语句都不发", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await listCandidates(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(PricingRuleRepositoryError);
    expect((error as PricingRuleRepositoryError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 11: 坏参数在开连接之前就被拒绝，且记在正确的操作名下", async () => {
    const badModelIds: unknown[] = [undefined, null, "", 7, {}];

    for (const modelId of badModelIds) {
      const harness = createHarness(() => [ACTIVE_ROW]);
      const error = await repositoryFor(harness)
        .listCandidateRules({ modelId: modelId as string, at: AT })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(PricingRuleRepositoryError);
      expect((error as PricingRuleRepositoryError).operation).toBe(
        LIST_CANDIDATE_RULES,
      );
      expect(harness.connectAttempts()).toBe(0);

      const otherHarness = createHarness(() => [{ present: true }]);
      const otherError = await repositoryFor(otherHarness)
        .hasModel({ modelId: modelId as string })
        .catch((reason: unknown) => reason);

      expect(otherError).toBeInstanceOf(PricingRuleRepositoryError);
      expect((otherError as PricingRuleRepositoryError).operation).toBe(HAS_MODEL);
      expect(otherHarness.connectAttempts()).toBe(0);
    }

    // `at` 必须是有效 Date：`new Date(undefined)` 会静默变成 1970，
    // 那会让「此刻生效」这条判据整个失效。
    for (const at of [undefined, null, "2026-10-19", new Date(Number.NaN), 0]) {
      const harness = createHarness(() => [ACTIVE_ROW]);
      const error = await repositoryFor(harness)
        .listCandidateRules({ modelId: MODEL_ID, at: at as Date })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(PricingRuleRepositoryError);
      expect(harness.connectAttempts()).toBe(0);
    }
  });

  it("case 12: 语句序列的断言与事务助手发几条 set_config 无关", async () => {
    // 同一个仓储，两个「助手行为不同」的 harness：领域语句的条数与参数必须一致。
    const plain = createHarness(() => [ACTIVE_ROW]);
    const chatty = createHarness(() => [ACTIVE_ROW], { helperStatements: 3 });

    await listCandidates(repositoryFor(plain));
    await listCandidates(repositoryFor(chatty));

    expect(domainCalls(plain.queries)).toHaveLength(1);
    expect(domainCalls(chatty.queries)).toHaveLength(1);
    expect(domainCalls(chatty.queries)[0]?.params).toEqual(
      domainCalls(plain.queries)[0]?.params,
    );
    // 非领域语句的条数确实变了 —— 但上面两行没有因此变红。
    expect(chatty.queries.length).toBeGreaterThan(plain.queries.length);
  });

  it("case 13: 仓储只暴露两个方法", () => {
    const harness = createHarness(() => [ACTIVE_ROW]);
    const repository = repositoryFor(harness);

    expect(Object.keys(repository).sort()).toEqual([HAS_MODEL, LIST_CANDIDATE_RULES].sort());
    expect(repository.listCandidateRules).toHaveLength(1);
    expect(repository.hasModel).toHaveLength(1);
  });

  it("case 14: 构造仓储不解析 pool；缺 DATABASE_URL 只在读的时候失败", async () => {
    let resolutions = 0;
    const repository = createPricingRuleRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await listCandidates(repository).catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(PricingRuleRepositoryError);
    expect((error as PricingRuleRepositoryError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
  });
});
