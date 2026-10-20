export type ComposerTrigger = { char: "@" | "/"; query: string };

const TRIGGER_CHARS = ["@", "/"] as const;

function candidateFor(
  text: string,
  char: "@" | "/",
): { idx: number; trigger: ComposerTrigger } | null {
  const idx = text.lastIndexOf(char);
  if (idx === -1) return null;

  // Only trigger if the char is at the start or preceded by whitespace.
  const charBefore = idx > 0 ? text[idx - 1] : " ";
  if (
    charBefore !== " " &&
    charBefore !== "\n" &&
    charBefore !== "\u00A0" &&
    idx !== 0
  ) {
    return null;
  }

  const query = text.slice(idx + 1);
  // Close once the run is finished.
  if (/[\s\u00A0]/.test(query)) return null;

  return { idx, trigger: { char, query } };
}

/** AG-02: which picker the text before the caret is asking for. "@" and "/" only count at the start or after whitespace, and close at the next whitespace. The LATER of the two wins. */
export function triggerBeforeCaret(textBeforeCaret: string): ComposerTrigger | null {
  let best: { idx: number; trigger: ComposerTrigger } | null = null;
  for (const char of TRIGGER_CHARS) {
    const c = candidateFor(textBeforeCaret, char);
    if (c && (!best || c.idx > best.idx)) best = c;
  }
  return best ? best.trigger : null;
}
