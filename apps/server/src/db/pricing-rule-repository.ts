import {
  entryPointSchema,
  priceStatusSchema,
  timePeriodSchema,
} from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";
import type { PricingRuleCandidate } from "../features/pricing/resolve-price.js";

/**
 * BL-14 / GN-07 — 价目表读仓储（工单 31A · T4）。
 *
 * 两张表（`pricing_rules` / `price_change_log`）只给服务端 pg repository 访问：
 * 不建 RLS、不引用 `auth.uid()` / `auth.users`（工单 31A 裁决 7），所以这里读得
 * 极窄 —— 只有两个方法、两条固定 SQL，没有 access token、没有表名参数、
 * 没有列清单可以让调用方把读法放宽。
 *
 * 为什么仓储只做「读候选」而不是「读一条」：GN-07 的匹配是**优先级**问题，
 * 不是等值查询问题（同一组合下还要比 `effective_at` 新旧、还要按通配回退）。
 * 把 SQL 压成「一条规则」会把这两层逻辑塞进 SQL 里，测试只能靠 PGlite；
 * 反之，SQL 只负责「此刻生效的每组最新一条」，选哪一条交给纯函数
 * `features/pricing/resolve-price.ts`，那边可以逐级验证。
 *
 * 两条 SQL 都是固定文本，参数一律 bind（`$1::text`、`$2::timestamptz`）：模型 id 是
 * 用户可控的值，拼进 SQL 就是把价目表读法交给调用方。
 *
 * 本单**不做**改价写入（AD-07 的事），也不接扣费路径。
 */

export type PricingRuleRepository = {
  /**
   * `modelId` 在 `at` 时刻可见的规则：只取 `effective_at <= at` 的行，
   * 且每个 `(entry_point, search_key, time_period)` 组合只留 `effective_at` 最新的一条。
   *
   * 未登记的模型回空数组，**不是**错误（「没有规则」和「读失败」必须能区分）。
   */
  listCandidateRules(input: {
    modelId: string;
    at: Date;
  }): Promise<PricingRuleCandidate[]>;

  /**
   * `modelId` 是否登记过 —— 即是否存在**任何**规则，不限生效时间。
   *
   * GN-07 把「未登记的模型 id」与「登记了但档位没配上」分开处理：
   * 前者一律拒绝（`model_not_available`），后者走默认行。这个谓词是那条分界线。
   */
  hasModel(input: { modelId: string }): Promise<boolean>;
};

export const LIST_CANDIDATE_RULES = "listCandidateRules";
export const HAS_MODEL = "hasModel";

export type PricingRuleRepositoryOperation =
  | typeof LIST_CANDIDATE_RULES
  | typeof HAS_MODEL;

/**
 * 失败形态。消息只由固定操作名拼出来：驱动错误里可能带着整条 SQL、主机名或
 * 连接串，不能顺着 message 漏进日志或 HTTP body。原错误挂在 `cause` 上，
 * 调用方仍能分类，但驱动原文不会被本模块转述出去。
 */
export class PricingRuleRepositoryError extends Error {
  readonly operation: PricingRuleRepositoryOperation;

  constructor(operation: PricingRuleRepositoryOperation, cause: unknown) {
    super(
      `pricing rule read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "PricingRuleRepositoryError";
    this.operation = operation;
  }
}

/**
 * 「此刻可见的候选规则」。
 *
 * `distinct on (entry_point, search_key, time_period)` + `order by ... effective_at desc`
 * 是「每组最新一条」的标准写法：DISTINCT ON 的表达式必须与 ORDER BY 的最左前缀一致，
 * 而 `effective_at desc` 决定每组里留下哪一行 —— 于是定时生效（BL-14 验收 5）
 * 不需要调度器：`at` 往前一拨，同一组合自然换成新价。
 *
 * 结果**完全确定**：`unique (model_id, entry_point, search_key, time_period, effective_at)`
 * 保证「同一组合 + 同一生效时间」最多一行，所以「最新」不会平手。
 *
 * `extras` 一起读出来（GN-28 一期恒为 `[]`），这样将来加附加项不用再改 SQL。
 */
const LIST_CANDIDATE_RULES_SQL = `
select distinct on (r.entry_point, r.search_key, r.time_period)
       r.id,
       r.model_id,
       r.entry_point,
       r.search_key,
       r.time_period,
       r.unit_name,
       r.unit_size,
       r.price,
       r.price_status,
       r.effective_at,
       r.extras
  from public.pricing_rules r
 where r.model_id = $1::text
   and r.effective_at <= $2::timestamptz
 order by r.entry_point,
          r.search_key,
          r.time_period,
          r.effective_at desc
`;

/**
 * 「这个 id 登记过没有」。
 *
 * 刻意**不带** `effective_at` 条件：一条规则写在未来生效，也说明这个模型是登记的；
 * 把它当成「未登记」会让一个已经配好定时改价的模型在今天直接不可用。
 */
const HAS_MODEL_SQL = `
select exists (
         select 1
           from public.pricing_rules r
          where r.model_id = $1::text
       ) as present
`;

/**
 * 构建 PostgreSQL 实现。pool 走 getter，构造仓储本身不读 `DATABASE_URL`、
 * 不连接、也不会在装配期失败；没有 pool 只会在真正读的时候变成
 * `PricingRuleRepositoryError`。
 */
export function createPricingRuleRepository(options: {
  getTransactionPool: () => TransactionPool;
}): PricingRuleRepository {
  return {
    async listCandidateRules(input) {
      // 参数先校验：坏参数不该开连接，也不该被报成数据库失败。
      const modelId = requireReadArgument(LIST_CANDIDATE_RULES, input.modelId, "modelId");
      const at = requireReadDate(LIST_CANDIDATE_RULES, input.at, "at");

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(pool, null, async (client) => {
          const result = await client.query(LIST_CANDIDATE_RULES_SQL, [
            modelId,
            at.toISOString(),
          ]);

          // 零行是合法答案（未登记 / 该时刻前没有任何规则生效），不是错误。
          return result.rows.map(mapCandidate);
        });
      } catch (error) {
        throw new PricingRuleRepositoryError(LIST_CANDIDATE_RULES, error);
      }
    },

    async hasModel(input) {
      const modelId = requireReadArgument(HAS_MODEL, input.modelId, "modelId");

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(pool, null, async (client) => {
          const result = await client.query(HAS_MODEL_SQL, [modelId]);

          // `select exists (...)` 永远恰好一行一列；零行/多行说明语句和映射器不一致，
          // 不是「没有这个模型」。
          if (result.rows.length !== 1) {
            throw new Error("pricing rule read returned no single \"present\" row");
          }

          return requireBoolean(asRow(result.rows[0])["present"], "present");
        });
      } catch (error) {
        throw new PricingRuleRepositoryError(HAS_MODEL, error);
      }
    },
  };
}

/**
 * 一行 → 一条候选规则。
 *
 * 价格状态用**判别联合**表达迁移里的 CHECK（`pending` 无价、`active` 有非负整数价）：
 * 一行「pending 却带着价格」或「active 却没有价格」是数据漂移，在这里就失败，
 * 而不是被 `?? 0` 洗成一条看起来免费的规则。
 */
function mapCandidate(row: unknown): PricingRuleCandidate {
  const record = asRow(row);

  const base = {
    id: requireString(record, "id"),
    modelId: requireString(record, "model_id"),
    entryPoint: requireEntryPoint(record),
    searchKey: requireString(record, "search_key"),
    timePeriod: requireTimePeriod(record),
    unitName: requireString(record, "unit_name"),
    unitSize: requireNullablePositiveInteger(record, "unit_size"),
    effectiveAt: requireTimestamp(record, "effective_at"),
    extras: requireExtras(record),
  };

  if (requirePriceStatus(record) === "pending") {
    if (record["price"] !== null) {
      throw new Error('pricing rule read returned a "pending" rule that carries a price');
    }

    return { ...base, priceStatus: "pending", price: null };
  }

  return {
    ...base,
    priceStatus: "active",
    price: requireNonNegativeInteger(record, "price"),
  };
}

function asRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pricing rule read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/**
 * 绑定值必须是真字符串。uuid / 时间的**形状**不在这里预检：
 * 非法值会作为 bind 参数交给 PostgreSQL 自己拒绝（SQLSTATE 22P02），
 * 事务回滚、连接仍可用，这条路径也才能被测到。
 */
function requireReadArgument(
  operation: PricingRuleRepositoryOperation,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PricingRuleRepositoryError(
      operation,
      new Error(`pricing rule read needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * `at` 是 Date（不是「能转成 Date 的东西」）：调用方算错了时间点，应当在调用点
 * 就失败，而不是在这里被 `new Date(undefined)` 悄悄变成 1970。
 */
function requireReadDate(
  operation: PricingRuleRepositoryOperation,
  value: unknown,
  field: string,
): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PricingRuleRepositoryError(
      operation,
      new Error(`pricing rule read needs a valid "${field}" Date`),
    );
  }

  return value;
}

function requireString(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`pricing rule read returned no usable "${field}"`);
  }

  return value;
}

/**
 * 枚举列一律按 `@loomic/shared` 的契约校验：迁移的 CHECK 与 schema 是同一份取值，
 * 中间再多一份手写列表就会两边漂移。
 */
function requireEntryPoint(row: Readonly<Record<string, unknown>>) {
  const parsed = entryPointSchema.safeParse(row["entry_point"]);

  if (!parsed.success) {
    throw new Error("pricing rule read returned an unusable \"entry_point\"");
  }

  return parsed.data;
}

function requireTimePeriod(row: Readonly<Record<string, unknown>>) {
  const parsed = timePeriodSchema.safeParse(row["time_period"]);

  if (!parsed.success) {
    throw new Error("pricing rule read returned an unusable \"time_period\"");
  }

  return parsed.data;
}

function requirePriceStatus(row: Readonly<Record<string, unknown>>) {
  const parsed = priceStatusSchema.safeParse(row["price_status"]);

  if (!parsed.success) {
    throw new Error("pricing rule read returned an unusable \"price_status\"");
  }

  return parsed.data;
}

/** `active` 行的价格：必须是非负整数积分（AD-07）。小数、字符串、负数都是漂移。 */
function requireNonNegativeInteger(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = row[field];

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`pricing rule read returned no usable "${field}"`);
  }

  return value;
}

/** `unit_size` 可空；有值时必须是正整数（迁移里 `check (unit_size is null or unit_size > 0)`）。 */
function requireNullablePositiveInteger(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number | null {
  const value = row[field];

  if (value === null) return null;

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`pricing rule read returned no usable "${field}"`);
  }

  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`pricing rule read returned no usable "${field}"`);
  }

  return value;
}

/**
 * `extras`（GN-28）：`jsonb` 列，必须是一个数组，且每一项都是对象 ——
 * 它将来会原样进 `price_detail.extras`，所以这里只放行能过契约的形状。
 */
function requireExtras(
  row: Readonly<Record<string, unknown>>,
): readonly Record<string, unknown>[] {
  const value = row["extras"];

  if (!Array.isArray(value)) {
    throw new Error('pricing rule read returned no usable "extras"');
  }

  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error('pricing rule read returned an unusable "extras" entry');
    }

    return entry as Record<string, unknown>;
  });
}

/** ISO-8601 with an explicit offset: the shape this module publishes. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `timestamptz` 在 `pg` 与 PGlite 里都是 `Date`。两者都接受并归一到 `toISOString()`，
 * 其余一律失败 —— 一个 null / 乱七八糟的时间戳会让「此刻生效」这件事无从判断。
 *
 * 私有副本，沿用 `db/brand-kit-read-repository.ts` 立的规矩：跨仓储 import 会
 * 把两个互不相关的模块绑在一起。
 */
function requireTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`pricing rule read returned an unusable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`pricing rule read returned no usable "${field}"`);
}
