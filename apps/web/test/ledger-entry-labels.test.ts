import { describe, expect, it } from "vitest";

import { ledgerEntryTypeSchema, type LedgerEntryType } from "@loomic/shared";

import {
  LEDGER_ENTRY_LABELS,
  entryTypeOf,
  filterByEntryTypes,
} from "../src/lib/ledger-entry-labels";

/**
 * BL-06 · 流水类型的中文名与筛选（前端）
 *
 * 钉住三件事：
 *   1) 10 个 entry type 每个都有非空中文名；
 *   2) `entryTypeOf` 优先用服务端给的 `entry_type`，缺省时回落 shared 的旧枚举翻译；
 *   3) 空集合 = 全部；有选择时只留选中的类型。
 */

type Row = {
  transaction_type: "generation_deduct" | "generation_refund" | "daily_grant";
  amount: number;
  entry_type?: LedgerEntryType | undefined;
};

describe("BL-06 · ledger entry labels", () => {
  it("BL-06: every entry type has a non-empty Chinese label", () => {
    for (const type of ledgerEntryTypeSchema.options) {
      const label = LEDGER_ENTRY_LABELS[type];
      expect(typeof label, `${type} 没有标签`).toBe("string");
      expect(label.trim().length, `${type} 的标签是空串`).toBeGreaterThan(0);
      expect(label).not.toBe(type);
    }
  });

  it("BL-06: entryTypeOf prefers the server value and falls back to the shared mapping", () => {
    expect(entryTypeOf({ transaction_type: "generation_refund", amount: 5 })).toBe("refund_failed");
    expect(
      entryTypeOf({ transaction_type: "generation_refund", amount: 5, entry_type: "refund_canceled" }),
    ).toBe("refund_canceled");
  });

  it("BL-06: an empty selection keeps every row; a selection keeps only those types", () => {
    const rows: Row[] = [
      { transaction_type: "generation_deduct", amount: -5, entry_type: "consume" },
      { transaction_type: "generation_refund", amount: 5 },
      { transaction_type: "daily_grant", amount: 100 },
    ];

    expect(filterByEntryTypes(rows, new Set<LedgerEntryType>())).toHaveLength(3);

    const onlyRefund = filterByEntryTypes(rows, new Set<LedgerEntryType>(["refund_failed"]));
    expect(onlyRefund).toHaveLength(1);
    expect(onlyRefund[0]).toBe(rows[1]);

    const two = filterByEntryTypes(rows, new Set<LedgerEntryType>(["consume", "daily_grant"]));
    expect(two).toHaveLength(2);

    expect(filterByEntryTypes(rows, new Set<LedgerEntryType>(["trial"]))).toHaveLength(0);
  });
});
