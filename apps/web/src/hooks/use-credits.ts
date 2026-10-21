// @credits-system — React hook for credit balance, daily claim, and auto-refresh on focus
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CreditBalanceResponse } from "@loomic/shared";
import { useAuth } from "@/lib/auth-context";
import { fetchCredits, claimDailyCredits } from "@/lib/credits-api";

interface UseCreditsReturn {
  balance: number;
  /**
   * BL-45 / workorder 38J: the three-pool breakdown behind the one `balance`
   * figure, when the server sent one (switch on + a team workspace). `null`
   * means "no pools to read" — either the switch is off (no `pools` key) or the
   * caller has no team workspace (`pools: null`). Read by the account summary.
   */
  pools: CreditBalanceResponse["pools"] | null;
  plan: string;
  dailyClaimed: boolean;
  limits: CreditBalanceResponse["limits"] | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  claimDaily: () => Promise<boolean>;
}

export function useCredits(): UseCreditsReturn {
  const { session } = useAuth();
  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;

  const [data, setData] = useState<CreditBalanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) return;
    try {
      const result = await fetchCredits(token);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch credits");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    if (!session?.access_token) {
      setLoading(false);
      return;
    }
    refresh();
  }, [session?.access_token, refresh]);

  // Auto-refresh on window focus
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [refresh]);

  const claimDaily = useCallback(async (): Promise<boolean> => {
    const token = accessTokenRef.current;
    if (!token) return false;
    try {
      const result = await claimDailyCredits(token);
      if (result.success) {
        await refresh();
        return true;
      }
      setError(result.message ?? "Claim failed");
      return false;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to claim daily credits",
      );
      return false;
    }
  }, [refresh]);

  return {
    // BL-45: one available-credit figure everywhere. When the server carries the
    // three pools, `pools.available` IS the available-credit number; the old
    // `balance` is only the fallback for a response without pools (switch off or
    // no team workspace).
    balance: data?.pools?.available ?? data?.balance ?? 0,
    pools: data?.pools ?? null,
    plan: data?.plan ?? "free",
    dailyClaimed: data?.dailyClaimed ?? false,
    limits: data?.limits ?? null,
    loading,
    error,
    refresh,
    claimDaily,
  };
}
