"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";

import {
  applyCaret,
  caretRangeAtEnd,
  chipAfterCaret,
  chipBeforeCaret,
  currentRangeWithin,
  deleteAtQueryBeforeCaret,
  getChipRefIds,
  insertChipAt,
  insertPlainText,
  isRangeUsable,
  readTextBeforeCaret,
  removeChipByRefId,
  removeChipElement,
  serializeNode,
  type ComposerChip,
} from "./chat-composer-dom";

export type { ComposerChip };

/**
 * The chat input's editable surface: plain text with inline, atomic image chips.
 *
 * WHY contenteditable and not a textarea: a textarea can only hold text, so an
 * image reference could never sit *inside* the sentence. Position carries meaning
 * for multi-image prompts ("put a caterpillar on THIS apple, like THIS one"), so
 * the reference has to live at the caret.
 *
 * ── The rule that makes this safe ──
 * React must never own the DOM inside the editable element. The element is
 * rendered with NO children and all content is manipulated imperatively. If React
 * reconciled these nodes, any re-render during an IME composition (every Chinese
 * keystroke is one) would destroy and rebuild the text node the browser is
 * composing into — which swallows characters, duplicates them, or throws the
 * caret to the start. Hence: no `value` prop, no children, no state per keypress.
 *
 * All DOM mutation lives in chat-composer-dom.ts, which also documents the
 * structural invariant. This file is bindings and keyboard policy only.
 */

export type ChatComposerHandle = {
  /** Serialized content: text with chips rendered as `[图片:<refId>]` tokens. */
  getText: () => string;
  /** refIds of every chip currently in the text, in document order. */
  getChipRefIds: () => string[];
  clear: () => void;
  focus: () => void;
  /**
   * Insert a chip at the caret.
   *
   * `focus` defaults to false on purpose. This is called while the user is
   * clicking around on the CANVAS, and pulling focus into the chat box there
   * would break every canvas keyboard action — arrow-key nudging, Delete — for
   * the rest of the interaction. The insert still lands at the caret because the
   * caret position is remembered across losing focus.
   */
  insertChip: (chip: ComposerChip, opts?: { focus?: boolean }) => void;
  /**
   * Remove a chip by refId, together with the spacer that belongs to it.
   *
   * Exists so a reference that was only a *preview* of the canvas selection can
   * be withdrawn when that selection goes away. Removing by refId rather than by
   * node keeps the caller free of DOM knowledge.
   */
  removeChip: (refId: string) => void;
  /** Drop the trailing "@query" the mention picker consumed. */
  clearAtQuery: () => void;
  /** Drop the trailing "<char>query" (char = "@" or "/") the picker consumed. */
  clearTriggerQuery: (char: "@" | "/") => void;
};

type ChatComposerProps = {
  placeholder: string;
  disabled?: boolean;
  /** Fired after any content change, with the text before the caret. */
  onTextBeforeCaretChange?: (textBeforeCaret: string) => void;
  /** Fired when the content becomes empty / non-empty. */
  onEmptyChange?: (isEmpty: boolean) => void;
  onSubmit: () => void;
  /** Image files pasted into the editor. */
  onPasteFiles?: (files: File[]) => void;
  className?: string;
};

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(
  function ChatComposer(
    {
      placeholder,
      disabled,
      onTextBeforeCaretChange,
      onEmptyChange,
      onSubmit,
      onPasteFiles,
      className,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null);
    const wasEmptyRef = useRef(true);

    /**
     * Where the caret was the last time the user touched the editor.
     *
     * Chips are inserted while the editor is NOT focused — the user is clicking an
     * image on the canvas — and the live window selection then points into the
     * canvas, not here. Without a remembered position the only fallback is to
     * append, which is what made every chip land at the end of the sentence no
     * matter where the user meant it to go. Position is the entire reason for
     * using inline chips, so it has to survive losing focus.
     */
    const savedRangeRef = useRef<Range | null>(null);

    const rememberCaret = useCallback((range: Range | null) => {
      savedRangeRef.current = range ? range.cloneRange() : null;
    }, []);

    /** The best available insertion point: live caret, else remembered, else end. */
    const insertionRange = useCallback((el: HTMLDivElement): Range | null => {
      const live = currentRangeWithin(el);
      if (live) return live;
      const saved = savedRangeRef.current;
      return isRangeUsable(el, saved) ? saved : null;
    }, []);

    /**
     * Track the caret from `selectionchange` rather than from keyup/click.
     *
     * The caret moves for many reasons that are not a keyup on this element:
     * arrow keys, drag-selection, the context menu, an IME moving through a
     * candidate. Binding the memory to a few chosen events silently misses the
     * rest, and a missed update means the next chip is inserted at a stale
     * position. Ranges outside the editor are ignored, so clicking the canvas
     * cannot overwrite what we remembered.
     */
    useEffect(() => {
      const onSelectionChange = () => {
        const el = editorRef.current;
        if (!el) return;
        const live = currentRangeWithin(el);
        if (live) savedRangeRef.current = live.cloneRange();
      };
      document.addEventListener("selectionchange", onSelectionChange);
      return () => document.removeEventListener("selectionchange", onSelectionChange);
    }, []);

    const notifyState = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;

      const caret = currentRangeWithin(el);

      const isEmpty = serializeNode(el).trim().length === 0;
      if (isEmpty !== wasEmptyRef.current) {
        wasEmptyRef.current = isEmpty;
        // Only when the boolean actually flips: this is the one thing that
        // reaches React, and it must not happen on every keystroke.
        onEmptyChange?.(isEmpty);
      }

      onTextBeforeCaretChange?.(readTextBeforeCaret(el, caret));
    }, [onEmptyChange, onTextBeforeCaretChange]);

    useImperativeHandle(ref, () => ({
      getText: () => (editorRef.current ? serializeNode(editorRef.current) : ""),
      getChipRefIds: () => (editorRef.current ? getChipRefIds(editorRef.current) : []),
      clear: () => {
        const el = editorRef.current;
        if (!el) return;
        el.innerHTML = "";
        // The remembered range pointed into nodes that no longer exist.
        savedRangeRef.current = null;
        wasEmptyRef.current = true;
        onEmptyChange?.(true);
      },
      focus: () => editorRef.current?.focus(),
      insertChip: (chip, opts) => {
        const el = editorRef.current;
        if (!el) return;
        if (opts?.focus) el.focus();

        const caret = insertChipAt(el, chip, insertionRange(el));
        // Remember where the next insert should go, so a second image picked
        // after typing lands after the first one rather than back at the end.
        rememberCaret(caret);
        if (el.contains(document.activeElement)) applyCaret(caret);
        notifyState();
      },
      removeChip: (refId) => {
        const el = editorRef.current;
        if (!el) return;
        // Deliberately does NOT move the caret or the remembered position.
        //
        // This is the programmatic withdrawal of a preview, not the user deleting
        // something. Their caret may be halfway through a sentence, and dragging
        // the insertion point back to wherever the withdrawn chip happened to sit
        // sends the next image to the wrong place — which is exactly what put a
        // chip at the start of the sentence instead of at the caret.
        if (removeChipByRefId(el, refId)) notifyState();
      },
      clearAtQuery: () => {
        const el = editorRef.current;
        if (!el) return;
        deleteAtQueryBeforeCaret(el);
        notifyState();
      },
      clearTriggerQuery: (char) => {
        const el = editorRef.current;
        if (!el) return;
        deleteAtQueryBeforeCaret(el, char);
        notifyState();
      },
    }));

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        const el = editorRef.current;
        if (!el) return;

        // Enter during an IME composition confirms a candidate — it must NOT
        // send. `isComposing` is false on the keydown that opens the candidate
        // list in some IMEs, so keyCode 229 is checked as well.
        const composing =
          e.nativeEvent.isComposing || (e.nativeEvent as KeyboardEvent).keyCode === 229;
        if (e.key === "Enter" && !e.shiftKey && !composing) {
          e.preventDefault();
          onSubmit();
          return;
        }

        // Chrome swallows Backspace/Delete next to a contenteditable="false"
        // element instead of removing it, so the chip has to be deleted by hand.
        // Verified: pressing Backspace with the caret right after a chip left the
        // DOM untouched. Without this the only way to get rid of a chip was to
        // clear the whole box.
        if (e.key === "Backspace" || e.key === "Delete") {
          const range = currentRangeWithin(el);
          const chip =
            e.key === "Backspace" ? chipBeforeCaret(el, range) : chipAfterCaret(el, range);
          if (!chip) return;
          e.preventDefault();
          const caret = removeChipElement(el, chip);
          rememberCaret(caret);
          applyCaret(caret);
          notifyState();
        }
      },
      [notifyState, onSubmit, rememberCaret],
    );

    const handlePaste = useCallback(
      (e: React.ClipboardEvent) => {
        const files = Array.from(e.clipboardData.items)
          .filter((item) => item.type.startsWith("image/"))
          .map((item) => item.getAsFile())
          .filter((f): f is File => f !== null);
        if (files.length > 0 && onPasteFiles) {
          e.preventDefault();
          onPasteFiles(files);
          return;
        }
        // Always paste as PLAIN text: the default would inject foreign markup
        // (fonts, colours, whole tables) straight into the editor.
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        if (text) insertPlainText(text);
        notifyState();
      },
      [onPasteFiles, notifyState],
    );

    // Keep the placeholder in sync without React touching the editor's children.
    useEffect(() => {
      editorRef.current?.setAttribute("data-placeholder", placeholder);
    }, [placeholder]);

    // A click that lands on the padding rather than on text leaves the caret
    // wherever it was; anchor it to the end so the next chip is not misplaced.
    const handleFocus = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      if (!currentRangeWithin(el) && !isRangeUsable(el, savedRangeRef.current)) {
        rememberCaret(caretRangeAtEnd(el));
      }
    }, [rememberCaret]);

    return (
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label="输入消息"
        data-chat-input
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={notifyState}
        onKeyUp={notifyState}
        onClick={notifyState}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        style={{ scrollbarWidth: "none" }}
        className={
          "chat-composer min-h-[48px] max-h-60 overflow-y-auto whitespace-pre-wrap break-words px-1 text-sm leading-[1.8] text-foreground focus:outline-none [&::-webkit-scrollbar]:hidden " +
          (className ?? "")
        }
      />
    );
  },
);
