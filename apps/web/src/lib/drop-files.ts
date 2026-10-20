/**
 * AG-02: dropping files on the Agent panel.
 *
 * The panel is one big drop target, so these two predicates stay here instead of
 * inside the component — they are the only part of the drop path that can be
 * checked without a DOM.
 */

/** AG-02: which dropped files the chat accepts (same rule as the input box today: images only). */
export function acceptedDropFiles(files: readonly File[]): File[] {
  return files.filter((file) => file.type.startsWith("image/"));
}

/** AG-02: does this drag carry files at all (vs text / an element dragged from the canvas)? */
export function dragHasFiles(
  types: readonly string[] | DOMStringList | undefined,
): boolean {
  if (!types) return false;
  const entries: ArrayLike<string> = types;
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index] === "Files") return true;
  }
  return false;
}
