import type {
  EntryPoint,
  PriceDetail,
  PriceExtra,
  TimePeriod,
} from "@loomic/shared";

/**
 * GN-07 — 计价规则匹配与兜底（工单 31A · T7）。
 *
 * 纯函数：**不读数据库、不发请求、不看时间**。调用方先用
 * `PricingRuleRepository.listCandidateRules({ modelId, at })` 把「此刻可见的候选规则」
 * 取出来，再连同「这个模型是否登记过」一起交给这里，由它按 GN-07 的优先级
 * 选一条并组装 `price_detail`（GN-01 契约，`@loomic/shared` 的 `priceDetailSchema`）。
 *
 * 为什么要拆成两步：`at` 决定「哪些规则此刻生效」（BL-14 验收 5 定时生效），
 * 那是 SQL 的事（`effective_at <= at` + 每组取最新一条）；而「同样的候选集，
 * 哪个入口 / 档位先命中」是纯逻辑，应当能在没有数据库的情况下逐条验证。
 *
 * 口径（工单 31A §3.3）：
 * - 未登记（`registered === false`）→ `model_not_available`（AG-10 fail closed）。
 * - 已登记但没有任何行命中 → 同样 `model_not_available`。这是兜底：种子数据保证
 *   每个登记过的模型都有默认行，所以这一步正常走不到，走到就是数据缺行。
 * - 命中默认行（第 5、6 级）→ `search_key = "unknown"`、`search_key_matched = null`。
 * - `pending`（待定价）→ 三个价格字段都是 0，且**不是错误**：可以执行、按 0 扣。
 * - `active` → 一期 `unit_count = 1`，`total_price = unit_price = price`。
 *
 * 本单**不提供** HTTP 询价接口，也不接扣费路径（下一张单单独归因）。
 */

/**
 * 一条候选规则（= `pricing_rules` 的一行，已由 repository 校验过形态）。
 *
 * 用**判别联合**表达迁移里的那条 CHECK：`pending` 必须没有价格、`active` 必须有
 * 非负整数价格。这样「待定价却带着价格」这种行根本进不来，`resolve` 里也就不需要
 * 用 `?? 0` 把坏数据洗干净 —— 把它挡在类型边界比把它变成 0 更安全。
 */
type PricingRuleBase = {
  /** `pricing_rules.id`，回传给调用方用于归因（GN-07 验收 3「命中了哪条规则」）。 */
  id: string;
  /** 模型 id，或工具行的 `tool:<工具 id>`。 */
  modelId: string;
  entryPoint: EntryPoint;
  /** 档位名，或默认行的 `*`。 */
  searchKey: string;
  timePeriod: TimePeriod;
  /** 计价单位名：「次」（工具 / 图片）或「秒」（视频）。 */
  unitName: string;
  /** 视频秒数单位，GN-08 未收口，一期为 null。 */
  unitSize: number | null;
  /** 规则生效时间，ISO-8601。 */
  effectiveAt: string;
  /** GN-28 附加项，一期恒为空数组。 */
  extras: readonly PriceExtra[];
};

export type PricingRuleCandidate =
  | (PricingRuleBase & { priceStatus: "pending"; price: null })
  | (PricingRuleBase & { priceStatus: "active"; price: number });

/** 通配：规则行用它表示「任何入口 / 档位 / 时段都适用」。 */
export const WILDCARD = "*";

/** GN-01 验收 2：命中兜底时对外报的档位名。 */
export const UNKNOWN_SEARCH_KEY = "unknown";

/** GN-09b：一期 request 的时段恒为 `normal`。 */
export const DEFAULT_TIME_PERIOD: TimePeriod = "normal";

/** 未登记 / 无规则时的错误码（GN-07，fail closed）。 */
export const MODEL_NOT_AVAILABLE = "model_not_available";

export type ResolvePriceOutcome =
  | { ok: true; detail: PriceDetail; ruleId: string }
  | { ok: false; code: typeof MODEL_NOT_AVAILABLE };

export type ResolvePriceInput = {
  /**
   * 被询价的模型（或 `tool:<id>`）。刻意不参与 `price_detail` 的组装 ——
   * GN-01 的 key 列表里没有 `model_id`；留在这里是为了与
   * `listCandidateRules({ modelId })` 同名同参，调用点不用记两套名字。
   */
  modelId: string;
  entryPoint: EntryPoint;
  searchKey: string;
  /** GN-09b：一期只有 `normal`。见 `buildMatchOrder`。 */
  timePeriod?: "normal";
};

/**
 * 一档匹配规则：`entryPointWildcard` / `searchKeyWildcard` 为 true 表示这一档
 * 用 `*` 匹配，否则必须与请求值逐字相等。
 */
type MatchRung = {
  entryPointWildcard: boolean;
  searchKeyWildcard: boolean;
  timePeriod: TimePeriod;
};

/**
 * GN-07 的匹配优先级，写成**显式有序列表**（第一个命中即返回）：
 *
 * ```
 *   1. (entryPoint, searchKey, normal)
 *   2. (*,          searchKey, normal)
 *   3. (entryPoint, searchKey, *)
 *   4. (*,          searchKey, *)
 *   5. (entryPoint, *,          normal) → (entryPoint, *, *)        ← 第 5 级的 `…`
 *   6. (*,          *,          normal) → (*,          *, *)        ← 第 6 级的 `…`
 * ```
 *
 * 第 5、6 级原文用 `…` 表示「时段不区分」，这里把它按同样的顺序展开成两档
 * （`normal` 先于 `*`），所以实际是 8 个组合、6 个优先级。顺序本身就是规格：
 * 全精确 > 入口通配 > 时段通配 > 档位兜底 > 全通配（GN-07 正文）。
 *
 * `requestedPeriod` 一期只能是 `normal`（GN-09b），但它参与构造而不是写死，
 * 这样将来加第二个时段时这张表不用重写。
 */
function buildMatchOrder(requestedPeriod: TimePeriod): readonly MatchRung[] {
  return [
    // 1
    { entryPointWildcard: false, searchKeyWildcard: false, timePeriod: requestedPeriod },
    // 2
    { entryPointWildcard: true, searchKeyWildcard: false, timePeriod: requestedPeriod },
    // 3
    { entryPointWildcard: false, searchKeyWildcard: false, timePeriod: WILDCARD },
    // 4
    { entryPointWildcard: true, searchKeyWildcard: false, timePeriod: WILDCARD },
    // 5（第 5 级的两个时段档）
    { entryPointWildcard: false, searchKeyWildcard: true, timePeriod: requestedPeriod },
    { entryPointWildcard: false, searchKeyWildcard: true, timePeriod: WILDCARD },
    // 6（第 6 级的两个时段档）
    { entryPointWildcard: true, searchKeyWildcard: true, timePeriod: requestedPeriod },
    { entryPointWildcard: true, searchKeyWildcard: true, timePeriod: WILDCARD },
  ];
}

/** 一期一次询价只有一个计价单位（一张图 / 一次调用）。GN-08 再谈多单位。 */
const UNIT_COUNT = 1;

/** 待定价时对外报的金额：`pending` 不是错误，按 0 计价（BL-14 第 3 条）。 */
const ZERO_PRICE = 0;

/**
 * 从候选里按 GN-07 优先级选一条，并组装 `price_detail`。
 *
 * 候选为空或全部不匹配 → `model_not_available`（**不是**「免费」）。
 * 未登记 → 同样 `model_not_available`，且在匹配之前就返回：一个没登记过的 id
 * 不该因为表里恰好有同名行而变得可用。
 */
export function resolvePriceFromCandidates(
  input: ResolvePriceInput,
  candidates: readonly PricingRuleCandidate[],
  registered: boolean,
): ResolvePriceOutcome {
  if (!registered) return notAvailable();

  const requestedPeriod: TimePeriod = input.timePeriod ?? DEFAULT_TIME_PERIOD;
  const order = buildMatchOrder(requestedPeriod);

  for (const rung of order) {
    const expectedEntryPoint = rung.entryPointWildcard ? WILDCARD : input.entryPoint;
    const expectedSearchKey = rung.searchKeyWildcard ? WILDCARD : input.searchKey;

    const rule = candidates.find(
      (candidate) =>
        // 候选本应已是同一个模型的（repository 按 `model_id` 过滤过），这里再比一次
        // 是因为「串模型」是最贵的一种错：A 模型的价格被 B 模型用掉，账面上完全看不出来。
        // 宁可什么都不命中（fail closed），也不要跨模型命中。
        candidate.modelId === input.modelId &&
        candidate.entryPoint === expectedEntryPoint &&
        candidate.searchKey === expectedSearchKey &&
        candidate.timePeriod === rung.timePeriod,
    );

    if (rule !== undefined) {
      return { ok: true, detail: buildPriceDetail(rule, input.entryPoint), ruleId: rule.id };
    }
  }

  // 已登记、却没有一条规则命中：种子数据缺行。fail closed，别退回「免费」。
  return notAvailable();
}

function notAvailable(): ResolvePriceOutcome {
  return { ok: false, code: MODEL_NOT_AVAILABLE };
}

/**
 * 把命中的规则翻成 `price_detail`。
 *
 * `search_key` / `search_key_matched` 是一对**故意不对称**的字段：
 * 命中默认行时对外报 `unknown` / `null`（调用方看到「档位没配上」），
 * 命中具体档位时两者都等于档位（调用方看到「命中的是 2k」）。GN-01 验收 2 与
 * GN-07 验收 3 分别钉住这两半。
 */
function buildPriceDetail(rule: PricingRuleCandidate, entryPoint: EntryPoint): PriceDetail {
  const price = rule.priceStatus === "pending" ? ZERO_PRICE : rule.price;
  const hitDefaultRow = rule.searchKey === WILDCARD;

  return {
    base_price: price,
    unit_name: rule.unitName,
    unit_count: UNIT_COUNT,
    unit_price: price,
    total_price: price * UNIT_COUNT,
    search_key: hitDefaultRow ? UNKNOWN_SEARCH_KEY : rule.searchKey,
    search_key_matched: hitDefaultRow ? null : rule.searchKey,
    // GN-09b：一期恒为 normal，字段必须在。
    time_variant_period: "normal",
    // 一期没有无限量档位。
    disable_unlimited: false,
    entry_point: entryPoint,
    // GN-28 一期为空；照抄规则行，将来加了附加项不用改这里。
    extras: [...rule.extras],
    price_status: rule.priceStatus,
  };
}
