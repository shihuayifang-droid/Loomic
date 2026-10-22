// @credits-system — BL-06: the one place the web app names a ledger entry type.
import { ledgerEntryTypeOf, type CreditTransaction, type LedgerEntryType } from "@loomic/shared";

/** BL-06: the user-facing name of every ledger entry type. */
export const LEDGER_ENTRY_LABELS: Record<LedgerEntryType, string> = {
  consume: "消耗",
  refund_failed: "失败退款",
  refund_canceled: "取消退款",
  daily_grant: "每日赠送",
  daily_expire: "每日赠送过期",
  cycle_grant: "周期额度发放",
  cycle_reset: "周期额度重置",
  topup: "充值到账",
  admin_adjust: "后台调整",
  trial: "试用",
};

/** The entry type the server sent, or the shared translation for an older response. */
export function entryTypeOf(
  t: Pick<CreditTransaction, "transaction_type" | "amount"> & {
    entry_type?: LedgerEntryType | undefined;
    /**
     * BL-41 / workorder 39M: a cancel refund and a failed refund share the stored
     * transaction type, so the sentence is the only thing that tells them apart.
     * Optional on purpose — a row without one keeps the pre-39M answer.
     */
    description?: string | null | undefined;
  },
): LedgerEntryType {
  return (
    t.entry_type ??
    ledgerEntryTypeOf(t.transaction_type, t.amount, t.description)
  );
}

/** Empty selection = everything. */
export function filterByEntryTypes<T extends Parameters<typeof entryTypeOf>[0]>(
  rows: T[],
  selected: ReadonlySet<LedgerEntryType>,
): T[] {
  if (selected.size === 0) return rows;
  return rows.filter((row) => selected.has(entryTypeOf(row)));
}
