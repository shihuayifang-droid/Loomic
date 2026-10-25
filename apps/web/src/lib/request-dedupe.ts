// T-165 / 45CV: the same read endpoint can be asked for twice in one render pass
// (the sidebar and the page/auth gate each read `/api/viewer` and `/api/credits`).
// `dedupeRequest` collapses those into one underlying call, and keeps the successful
// result for a short TTL so the second caller still does not turn into a second
// network request after the first one has settled.
//
// Rules:
// - the key is the caller's own key. A read whose answer depends on who is asking
//   (viewer, credits) must put the identity in the key, so two tokens never share
//   one response — a shared key would answer caller B out of caller A's result;
// - failures are never cached — a 401 must stay a 401 for the next caller;
// - `ttlMs <= 0` disables the settled cache and leaves in-flight dedupe only. Such
//   a call also ignores (and drops) a result an earlier call left behind under the
//   same key, so switching an endpoint to `ttlMs: 0` cannot keep serving stale data.

const DEFAULT_TTL_MS = 5000;

type Settled = { value: unknown; expiresAt: number };

const inflight = new Map<string, Promise<unknown>>();
const settled = new Map<string, Settled>();

/** Drops every in-flight entry and every cached result. */
export function clearRequestDedupeCache(): void {
  inflight.clear();
  settled.clear();
}

/**
 * Same key: concurrent calls share one Promise, and a result younger than `ttlMs`
 * is reused without running `run` again. A rejection is passed to every waiter and
 * cached nowhere. `ttlMs <= 0` keeps the concurrent sharing, nothing else.
 */
export function dedupeRequest<T>(
  key: string,
  run: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const hit = settled.get(key);
  if (hit) {
    if (ttlMs > 0 && hit.expiresAt > Date.now()) {
      return Promise.resolve(hit.value as T);
    }
    settled.delete(key);
  }

  let started: Promise<T>;
  try {
    // called synchronously so the key is in-flight before the caller can await
    started = Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error);
  }

  const promise: Promise<T> = started.then(
    (value) => {
      inflight.delete(key);
      if (ttlMs > 0) {
        settled.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    },
    (error: unknown) => {
      inflight.delete(key);
      throw error;
    },
  );

  inflight.set(key, promise);
  return promise;
}
