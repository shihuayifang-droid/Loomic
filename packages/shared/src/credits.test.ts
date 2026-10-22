import { describe, expect, it } from "vitest";

import {
  creditTransactionSchema,
  creditTransactionTypeSchema,
  creditTransactionsResponseSchema,
  ledgerEntryTypeOf,
  ledgerEntryTypeSchema,
} from "./credits.js";
import { IMAGE_MODEL_CATALOG, VIDEO_MODEL_CATALOG } from "./model-catalog.js";

// BL-14 第 1 条 / 工单 31C：价格只存在价目表（`pricing_rules`）里，代码里不留价格常量。
//
// 这里原本是视频估价函数的那组用例。函数和成本表已随本单删除（价格改由运行时
// 询价），所以这组用例无处可测；文件不能空着（空的测试文件 vitest 会报
// "No test suite found"），于是把它换成一条守得住的门禁：catalog 里不许再出现价格字段。
describe("model catalog", () => {
  it("carries no price field on any entry", () => {
    const entries = [
      ...Object.values(IMAGE_MODEL_CATALOG),
      ...Object.values(VIDEO_MODEL_CATALOG),
    ];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(Object.keys(entry)).not.toContain("cost");
    }
  });
});

// BL-06 第 1 条 / 工单 33Q：流水类型枚举前后端同一份，数据库那 7 个
// `credit_transaction_type` 由 `ledgerEntryTypeOf` 单点翻译。
describe("BL-06 ledger entry types", () => {
  it("BL-06: the entry type list is exactly the ten the spec names", () => {
    expect(ledgerEntryTypeSchema.options).toEqual([
      "consume",
      "refund_failed",
      "refund_canceled",
      "daily_grant",
      "daily_expire",
      "cycle_grant",
      "cycle_reset",
      "topup",
      "admin_adjust",
      "trial",
    ]);
  });

  it("BL-06: every database transaction type maps to an entry type", () => {
    expect(creditTransactionTypeSchema.options.length).toBeGreaterThan(0);
    for (const transactionType of creditTransactionTypeSchema.options) {
      expect(() =>
        ledgerEntryTypeSchema.parse(ledgerEntryTypeOf(transactionType)),
      ).not.toThrow();
    }
  });

  it("BL-06: generation_refund maps to refund_failed and generation_deduct to consume", () => {
    expect(ledgerEntryTypeOf("generation_refund")).toBe("refund_failed");
    expect(ledgerEntryTypeOf("generation_deduct")).toBe("consume");
  });

  it("BL-06: a transaction without entry_type still parses (backward compatible)", () => {
    const base = {
      id: "00000000-0000-0000-0000-0000000033aa",
      transaction_type: "daily_grant" as const,
      amount: 100,
      balance_after: 100,
      job_id: null,
      description: null,
      created_at: "2026-10-20T00:00:00Z",
    };

    expect(() => creditTransactionSchema.parse(base)).not.toThrow();
    expect(() =>
      creditTransactionSchema.parse({ ...base, entry_type: "daily_grant" }),
    ).not.toThrow();
    expect(() =>
      creditTransactionSchema.parse({ ...base, entry_type: "bogus" }),
    ).toThrow();
  });
});

// BL-06 / workorder 38C: the database enum grew to ten values in 37O; if the
// shared enum lags, `GET /api/credits/transactions` answers 500 the first time a
// pool-cycle row is read.
describe("BL-06 database transaction types, ten of them", () => {
  it("BL-06: the database's ten transaction types are all known", () => {
    expect(creditTransactionTypeSchema.options).toEqual([
      "subscription_grant",
      "daily_grant",
      "purchase",
      "generation_deduct",
      "generation_refund",
      "admin_adjustment",
      "bonus",
      "cycle_grant",
      "cycle_reset",
      "daily_expire",
    ]);
  });

  it("BL-06: pool-cycle rows map to their own entry types and parse in a response", () => {
    expect(ledgerEntryTypeOf("cycle_grant")).toBe("cycle_grant");
    expect(ledgerEntryTypeOf("cycle_reset")).toBe("cycle_reset");
    expect(ledgerEntryTypeOf("daily_expire")).toBe("daily_expire");

    const transactions = (
      ["cycle_grant", "cycle_reset", "daily_expire"] as const
    ).map((transactionType, index) => ({
      id: `00000000-0000-0000-0000-000000038c0${index}`,
      transaction_type: transactionType,
      entry_type: ledgerEntryTypeOf(transactionType),
      amount: 10,
      balance_after: 10,
      job_id: null,
      description: null,
      created_at: "2026-10-20T00:00:00Z",
    }));

    expect(() =>
      creditTransactionsResponseSchema.parse({ transactions }),
    ).not.toThrow();
  });
});

// BL-41 第 2 条 / 工单 39M：取消退款与失败退款在对外口径（`entry_type`）上分开，
// 落库类型仍是 `generation_refund`，所以唯一的区分依据是流水描述。
describe("BL-41 canceled and failed refunds", () => {
  it("BL-41: a canceled refund is refund_canceled", () => {
    expect(
      ledgerEntryTypeOf(
        "generation_refund",
        12,
        "Auto-refund: job canceled before start",
      ),
    ).toBe("refund_canceled");
  });

  it("BL-41: a failed refund stays refund_failed", () => {
    expect(
      ledgerEntryTypeOf("generation_refund", 12, "Auto-refund: job failed"),
    ).toBe("refund_failed");
  });

  it("BL-41: no description is refund_failed", () => {
    expect(ledgerEntryTypeOf("generation_refund", 12, null)).toBe(
      "refund_failed",
    );
    expect(ledgerEntryTypeOf("generation_refund", 12)).toBe("refund_failed");
  });
});
