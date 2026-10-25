import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { BackgroundJobStatus, Database } from "@loomic/shared";
import {
  Constants,
  applicationErrorCodeSchema,
  applicationErrorResponseSchema,
  backgroundJobSchema,
  backgroundJobStatusSchema,
  canvasConflictResponseSchema,
  entryPointSchema,
  errorCodeSchema,
  errorCodeValues,
  jobListResponseSchema,
  jobProgressEventSchema,
  jobResponseSchema,
  loomicErrorSchema,
  priceDetailSchema,
  priceStatusSchema,
  pricingQuoteItemResponseSchema,
  projectCreateResponseSchema,
  projectListResponseSchema,
  projectSummarySchema,
  skillListItemSchema,
  skillListResponseSchema,
  streamEventSchema,
  timePeriodSchema,
  unauthenticatedErrorResponseSchema,
  workspaceSkillListResponseSchema,
  wsRpcResponseSchema,
  wsServerEventSchema,
} from "@loomic/shared";

import { validationErrorBody } from "../http/validation-error.js";

/**
 * QA-04 后端：五类契约测试（工单45CN）。
 *
 * 这个文件钉的是「对外形状不能悄悄变」：任务状态枚举、`event_type` 枚举、
 * 列表对象 key 集合、`price_detail` 全字段、错误 shape 统一。
 *
 * 每个断言都能指出代码里的权威来源（写在断言上方的「权威来源」注释里）。
 * 不连数据库：全部走 `@loomic/shared` 的 zod schema / 常量，加上对发射端与
 * 路由源码的定点核对；需要真库的状态契约另有
 * `src/test-support/db/job-status-contract-db.test.ts`（被 vitest.config.ts 排除）。
 *
 * 这里刻意不 `as any` / 不 `@ts-expect-error`：读取 zod 结构用结构化类型收窄，
 * 拿不到预期结构就直接 throw，让契约变化以「测试报错」而不是「断言静默通过」出现。
 */

// --- 小工具：结构化读取 zod 结构，拿不到就 throw -----------------------------

function isRecord(node: unknown): node is Record<string, unknown> {
  return typeof node === "object" && node !== null;
}

function requireRecord(node: unknown, what: string): Record<string, unknown> {
  if (!isRecord(node)) {
    throw new Error(`${what} 不是对象 —— 契约结构变了`);
  }
  return node;
}

/** 取 zod object schema 的字段表（`.shape`）。 */
function shapeOf(schema: unknown, what: string): Record<string, unknown> {
  return requireRecord(requireRecord(schema, what).shape, `${what}.shape`);
}

/** 字段集合（排序，用于「集合完全相等」比较）。 */
function shapeKeys(schema: unknown, what: string): string[] {
  return Object.keys(shapeOf(schema, what)).sort();
}

/** 字段声明顺序（用于钉「字段清单与顺序」）。 */
function shapeKeysInOrder(schema: unknown, what: string): string[] {
  return Object.keys(shapeOf(schema, what));
}

/** `z.enum([...])` 的取值集合。 */
function enumOptionValues(schema: unknown, what: string): string[] {
  const options = requireRecord(schema, what).options;
  if (!Array.isArray(options)) {
    throw new Error(`${what} 不是 z.enum（没有 options 数组）`);
  }
  return options.map((option: unknown) => String(option)).sort();
}

/** `z.discriminatedUnion("<key>", [...])` 各成员的判别值集合。 */
function discriminatedUnionValues(
  schema: unknown,
  discriminator: string,
  what: string,
): string[] {
  const options = requireRecord(schema, what).options;
  if (!Array.isArray(options)) {
    throw new Error(`${what} 不是 z.discriminatedUnion（没有 options 数组）`);
  }
  return options
    .map((option: unknown, index: number) => {
      const member = shapeOf(option, `${what} 成员 #${index}`);
      const literal = requireRecord(
        member[discriminator],
        `${what} 成员 #${index} 的 ${discriminator}`,
      );
      const value = literal.value;
      if (typeof value !== "string") {
        throw new Error(`${what} 成员 #${index} 的 ${discriminator} 不是字面量`);
      }
      return value;
    })
    .sort();
}

/** `z.array(...)` 的元素 schema。 */
function arrayElementOf(schema: unknown, what: string): unknown {
  return requireRecord(schema, what).element;
}

/** `z.literal(...)` 的字面量值。 */
function literalValueOf(schema: unknown, what: string): unknown {
  return requireRecord(schema, what).value;
}

/** 源码定点核对用：按仓库相对路径读文件（执行树根 = 本测试文件上四级）。 */
const REPO_ROOT = new URL("../../../../", import.meta.url);

function sourceOf(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}

// =============================================================================
// 契约 1/5：任务状态枚举（background_jobs.status）
// =============================================================================

/**
 * 权威来源：
 * - `packages/shared/src/job-contracts.ts:7-20`  —— 对外 zod 契约 `backgroundJobStatusSchema`
 * - `packages/shared/src/supabase/database.ts:1098-1105` —— 生成的 DB 类型 `Database["public"]["Enums"]["background_job_status"]`
 * - `packages/shared/src/supabase/database.ts:1247-1255` —— 生成的 DB 运行时枚举 `Constants.public.Enums.background_job_status`
 */
const DB_STATUS_VALUES = Constants.public.Enums.background_job_status;

/** 编译期互赋：两侧任一方向多出或少掉一个值，typecheck 就失败。 */
const STATUS_FROM_SHARED_INTO_DB: Database["public"]["Enums"]["background_job_status"][] = [
  ...backgroundJobStatusSchema.options,
];
const STATUS_FROM_DB_INTO_SHARED: BackgroundJobStatus[] = [...DB_STATUS_VALUES];

describe("QA-04 契约 1/5：任务状态枚举 background_jobs.status", () => {
  it("case 1: zod 契约的取值集合与 DB 枚举完全相等", () => {
    expect(enumOptionValues(backgroundJobStatusSchema, "backgroundJobStatusSchema")).toEqual(
      [...DB_STATUS_VALUES].sort(),
    );
    // 编译期那两条互赋常量在这里被引用一次，确认它们确实参与构建
    expect(STATUS_FROM_SHARED_INTO_DB.length).toBe(DB_STATUS_VALUES.length);
    expect(STATUS_FROM_DB_INTO_SHARED.length).toBe(DB_STATUS_VALUES.length);
  });

  it("case 2: 七个值里六个是客户端可见状态，dead_letter 是唯一的遗留值", () => {
    // 权威来源：job-contracts.ts:16-19（dead_letter 只为历史行保留）、
    // job-service.ts:319-322（唯一的 dead_letter → failed 翻译点）
    const all = enumOptionValues(backgroundJobStatusSchema, "backgroundJobStatusSchema");
    expect(all).toEqual([
      "canceled",
      "dead_letter",
      "failed",
      "queued",
      "retrying",
      "running",
      "succeeded",
    ]);
    expect(all.filter((status) => status !== "dead_letter")).toEqual([
      "canceled",
      "failed",
      "queued",
      "retrying",
      "running",
      "succeeded",
    ]);
  });

  it("case 3: job.progress 事件的 status 仍是宽松 string（已知松口，钉住现状）", () => {
    // 权威来源：events.ts:166-167 —— 该字段刻意是 `z.string()`，注释里列了
    // 客户端会看到的取值。也就是说枚举的一致性只能靠「写入端」保证，事件本身不校验。
    const parsed = jobProgressEventSchema.safeParse({
      type: "job.progress",
      jobId: "00000000-0000-0000-0000-000000000000",
      jobType: "image_generation",
      status: "not_a_known_status",
      timestamp: "2024-01-01T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });
});

// =============================================================================
// 契约 2/5：event_type 枚举
// =============================================================================

/**
 * 权威来源：`packages/shared/src/events.ts:193-206` —— `streamEventSchema`
 * 是事件类型的唯一清单（discriminatedUnion 的成员）。
 *
 * 传输层 `packages/shared/src/ws-protocol.ts:7-10` 把整条事件塞进
 * `wsServerEventSchema.event`，不是第二处定义 —— 见 case 3 的对象同一性断言。
 */
const STREAM_EVENT_TYPES = discriminatedUnionValues(
  streamEventSchema,
  "type",
  "streamEventSchema",
);

describe("QA-04 契约 2/5：event_type 枚举 StreamEvent.type", () => {
  it("case 1: 事件类型集合完全相等（12 个成员）", () => {
    expect(STREAM_EVENT_TYPES).toEqual([
      "billing.error",
      "canvas.sync",
      "job.progress",
      "message.delta",
      "message.persist_failed",
      "run.canceled",
      "run.completed",
      "run.failed",
      "run.started",
      "thinking.delta",
      "tool.completed",
      "tool.started",
    ]);
  });

  it("case 2: 同一个 type 不会在联合里出现两次", () => {
    expect(STREAM_EVENT_TYPES).toHaveLength(12);
    expect(new Set(STREAM_EVENT_TYPES).size).toBe(STREAM_EVENT_TYPES.length);
  });

  it("case 3: WS 传输层复用同一个 schema 对象，不是第二套事件清单", () => {
    // 权威来源：ws-protocol.ts:2（import）、:7-10（wsServerEventSchema.event）
    expect(shapeOf(wsServerEventSchema, "wsServerEventSchema").event).toBe(streamEventSchema);
  });

  it("case 4: 服务端发射端写的 type 字面量都在契约集合里", () => {
    // 权威来源：apps/server/src/agent/stream-adapter.ts 是 agent 事件的发射端
    const adapter = sourceOf("apps/server/src/agent/stream-adapter.ts");
    const emitted = [...adapter.matchAll(/\btype:\s*"([a-z]+\.[a-z_]+)"/g)]
      .map((match) => match[1])
      .filter((value): value is string => typeof value === "string");

    expect(emitted.length).toBeGreaterThan(0);
    expect([...new Set(emitted)].sort().filter((type) => !STREAM_EVENT_TYPES.includes(type))).toEqual(
      [],
    );
  });
});

// =============================================================================
// 契约 3/5：列表对象 key 集合一致
// =============================================================================

/**
 * 权威来源：
 * - 技能列表 `/api/skills`：`packages/shared/src/skill-contracts.ts:102-105`
 * - 工作区技能列表：`packages/shared/src/skill-contracts.ts:112-117`
 * - 两者共用 `skillListItemSchema`：`packages/shared/src/skill-contracts.ts:20-38`
 * - 项目列表 `/api/projects`：`packages/shared/src/http.ts:57-59`
 * - 项目创建响应：`packages/shared/src/http.ts:66-68`
 * - 两者共用 `projectSummarySchema`：`packages/shared/src/contracts.ts:148-158`
 * - 任务列表 `/api/jobs`：`packages/shared/src/job-contracts.ts:173-176`
 * - 单任务响应：`packages/shared/src/job-contracts.ts:160-171`
 * - 两者共用 `backgroundJobSchema`：`packages/shared/src/job-contracts.ts:104-127`
 */
const SKILL_ITEM_KEYS = shapeKeysInOrder(skillListItemSchema, "skillListItemSchema");

/** 技能条目的 13 个必填 key（声明顺序），后 3 个是「按工作区列时才填」的可选 key。 */
const SKILL_ITEM_REQUIRED_KEYS = [
  "id",
  "name",
  "slug",
  "description",
  "author",
  "version",
  "category",
  "iconName",
  "source",
  "isFeatured",
  "metadata",
  "createdAt",
  "updatedAt",
];

/** 工作区列表额外填的三个字段 —— 这**恰好**就是两处列表的差异。 */
const SKILL_ITEM_WORKSPACE_ONLY_KEYS = ["installed", "enabled", "installedAt"];

describe("QA-04 契约 3/5：列表对象 key 集合一致", () => {
  it("case 1: /api/skills 与工作区技能列表用同一个 item schema，key 集合必然相同", () => {
    const registryList = shapeOf(skillListResponseSchema, "skillListResponseSchema");
    const workspaceList = shapeOf(
      workspaceSkillListResponseSchema,
      "workspaceSkillListResponseSchema",
    );

    expect(registryList.skills).toBeDefined();
    expect(arrayElementOf(registryList.skills, "skillListResponseSchema.skills")).toBe(
      skillListItemSchema,
    );
    expect(
      arrayElementOf(workspaceList.skills, "workspaceSkillListResponseSchema.skills"),
    ).toBe(skillListItemSchema);
    // 两个响应的外壳 key 集合也一致
    expect(shapeKeys(skillListResponseSchema, "skillListResponseSchema")).toEqual(["skills"]);
    expect(
      shapeKeys(workspaceSkillListResponseSchema, "workspaceSkillListResponseSchema"),
    ).toEqual(["skills"]);
  });

  it("case 2: 两处列表的差异恰好是 installed / enabled / installedAt 三个可选字段", () => {
    expect(SKILL_ITEM_KEYS.slice(0, SKILL_ITEM_REQUIRED_KEYS.length)).toEqual(
      SKILL_ITEM_REQUIRED_KEYS,
    );
    expect(SKILL_ITEM_KEYS.slice(SKILL_ITEM_REQUIRED_KEYS.length)).toEqual(
      SKILL_ITEM_WORKSPACE_ONLY_KEYS,
    );
    expect(SKILL_ITEM_KEYS).toHaveLength(
      SKILL_ITEM_REQUIRED_KEYS.length + SKILL_ITEM_WORKSPACE_ONLY_KEYS.length,
    );

    // 权威来源：apps/server/src/http/skills.ts:352-357 —— 只有工作区那条路由填这三个字段
    const skillsRoute = sourceOf("apps/server/src/http/skills.ts");
    const workspaceParseAt = skillsRoute.indexOf("workspaceSkillListResponseSchema.parse");
    const registryParseAt = skillsRoute.indexOf("skillListResponseSchema.parse");
    expect(workspaceParseAt).toBeGreaterThan(-1);
    expect(registryParseAt).toBeGreaterThan(-1);

    const workspaceSnippet = skillsRoute.slice(Math.max(0, workspaceParseAt - 800), workspaceParseAt);
    expect(workspaceSnippet).toContain("installed: true");
    expect(workspaceSnippet).toContain("enabled: row.enabled");
    expect(workspaceSnippet).toContain("installedAt: row.installed_at");

    const registrySnippet = skillsRoute.slice(Math.max(0, registryParseAt - 800), registryParseAt);
    expect(registrySnippet).not.toContain("installed:");
    expect(registrySnippet).not.toContain("installedAt:");
  });

  it("case 3: /api/projects 列表与创建响应里的项目对象 key 集合相同", () => {
    const list = shapeOf(projectListResponseSchema, "projectListResponseSchema");
    const created = shapeOf(projectCreateResponseSchema, "projectCreateResponseSchema");

    expect(arrayElementOf(list.projects, "projectListResponseSchema.projects")).toBe(
      projectSummarySchema,
    );
    expect(created.project).toBe(projectSummarySchema);
    expect(shapeKeys(projectSummarySchema, "projectSummarySchema")).toEqual([
      "createdAt",
      "description",
      "id",
      "name",
      "primaryCanvas",
      "slug",
      "thumbnailUrl",
      "updatedAt",
      "workspace",
    ]);
  });

  it("case 4: /api/jobs 列表与单任务响应里的任务对象 key 集合相同", () => {
    const list = shapeOf(jobListResponseSchema, "jobListResponseSchema");
    const single = shapeOf(jobResponseSchema, "jobResponseSchema");

    expect(arrayElementOf(list.jobs, "jobListResponseSchema.jobs")).toBe(backgroundJobSchema);
    expect(single.job).toBe(backgroundJobSchema);
    // 权威来源：job-contracts.ts:178-192 —— 单任务响应多出的 balance 是外层字段，
    // 不扩进 job 本身，所以两处的「任务对象」key 集合仍必须完全一致。
    expect(shapeKeys(jobResponseSchema, "jobResponseSchema")).toEqual(["balance", "job"]);
    expect(shapeKeys(backgroundJobSchema, "backgroundJobSchema")).toEqual([
      "attempt_count",
      "canceled_at",
      "canvas_id",
      "completed_at",
      "created_at",
      "created_by",
      "error_code",
      "error_message",
      "failed_at",
      "id",
      "job_type",
      "max_attempts",
      "payload",
      "project_id",
      "queue_name",
      "result",
      "session_id",
      "started_at",
      "status",
      "thread_id",
      "updated_at",
      "workspace_id",
    ]);
  });
});

// =============================================================================
// 契约 4/5：price_detail 全字段
// =============================================================================

/**
 * 权威来源：`packages/shared/src/pricing.ts:11-15`（GN-01 字段清单）与
 * `packages/shared/src/pricing.ts:62-87`（`priceDetailSchema` 本体）。
 * 验收判据是 **key 集合完全一致**，所以顺序也一起钉住。
 */
const PRICE_DETAIL_FIELDS = [
  "base_price",
  "unit_name",
  "unit_count",
  "unit_price",
  "total_price",
  "search_key",
  "search_key_matched",
  "time_variant_period",
  "disable_unlimited",
  "entry_point",
  "extras",
  "price_status",
];

/** 一条能过 `priceDetailSchema` 的完整报价（GN-01 验收 2 的形态：命中具体档位）。 */
const VALID_PRICE_DETAIL: Record<string, unknown> = {
  base_price: 10,
  unit_name: "image",
  unit_count: 1,
  unit_price: 10,
  total_price: 10,
  search_key: "gemini-2.5-flash-image",
  search_key_matched: "gemini-2.5-flash-image",
  time_variant_period: "normal",
  disable_unlimited: false,
  entry_point: "canvas_generator",
  extras: [],
  price_status: "active",
};

describe("QA-04 契约 4/5：price_detail 全字段", () => {
  it("case 1: 字段集合与声明顺序都与 GN-01 清单一致", () => {
    expect(shapeKeysInOrder(priceDetailSchema, "priceDetailSchema")).toEqual(
      PRICE_DETAIL_FIELDS,
    );
    expect(shapeKeys(priceDetailSchema, "priceDetailSchema")).toEqual(
      [...PRICE_DETAIL_FIELDS].sort(),
    );
  });

  it("case 2: 十二个字段全是必填 —— 少任何一个都 parse 不过", () => {
    expect(priceDetailSchema.safeParse(VALID_PRICE_DETAIL).success).toBe(true);

    for (const field of PRICE_DETAIL_FIELDS) {
      const broken: Record<string, unknown> = { ...VALID_PRICE_DETAIL };
      delete broken[field];
      expect({ field, parsed: priceDetailSchema.safeParse(broken).success }).toEqual({
        field,
        parsed: false,
      });
    }
  });

  it("case 3: 嵌套与受限字段的取值集合也钉住", () => {
    const shape = shapeOf(priceDetailSchema, "priceDetailSchema");

    // 权威来源：pricing.ts:33-39 —— 与迁移 pricing_rules.entry_point 的 CHECK 逐字一致
    expect(enumOptionValues(shape.entry_point, "price_detail.entry_point")).toEqual([
      "*",
      "agent",
      "agent_generator",
      "canvas_generator",
      "tool",
    ]);
    expect(enumOptionValues(entryPointSchema, "entryPointSchema")).toEqual([
      "*",
      "agent",
      "agent_generator",
      "canvas_generator",
      "tool",
    ]);
    // 权威来源：pricing.ts:26 —— pending = 待定价，active = 已定价
    expect(enumOptionValues(shape.price_status, "price_detail.price_status")).toEqual([
      "active",
      "pending",
    ]);
    expect(enumOptionValues(priceStatusSchema, "priceStatusSchema")).toEqual([
      "active",
      "pending",
    ]);
    // 权威来源：pricing.ts:78 —— 一期恒为 "normal"，字段必须出现
    expect(literalValueOf(shape.time_variant_period, "price_detail.time_variant_period")).toBe(
      "normal",
    );
    // 权威来源：pricing.ts:46 —— 与迁移 pricing_rules.time_period 的 CHECK 一致
    expect(enumOptionValues(timePeriodSchema, "timePeriodSchema")).toEqual(["*", "normal"]);
    // 权威来源：pricing.ts:53-54 —— GN-28 附加项结构未定，只要求「一条附加项是一个对象」
    expect(arrayElementOf(shape.extras, "price_detail.extras")).toBeDefined();

    // 价格口径：pending 时三个价格字段都是 0，仍然必须出现（GN-07）
    expect(
      priceDetailSchema.safeParse({
        ...VALID_PRICE_DETAIL,
        base_price: 0,
        unit_price: 0,
        total_price: 0,
        price_status: "pending",
        search_key: "unknown",
        search_key_matched: null,
      }).success,
    ).toBe(true);
  });

  it("case 4: 询价响应与扣费路径都用同一个 price_detail，没有第二份定义", () => {
    // 权威来源：pricing-quote.ts:130-133 —— 询价 ok 分支的 price_detail 就是同一个 schema 对象
    const quoteOptions = requireRecord(pricingQuoteItemResponseSchema, "pricingQuoteItemResponseSchema")
      .options;
    if (!Array.isArray(quoteOptions) || quoteOptions.length === 0) {
      throw new Error("pricingQuoteItemResponseSchema 不是 discriminatedUnion");
    }
    expect(shapeOf(quoteOptions[0], "询价 ok 分支").price_detail).toBe(priceDetailSchema);

    // 权威来源：apps/server/src/db/credit-ledger-write-repository.ts:1 ——
    // 扣费流水直接 import shared 的 PriceDetail 类型，不自己声明一份。
    const ledger = sourceOf("apps/server/src/db/credit-ledger-write-repository.ts");
    expect(ledger).toContain('import type { PriceDetail } from "@loomic/shared"');
    expect(/(?:type|interface)\s+PriceDetail\s*=/.test(ledger)).toBe(false);

    const withBilling = sourceOf("apps/server/src/features/credits/with-billing.ts");
    expect(withBilling).toContain("PriceDetail");
    expect(/(?:type|interface)\s+PriceDetail\s*=/.test(withBilling)).toBe(false);
  });
});

// =============================================================================
// 契约 5/5：错误 shape 统一
// =============================================================================

/**
 * 权威来源：
 * - `packages/shared/src/http.ts:234-239` `applicationErrorResponseSchema`
 * - `packages/shared/src/http.ts:113-118` `unauthenticatedErrorResponseSchema`
 * - `packages/shared/src/http.ts:266-273` `canvasConflictResponseSchema`（409，唯一多带字段的）
 *
 * 「只有这几种形状」的清单（显式列出，不用「大致一样」糊过去）：
 * 1. `{ error: { code, message } }`                 —— 绝大多数 HTTP 错误
 * 2. `{ error: { code, message }, currentVersion, currentContent }` —— 仅画布 409
 * 3. `{ error: { code, message }, issues, message }` —— 仅 400 校验错误（additive，
 *    见 apps/server/src/http/validation-error.ts:4-8）
 * 4. `{ code, message, details? }`                   —— 流内 `loomicErrorSchema`（events.ts / errors.ts）
 * 5. `{ error: string }`                             —— WS RPC 响应（ws-protocol.ts:60-65）
 */
const HTTP_ERROR_ENVELOPES = [
  {
    name: "applicationErrorResponseSchema",
    schema: applicationErrorResponseSchema as unknown,
    extraTopLevelKeys: [] as string[],
  },
  {
    name: "unauthenticatedErrorResponseSchema",
    schema: unauthenticatedErrorResponseSchema as unknown,
    extraTopLevelKeys: [] as string[],
  },
  {
    name: "canvasConflictResponseSchema",
    schema: canvasConflictResponseSchema as unknown,
    extraTopLevelKeys: ["currentVersion", "currentContent"],
  },
];

describe("QA-04 契约 5/5：错误 shape 统一", () => {
  it("case 1: 每个 HTTP 错误响应都是 { error: { code, message } }，多余字段只有 409 那两个", () => {
    for (const envelope of HTTP_ERROR_ENVELOPES) {
      const shape = shapeOf(envelope.schema, envelope.name);

      expect({
        name: envelope.name,
        topLevelKeys: Object.keys(shape).sort(),
      }).toEqual({
        name: envelope.name,
        topLevelKeys: ["error", ...envelope.extraTopLevelKeys].sort(),
      });

      // error 对象本身永远是且只是 code + message
      expect(shapeKeys(shape.error, `${envelope.name}.error`)).toEqual(["code", "message"]);
    }
  });

  it("case 2: 两套错误码互不重叠：unauthorized 与 canvas_version_conflict 不在应用错误码里", () => {
    const applicationCodes = enumOptionValues(
      applicationErrorCodeSchema,
      "applicationErrorCodeSchema",
    );
    expect(applicationCodes).toContain("invalid_request");
    expect(applicationCodes).toContain("forbidden");
    expect(applicationCodes).not.toContain("unauthorized");
    expect(applicationCodes).not.toContain("canvas_version_conflict");
  });

  it("case 3: 400 校验错误是 additive 的第三种顶层形状，error 内部仍是 code + message", () => {
    // 权威来源：apps/server/src/http/validation-error.ts:11-17
    const body = validationErrorBody([{ path: ["name"], message: "Required" }]);

    expect(Object.keys(body).sort()).toEqual(["error", "issues", "message"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
    expect(body.error.code).toBe("invalid_request");
    // 去掉那两个 additive 字段就是标准形状
    expect(
      applicationErrorResponseSchema.safeParse({
        error: { code: body.error.code, message: body.error.message },
      }).success,
    ).toBe(true);
  });

  it("case 4: 流内错误（loomicErrorSchema）是第四种形状，且 code 只有五个值", () => {
    // 权威来源：errors.ts:3-17（errorCodeValues 与 loomicErrorSchema 在同一文件里两处定义，必须互相一致）
    expect(enumOptionValues(errorCodeSchema, "errorCodeSchema")).toEqual([
      "invalid_request",
      "run_conflict",
      "run_failed",
      "run_not_found",
      "tool_failed",
    ]);
    expect([...errorCodeValues].sort()).toEqual(
      enumOptionValues(errorCodeSchema, "errorCodeSchema"),
    );
    // details 是唯一的可选字段；code / message 必填
    expect(shapeKeys(loomicErrorSchema, "loomicErrorSchema")).toEqual([
      "code",
      "details",
      "message",
    ]);
    expect(loomicErrorSchema.safeParse({ code: "run_failed", message: "boom" }).success).toBe(
      true,
    );
    expect(loomicErrorSchema.safeParse({ code: "run_failed" }).success).toBe(false);
  });

  it("case 5: WS RPC 响应的 error 是一句话（第五种形状），不是错误对象", () => {
    // 权威来源：ws-protocol.ts:60-65
    expect(
      wsRpcResponseSchema.safeParse({ type: "rpc.response", id: "r1", error: "boom" }).success,
    ).toBe(true);
    expect(
      wsRpcResponseSchema.safeParse({
        type: "rpc.response",
        id: "r1",
        error: { code: "x", message: "y" },
      }).success,
    ).toBe(false);
  });
});
