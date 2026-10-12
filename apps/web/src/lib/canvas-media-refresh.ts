// X-52: what to do when a canvas media URL stops working.
//
// Signed URLs expire. When the browser fails to load one, the fix is to re-read
// the canvas so the server projects FRESH signatures — never to retry the same
// dead URL, and never to fall back to a public address.
//
// The two failure modes this module exists to prevent are loops in opposite
// directions:
//
//   * asking again and again for a URL that is already known bad (a 403 storm);
//   * locking the tab out of refreshing forever after the first failure, so a
//     genuinely expired session can never recover.
//
// So the unit of deduplication is the FAILED URL, not the canvas and not "has
// this tab refreshed yet": the same dead URL asks at most once, while a URL that
// arrives later from a successful refresh is a different string and is therefore
// allowed to ask once of its own.
//
// Deliberately DOM-free: the components pass in a callback, and the tests drive
// it directly.

export type MediaRefreshOutcome = "refreshed" | "ignored";

export type CanvasMediaRefresh = {
  /**
   * Report that `url` failed to load. `refresh` re-reads the canvas and writes
   * the new projection into the scene.
   *
   * Resolves `"refreshed"` when this call was the one that asked for a refresh,
   * `"ignored"` when this URL had already asked (or was empty).
   */
  reportFailure(
    url: string | undefined | null,
    refresh: () => Promise<void> | void,
  ): Promise<MediaRefreshOutcome>;

  /** Whether this URL has already asked for a refresh. */
  hasAsked(url: string): boolean;

  /** Forget a URL — used when a fresh projection replaces it. */
  forget(url: string): void;
};

export function createCanvasMediaRefresh(): CanvasMediaRefresh {
  /** URLs that have already triggered a refresh. Never grows unbounded in
   *  practice: it holds one dead URL per media element until the page reloads. */
  const asked = new Set<string>();

  /**
   * Refreshes run one at a time. Two expired images usually fail in the same
   * tick, and firing two full canvas reads for them would double the work for
   * one fix; serialising also means the second refresh sees the first one's
   * result instead of racing it.
   */
  let queue: Promise<unknown> = Promise.resolve();

  return {
    async reportFailure(url, refresh) {
      if (!url || asked.has(url)) return "ignored";

      asked.add(url);
      queue = queue.then(refresh).catch(() => {
        // A failed refresh must not reject this chain: the URL stays marked as
        // asked, so it cannot start a loop, and the caller decides what to show.
      });
      await queue;

      return "refreshed";
    },

    hasAsked(url) {
      return asked.has(url);
    },

    forget(url) {
      asked.delete(url);
    },
  };
}

/**
 * Whether a URL is one of ours (a storage URL) rather than, say, a provider CDN
 * link that happened to fail. Only ours can be fixed by re-reading the canvas.
 */
export function isStorageMediaUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return url.includes("/storage/v1/object/") || url.includes("/storage/v1/render/image/");
}
