/**
 * The DOM layer behind ChatComposer: a contenteditable holding text with inline,
 * atomic image chips.
 *
 * WHY this is a separate module: the React component may not own the DOM inside
 * a contenteditable (see chat-composer.tsx for the IME reason), so every edit is
 * an imperative DOM mutation. Leaving those mutations scattered through event
 * handlers is what produced three separate bugs — chips that could not be
 * deleted, chips that always landed at the end of the sentence, and invisible
 * spacer nodes that made an empty box look non-empty. They were all the same
 * mistake: relying on the browser's default behaviour to maintain a structure
 * nobody had written down. So the structure is written down here, as one
 * invariant, with every operation that touches it in one place and unit-testable
 * without React.
 *
 * ── The invariant ──
 * The editor's child list contains only:
 *   1. Text nodes — what the user typed.
 *   2. Chip elements — span[data-chip-ref], contenteditable="false".
 * Every chip is followed by a text node starting with SPACER.
 *
 * WHY the spacer: a chip is contenteditable="false", so the caret cannot go
 * inside it. Without a text node after it there is nowhere to type once a chip
 * ends the line, and two adjacent chips have no position between them. The
 * spacer is therefore structural, not decoration — which is why removing a chip
 * has to remove it too, and why it is created here rather than by each caller.
 */

export const CHIP_ATTR = "data-chip-ref";

/**
 * NBSP, not a regular space.
 *
 * Verified the hard way: with a plain space Chrome treats a spacer at the end of
 * a line as collapsible whitespace, so Backspace skips straight past it to the
 * chip — which it also refuses to delete — and the keystroke does nothing at all.
 * NBSP is never collapsed, so the caret can sit on either side of it and deletion
 * behaves.
 *
 * It does not leak into the prompt: serializeNode turns it back into a plain
 * space.
 */
const SPACER = "\u00A0";

export type ComposerChip = {
  /** Stable id of the referenced thing, e.g. a canvas element id. */
  refId: string;
  /** Small thumbnail shown inside the chip. */
  thumbnailUrl: string;
  /** Short human label shown next to the thumbnail. */
  label: string;
};

/* ------------------------------------------------------------------ */
/*  Reading                                                            */
/* ------------------------------------------------------------------ */

/**
 * Serialize to text, turning chips into position-bearing tokens.
 *
 * Spacer NBSPs become plain spaces so the prompt that reaches the model contains
 * no U+00A0 — the editor needs NBSP, the message does not.
 */
export function serializeNode(root: Node): string {
  let out = "";
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replace(/\u00A0/g, " ");
      return;
    }
    if (!(node instanceof HTMLElement)) return;

    const refId = node.getAttribute(CHIP_ATTR);
    if (refId) {
      out += `[图片:${refId}]`;
      return;
    }
    // Browsers wrap lines in <div>/<br> inside contenteditable.
    if (node.tagName === "BR") {
      out += "\n";
      return;
    }
    if (node.tagName === "DIV" || node.tagName === "P") {
      if (out.length > 0 && !out.endsWith("\n")) out += "\n";
      out += serializeNode(node);
      return;
    }
    out += serializeNode(node);
  });
  return out;
}

/** refIds of every chip in the editor, in document order. */
export function getChipRefIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll(`[${CHIP_ATTR}]`)).map(
    (n) => n.getAttribute(CHIP_ATTR) ?? "",
  );
}

/**
 * Find a chip by refId.
 *
 * Matched by reading the attribute rather than with an attribute selector:
 * refIds come from canvas element ids and would otherwise need CSS escaping.
 */
export function findChipElement(root: HTMLElement, refId: string): HTMLElement | null {
  const found = Array.from(root.querySelectorAll(`[${CHIP_ATTR}]`)).find(
    (n) => n.getAttribute(CHIP_ATTR) === refId,
  );
  return (found as HTMLElement | undefined) ?? null;
}

function isChip(node: Node | null | undefined): node is HTMLElement {
  return node instanceof HTMLElement && node.hasAttribute(CHIP_ATTR);
}

/** Text from the start of the editor up to the caret, for @-mention detection. */
export function readTextBeforeCaret(root: HTMLElement, range: Range | null): string {
  if (!range) return serializeNode(root);

  const before = document.createRange();
  before.selectNodeContents(root);
  try {
    before.setEnd(range.endContainer, range.endOffset);
  } catch {
    return serializeNode(root);
  }
  return serializeNode(before.cloneContents());
}

/* ------------------------------------------------------------------ */
/*  Caret                                                             */
/* ------------------------------------------------------------------ */

/** The live caret, but only when it is actually inside this editor. */
export function currentRangeWithin(root: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range : null;
}

/**
 * Whether a remembered Range still points into the editor.
 *
 * A Range keeps live references to nodes and follows them through DOM edits, but
 * it goes stale when its container is removed — for example after clear(), or
 * after a chip the caret sat next to was withdrawn.
 */
export function isRangeUsable(root: HTMLElement, range: Range | null): boolean {
  if (!range) return false;
  return root.contains(range.startContainer) && root.contains(range.endContainer);
}

/** A collapsed range at the very end of the editor. */
export function caretRangeAtEnd(root: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

/** Move the window selection to `range`. */
export function applyCaret(range: Range): void {
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * If `node` is a chip's spacer text node and nothing else, return that chip.
 *
 * The spacer is structure this module inserted, not something the user typed, so
 * a Backspace landing on it should take the whole reference rather than make the
 * user delete a space they never wrote and then press again.
 */
function chipOwningSpacer(node: Node | null | undefined): HTMLElement | null {
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  if ((node.textContent ?? "") !== SPACER) return null;
  const prev = node.previousSibling;
  return isChip(prev) ? prev : null;
}

/**
 * The chip a Backspace at this caret should delete, if any.
 *
 * Chrome does NOT delete a contenteditable="false" element when Backspace is
 * pressed next to it — the keystroke is simply swallowed, which is why chips
 * appeared undeletable. The caret can sit in several places relative to the chip
 * it "belongs" to, so they are all resolved here rather than at the call site.
 */
export function chipBeforeCaret(root: HTMLElement, range: Range | null): HTMLElement | null {
  if (!range || !range.collapsed) return null;
  const { startContainer: container, startOffset: offset } = range;

  if (container.nodeType === Node.TEXT_NODE) {
    // Caret right after the chip, its spacer already gone.
    if (offset === 0) {
      const prev = container.previousSibling;
      return isChip(prev) ? prev : null;
    }
    // Caret just past the spacer and nothing else in this node.
    if (offset === 1) return chipOwningSpacer(container);
    // Mid-text: there is a real character to delete, leave it to the browser.
    return null;
  }

  if (container === root || root.contains(container)) {
    if (offset === 0) return null;
    const prev = container.childNodes[offset - 1];
    if (isChip(prev)) return prev;
    // Caret after a lone spacer, expressed as a child offset of the editor.
    return chipOwningSpacer(prev);
  }
  return null;
}

/** The chip immediately after a collapsed caret, if any — for the Delete key. */
export function chipAfterCaret(root: HTMLElement, range: Range | null): HTMLElement | null {
  if (!range || !range.collapsed) return null;
  const { endContainer: container, endOffset: offset } = range;

  if (container.nodeType === Node.TEXT_NODE) {
    if (offset < (container.textContent?.length ?? 0)) return null;
    const next = container.nextSibling;
    return isChip(next) ? next : null;
  }

  if (container === root || root.contains(container)) {
    const next = container.childNodes[offset];
    if (isChip(next)) return next;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Writing                                                           */
/* ------------------------------------------------------------------ */

export function createChipElement(chip: ComposerChip): HTMLElement {
  const span = document.createElement("span");
  span.setAttribute(CHIP_ATTR, chip.refId);
  span.setAttribute("contenteditable", "false");
  span.className =
    "mx-0.5 inline-flex max-w-[160px] translate-y-[2px] items-center gap-1 rounded-md border border-border bg-muted px-1 py-0.5 align-middle text-[12px] leading-none text-foreground";

  const img = document.createElement("img");
  img.src = chip.thumbnailUrl;
  img.alt = "";
  img.className = "h-4 w-4 shrink-0 rounded object-cover";
  span.appendChild(img);

  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = chip.label;
  span.appendChild(label);

  return span;
}

/**
 * Drop the lone <br> Chrome puts in an empty contenteditable as a caret
 * placeholder.
 *
 * Left in place it becomes a real line break the moment anything is appended, so
 * the first chip renders on line two of an otherwise empty box.
 */
function prunePlaceholderBr(root: HTMLElement): void {
  if (root.childNodes.length === 1 && root.firstChild?.nodeName === "BR") {
    root.removeChild(root.firstChild);
  }
}

/**
 * Insert a chip at `range` (or at the end when there is none) and return the
 * caret position that follows it.
 *
 * The returned range is NOT applied to the window selection. Chips are inserted
 * while the user is clicking on the canvas, and moving the real caret there would
 * pull focus out of the canvas and break its keyboard actions. The caller decides
 * whether to apply it.
 */
export function insertChipAt(
  root: HTMLElement,
  chip: ComposerChip,
  range: Range | null,
): Range {
  prunePlaceholderBr(root);

  const node = createChipElement(chip);
  const at = range && isRangeUsable(root, range) ? range.cloneRange() : caretRangeAtEnd(root);

  at.deleteContents();
  at.insertNode(node);

  const spacer = document.createTextNode(SPACER);
  node.parentNode?.insertBefore(spacer, node.nextSibling);

  const after = document.createRange();
  after.setStart(spacer, spacer.length);
  after.collapse(true);
  return after;
}

/**
 * Remove a chip and the spacer that belongs to it, returning where the caret
 * should land.
 *
 * Only the single spacer character is removed, not the whole following text
 * node: by the time a chip is deleted the user may well have typed after it.
 */
export function removeChipElement(root: HTMLElement, chip: HTMLElement): Range {
  const next = chip.nextSibling;
  if (
    next &&
    next.nodeType === Node.TEXT_NODE &&
    (next.textContent ?? "").startsWith(SPACER)
  ) {
    const text = next as Text;
    if (text.length === 1) {
      text.parentNode?.removeChild(text);
    } else {
      text.deleteData(0, 1);
    }
  }

  const caret = document.createRange();
  const anchor = chip.previousSibling;
  chip.remove();

  if (anchor && anchor.nodeType === Node.TEXT_NODE) {
    caret.setStart(anchor, (anchor.textContent ?? "").length);
  } else if (anchor) {
    caret.setStartAfter(anchor);
  } else if (root.firstChild) {
    caret.setStart(root, 0);
  } else {
    caret.selectNodeContents(root);
  }
  caret.collapse(true);
  return caret;
}

/** Remove a chip by refId. Returns the caret position, or null if not found. */
export function removeChipByRefId(root: HTMLElement, refId: string): Range | null {
  const chip = findChipElement(root, refId);
  return chip ? removeChipElement(root, chip) : null;
}

export function insertPlainText(text: string): void {
  // execCommand is deprecated but remains the only way to insert text while
  // preserving the browser's native undo stack; Range-based insertion breaks
  // Ctrl+Z inside contenteditable.
  const ok = document.execCommand?.("insertText", false, text);
  if (ok) return;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  applyCaret(range);
}

/**
 * Remove the "@query" run immediately before the caret. Used after the mention
 * picker consumes it, so the typed "@app" does not linger next to the chip.
 */
export function deleteAtQueryBeforeCaret(root: HTMLElement): void {
  const range = currentRangeWithin(root);
  if (!range || range.endContainer.nodeType !== Node.TEXT_NODE) return;

  const textNode = range.endContainer as Text;
  const upToCaret = (textNode.textContent ?? "").slice(0, range.endOffset);
  const atIdx = upToCaret.lastIndexOf("@");
  if (atIdx === -1) return;

  const del = document.createRange();
  del.setStart(textNode, atIdx);
  del.setEnd(textNode, range.endOffset);
  del.deleteContents();

  del.collapse(true);
  applyCaret(del);
}
