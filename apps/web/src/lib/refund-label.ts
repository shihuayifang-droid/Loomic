/**
 * CV-02 / GN-35: the failed-slot line about money.
 *
 * The number is `credits_refunded` from `GET /api/jobs/:jobId/credits`, not
 * `credits_cost`. A failed job that was never billed (or whose refund has been
 * decided but not written yet) refunds 0, and telling the user "已退回 N 积分"
 * off the price would be promising money that did not move. So: only a refund
 * that actually landed is announced, and everything else — 0, a missing payload,
 * a read that failed — stays silent rather than guessing.
 */
export function refundLabel(
  credits: { credits_refunded: number } | null | undefined,
): string | null {
  const refunded = credits?.credits_refunded ?? 0;
  // `!(x > 0)` also drops NaN, which a malformed response could carry.
  if (!(refunded > 0)) return null;
  return `已退回 ${refunded} 积分`;
}
