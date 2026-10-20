import { beforeEach, describe, expect, it } from "vitest";

import {
  CHIP_ATTR,
  caretRangeAtEnd,
  chipAfterCaret,
  chipBeforeCaret,
  getChipRefIds,
  insertChipAt,
  removeChipByRefId,
  removeChipElement,
  serializeNode,
  type ComposerChip,
} from "../src/components/chat-composer-dom";

const chip = (refId: string): ComposerChip => ({
  refId,
  thumbnailUrl: `https://example.com/${refId}.png`,
  label: "图片",
});

let editor: HTMLDivElement;

beforeEach(() => {
  document.body.innerHTML = "";
  editor = document.createElement("div");
  editor.contentEditable = "true";
  document.body.appendChild(editor);
});

/** Collapsed range inside a text node, `offset` characters in. */
function caretIn(node: Node, offset: number): Range {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  return r;
}

function findChip(refId: string): HTMLElement {
  const el = editor.querySelector(`[${CHIP_ATTR}="${refId}"]`);
  if (!el) throw new Error(`chip ${refId} not found`);
  return el as HTMLElement;
}

describe("insertChipAt", () => {
  it("★ inserts at the given caret, not at the end", () => {
    const text = document.createTextNode("给这张图加眼睛");
    editor.appendChild(text);

    // Caret after "给" — the chip belongs there, mid-sentence.
    insertChipAt(editor, chip("a"), caretIn(text, 1));

    expect(serializeNode(editor)).toBe("给[图片:a] 这张图加眼睛");
  });

  it("★ pick image, type, pick a second image mid-sentence", () => {
    // The reported ordering bug, as the user described it. The second pick
    // happens with the caret parked inside the sentence, not at its end —
    // otherwise "insert at the caret" and "append" look identical and the test
    // proves nothing.
    const first = insertChipAt(editor, chip("a"), null);

    const typed = document.createTextNode("把这张图加两个眼睛，类似这张图");
    first.insertNode(typed);

    // Caret after "类似", i.e. before "这张图".
    const midSentence = caretIn(typed, "把这张图加两个眼睛，类似".length);
    insertChipAt(editor, chip("b"), midSentence);

    expect(getChipRefIds(editor)).toEqual(["a", "b"]);
    expect(serializeNode(editor)).toBe(
      "[图片:a] 把这张图加两个眼睛，类似[图片:b] 这张图",
    );
  });

  it("appends when there is no usable caret", () => {
    editor.appendChild(document.createTextNode("hello"));
    insertChipAt(editor, chip("a"), null);
    expect(serializeNode(editor)).toBe("hello[图片:a] ");
  });

  it("ignores a stale range whose nodes are gone", () => {
    const orphan = document.createElement("div");
    const gone = document.createTextNode("detached");
    orphan.appendChild(gone);

    insertChipAt(editor, chip("a"), caretIn(gone, 4));

    expect(getChipRefIds(editor)).toEqual(["a"]);
  });

  it("drops the browser's placeholder <br> so the chip is not pushed to line two", () => {
    editor.appendChild(document.createElement("br"));

    insertChipAt(editor, chip("a"), null);

    expect(editor.querySelector("br")).toBeNull();
    expect(serializeNode(editor)).toBe("[图片:a] ");
  });

  it("reports a caret that sits after the chip's spacer", () => {
    const caret = insertChipAt(editor, chip("a"), null);
    const typed = document.createTextNode("X");
    caret.insertNode(typed);

    expect(serializeNode(editor)).toBe("[图片:a] X");
  });
});

describe("chipBeforeCaret", () => {
  it("★ one Backspace at the end of a fresh chip takes the whole reference", () => {
    // The caret the insert reports sits just past the spacer. This is the very
    // position the user is in after picking an image, so it must be the one that
    // works — pressing Backspace here used to do nothing at all.
    insertChipAt(editor, chip("a"), null);
    const spacer = findChip("a").nextSibling as Text;

    expect(chipBeforeCaret(editor, caretIn(spacer, 1))).toBe(findChip("a"));
  });

  it("★ finds the chip when the caret is a child offset of the editor", () => {
    // How the browser reports the caret after selectNodeContents+collapse, i.e.
    // when focus is restored programmatically rather than by clicking.
    insertChipAt(editor, chip("a"), null);

    const r = document.createRange();
    r.setStart(editor, 2); // after chip + spacer
    r.collapse(true);

    expect(chipBeforeCaret(editor, r)).toBe(findChip("a"));
  });

  it("finds the chip when the caret sits at the start of the following text", () => {
    insertChipAt(editor, chip("a"), null);
    const spacer = findChip("a").nextSibling as Text;
    spacer.deleteData(0, 1);

    expect(chipBeforeCaret(editor, caretIn(spacer, 0))).toBeTruthy();
  });

  it("returns null mid-text so the browser deletes the character", () => {
    const text = document.createTextNode("abc");
    editor.appendChild(text);
    expect(chipBeforeCaret(editor, caretIn(text, 2))).toBeNull();
  });

  it("★ returns null once the user has typed after the chip", () => {
    // Deleting the reference instead of the last typed character would be
    // destructive and impossible to predict.
    const caret = insertChipAt(editor, chip("a"), null);
    const typed = document.createTextNode("眼睛");
    caret.insertNode(typed);

    expect(chipBeforeCaret(editor, caretIn(typed, typed.length))).toBeNull();
  });

  it("returns null for a non-collapsed range", () => {
    insertChipAt(editor, chip("a"), null);
    const r = document.createRange();
    r.selectNodeContents(editor);
    expect(chipBeforeCaret(editor, r)).toBeNull();
  });
});

describe("chipAfterCaret", () => {
  it("finds the chip the caret sits in front of", () => {
    insertChipAt(editor, chip("a"), null);
    const r = document.createRange();
    r.setStart(editor, 0);
    r.collapse(true);
    expect(chipAfterCaret(editor, r)).toBe(findChip("a"));
  });

  it("returns null when text follows the caret", () => {
    const text = document.createTextNode("abc");
    editor.appendChild(text);
    expect(chipAfterCaret(editor, caretIn(text, 1))).toBeNull();
  });
});

describe("removeChipElement", () => {
  it("★ removes the chip and its spacer, leaving the box truly empty", () => {
    insertChipAt(editor, chip("a"), null);

    removeChipElement(editor, findChip("a"));

    expect(getChipRefIds(editor)).toEqual([]);
    // A leftover spacer would keep the composer looking non-empty and keep the
    // send button enabled with nothing to send.
    expect(serializeNode(editor).trim()).toBe("");
  });

  it("★ keeps text the user typed after the chip", () => {
    const caret = insertChipAt(editor, chip("a"), null);
    caret.insertNode(document.createTextNode("加眼睛"));

    removeChipElement(editor, findChip("a"));

    expect(serializeNode(editor)).toBe("加眼睛");
  });

  it("leaves neighbouring chips alone", () => {
    const first = insertChipAt(editor, chip("a"), null);
    insertChipAt(editor, chip("b"), first);

    removeChipByRefId(editor, "b");

    expect(getChipRefIds(editor)).toEqual(["a"]);
  });

  it("returns null for an unknown refId", () => {
    expect(removeChipByRefId(editor, "nope")).toBeNull();
  });

  it("returns a caret positioned where the chip was", () => {
    editor.appendChild(document.createTextNode("ab"));
    const caret = insertChipAt(editor, chip("a"), caretRangeAtEnd(editor));
    caret.insertNode(document.createTextNode("cd"));

    const after = removeChipElement(editor, findChip("a"));

    expect(after.collapsed).toBe(true);
    expect(after.startContainer.textContent).toBe("ab");
    expect(after.startOffset).toBe(2);
  });
});

describe("serializeNode", () => {
  it("renders chips as position-bearing tokens", () => {
    const text = document.createTextNode("前后");
    editor.appendChild(text);
    insertChipAt(editor, chip("a"), caretIn(text, 1));

    expect(serializeNode(editor)).toBe("前[图片:a] 后");
  });

  it("★ serializes the NBSP spacer as a plain space", () => {
    // The editor needs NBSP (a plain space is collapsible and breaks Backspace);
    // the prompt sent to the model should not carry U+00A0.
    insertChipAt(editor, chip("a"), null);
    expect((findChip("a").nextSibling as Text).textContent).toBe("\u00A0");
    expect(serializeNode(editor)).not.toContain("\u00A0");
    expect(serializeNode(editor)).toBe("[图片:a] ");
  });

  it("turns <br> into a newline", () => {
    editor.appendChild(document.createTextNode("a"));
    editor.appendChild(document.createElement("br"));
    editor.appendChild(document.createTextNode("b"));
    expect(serializeNode(editor)).toBe("a\nb");
  });
});

describe("createChipElement", () => {
  it("AG-03: a canvas chip is an agent-mention-capsule of kind shape", () => {
    insertChipAt(editor, chip("a"), null);

    const el = findChip("a");

    expect(el.getAttribute("data-testid")).toBe("agent-mention-capsule");
    expect(el.getAttribute("data-kind")).toBe("shape");
    // The chip contract itself is unchanged: chips are still keyed by CHIP_ATTR.
    expect(el.getAttribute(CHIP_ATTR)).toBe("a");
    expect(el.getAttribute("contenteditable")).toBe("false");
  });
});
