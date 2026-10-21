// @credits-system — Usage history table showing credit transactions
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Zap } from "lucide-react";
import { ledgerEntryTypeSchema, type CreditTransaction, type LedgerEntryType } from "@loomic/shared";

import { useAuth } from "@/lib/auth-context";
import { fetchCreditTransactions } from "@/lib/credits-api";
import { LEDGER_ENTRY_LABELS, entryTypeOf, filterByEntryTypes } from "@/lib/ledger-entry-labels";
import { poolLabelOf } from "@/lib/ledger-pool-label";

// ── Page size ────────────────────────────────────────────────

const PAGE_SIZE = 20;

// ── Helpers ──────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Main component ───────────────────────────────────────────

export function CreditUsageHistory() {
  const { session } = useAuth();
  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;

  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState<Set<LedgerEntryType>>(new Set());
  const [hasMore, setHasMore] = useState(true);

  const loadTransactions = useCallback(async (limit: number) => {
    const token = accessTokenRef.current;
    if (!token) return;
    try {
      const result = await fetchCreditTransactions(token, limit);
      setTransactions(result.transactions);
      setHasMore(result.transactions.length >= limit);
    } catch {
      // Silently fail — user will see empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTransactions(PAGE_SIZE);
  }, [loadTransactions]);

  const handleLoadMore = async () => {
    setLoadingMore(true);
    const nextLimit = transactions.length + PAGE_SIZE;
    await loadTransactions(nextLimit);
    setLoadingMore(false);
  };

  // BL-06: multi-select by entry type — nothing selected means everything
  const toggleType = (type: LedgerEntryType) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const filtered = filterByEntryTypes(transactions, selectedTypes);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading usage history...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Usage</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          View your credit usage history and transactions.
        </p>
      </div>

      {/* Filter buttons — one per entry type, multi-select */}
      <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
        <button data-testid="credits-history-filter-all"
          type="button"
          onClick={() => setSelectedTypes(new Set())}
          aria-pressed={selectedTypes.size === 0}
          className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
            selectedTypes.size === 0
              ? "bg-card font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          全部
        </button>
        {ledgerEntryTypeSchema.options.map((type) => (
          <button data-testid={`credits-history-filter-${type}`}
            key={type}
            type="button"
            onClick={() => toggleType(type)}
            aria-pressed={selectedTypes.has(type)}
            className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
              selectedTypes.has(type)
                ? "bg-card font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {LEDGER_ENTRY_LABELS[type]}
          </button>
        ))}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <Zap className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No transactions found.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">描述</th>
                <th className="px-4 py-2.5">类型</th>
                <th className="px-4 py-2.5">所属池</th>
                <th className="px-4 py-2.5">时间</th>
                <th className="px-4 py-2.5 text-right">变动额</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t, idx) => {
                const label = LEDGER_ENTRY_LABELS[entryTypeOf(t)];
                return (
                  <tr
                    key={t.id}
                    data-testid="credits-history-row"
                    className={`border-b last:border-b-0 transition-colors hover:bg-secondary ${
                      idx % 2 === 1 ? "bg-secondary/50" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5 text-foreground">
                      {t.description ?? label}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {label}
                    </td>
                    <td data-testid="credits-history-pool" className="px-4 py-2.5 text-muted-foreground">
                      {poolLabelOf(t)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {formatDate(t.created_at)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      <span
                        className={
                          t.amount < 0
                            ? "font-medium text-destructive"
                            : "font-medium text-foreground"
                        }
                      >
                        {t.amount > 0 ? "+" : ""}
                        {t.amount}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Load more */}
      {hasMore && filtered.length > 0 && (
        <div className="flex justify-center pt-2">
          <button data-testid="credits-history-load-more"
            type="button"
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-50"
          >
            {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      )}

      {/* BL-06: end of list */}
      {!hasMore && filtered.length > 0 && (
        <p data-testid="credits-history-end" className="pt-2 text-center text-xs text-muted-foreground">
          没有更多了
        </p>
      )}
    </div>
  );
}
