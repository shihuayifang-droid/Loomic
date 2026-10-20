"use client";

import { useEffect, useState } from "react";

import { refundLabel } from "../lib/refund-label";
import { fetchJobCredits } from "../lib/server-api";

/**
 * GN-35: how much a dead job actually gave back, for CV-02's failed placeholder.
 *
 * The failed slot on the canvas only knows the `jobId` the server stamped on the
 * element, so this hook is the one place that asks the credits route. It reads
 * once per (token, job) pair — a refund is a fact about a finished job, not a
 * live number worth polling.
 *
 * A failed read stays null on purpose: the placeholder already says the
 * generation failed, and inventing an amount from `credits_cost` would turn
 * "we could not check" into a promise. Anything that arrives after unmount (or
 * after `jobId` changed) is dropped, so a slow response cannot paint a refund
 * line onto a different slot.
 */
export function useJobRefundLabel(
  accessToken: string,
  jobId?: string,
): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    // No job (or no token yet) means nothing to announce.
    setLabel(null);
    if (!accessToken || !jobId) return;

    let cancelled = false;
    fetchJobCredits(accessToken, jobId)
      .then((credits) => {
        if (cancelled) return;
        setLabel(refundLabel(credits));
      })
      .catch(() => {
        if (cancelled) return;
        setLabel(null);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, jobId]);

  return label;
}
