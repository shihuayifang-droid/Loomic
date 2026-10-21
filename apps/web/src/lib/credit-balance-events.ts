// @credits-system — GN-03: a job status carries the balance, so the top bar
// refreshes from the poll the caller already makes instead of calling the
// account route beside it.
//
// A module-level `Set` rather than a `window` event: the producer (`fetchJob`)
// and the consumer (`useCredits`) live in the same web bundle, and a window
// event would need `document` at import time, which the server render does not
// have.
import type { PoolBalancesResponse } from "@loomic/shared";

/**
 * The three-pool breakdown behind the one available-credit figure, exactly as
 * `GET /api/jobs/:jobId` carries it next to the job row (GN-03 / workorder 38D).
 */
export type PoolBalanceUpdate = {
  balances: PoolBalancesResponse;
  available: number;
};

type Listener = (update: PoolBalanceUpdate) => void;

const listeners = new Set<Listener>();

/**
 * Notifies every current subscriber synchronously.
 *
 * Iterates a copy so a listener that unsubscribes while being notified cannot
 * swallow the notification for the ones after it.
 */
export function publishPoolBalance(update: PoolBalanceUpdate): void {
  for (const listener of [...listeners]) {
    listener(update);
  }
}

/** Registers `listener`; the returned function unsubscribes it. */
export function subscribePoolBalance(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
