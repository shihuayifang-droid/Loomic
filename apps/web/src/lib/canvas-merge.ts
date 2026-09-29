/**
 * The one definition of "combine two versions of a canvas".
 *
 * Needed in two places that arrive at the same problem from opposite directions:
 *
 *   - draft recovery: a stranded local draft vs. what the server has now
 *   - save conflict (409): our content vs. the newer content someone else wrote
 *
 * Both are "two element lists, same canvas, neither is authoritative". Having one
 * implementation means the tradeoff below is decided once instead of drifting.
 *
 * THE TRADEOFF (deliberate, and it is a tradeoff)
 * Union by id, with `preferred` winning on collisions. NOT a replace.
 *
 * The cost: a deletion that failed to save comes back, because "in theirs, not in
 * ours" cannot be distinguished from "added elsewhere after we read". The reason
 * we accept it: resurrecting a deleted element is visible and one click to fix,
 * while dropping an element someone just created is silent and unrecoverable —
 * and that silent version is exactly the bug this whole change exists to kill.
 */

export interface MergeableContent {
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, Record<string, unknown>>;
}

/** Union of two element lists by id; entries from `preferred` win. */
export function mergeElementsById(
  base: readonly Record<string, unknown>[],
  preferred: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const el of base) {
    const id = el?.id;
    if (typeof id === "string") byId.set(id, el);
  }
  for (const el of preferred) {
    const id = el?.id;
    if (typeof id === "string") byId.set(id, el);
  }
  return [...byId.values()];
}

/**
 * Merges the content we were trying to save with the content the server actually
 * has, keeping ours on collisions.
 *
 * `appState` is taken from ours alone: it is viewport and selection, i.e. this
 * user's own view, and adopting someone else's would scroll the canvas out from
 * under them.
 *
 * `files` is a union with ours winning. A file record must never be dropped just
 * because it is absent from one side — an element referencing a missing file
 * renders as a broken image.
 */
export function mergeCanvasContent(
  ours: MergeableContent,
  theirs: MergeableContent,
): MergeableContent {
  return {
    elements: mergeElementsById(theirs.elements ?? [], ours.elements ?? []),
    appState: ours.appState,
    files: { ...(theirs.files ?? {}), ...(ours.files ?? {}) },
  };
}
