// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ChatInput pulls in model selectors that fetch from the server; they are not
// what is under test (the Esc / trigger bookkeeping is), so stub them out.
vi.mock("@/components/agent-model-selector", () => ({
  AgentModelSelector: () => null,
}));
vi.mock("../src/components/agent-model-selector", () => ({
  AgentModelSelector: () => null,
}));
vi.mock("../src/components/image-model-preference", () => ({
  ImageModelPreferencePopover: () => null,
}));
vi.mock("../src/hooks/use-image-model-preference", () => ({
  useImageModelPreference: () => ({ preference: { mode: "auto" } }),
}));
vi.mock("../src/hooks/use-video-model-preference", () => ({
  useVideoModelPreference: () => ({ preference: { mode: "auto" } }),
}));

import { ChatInput } from "../src/components/chat-input";

/** Put `text` in the editor with the caret at its end, then fire an input event. */
function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  fireEvent.input(editor);
}

function pressEscape(editor: HTMLElement) {
  fireEvent.keyDown(editor, { key: "Escape" });
  fireEvent.keyUp(editor, { key: "Escape" });
}

function setup() {
  const onAtQuery = vi.fn();
  const onSlashQuery = vi.fn();
  render(
    <ChatInput onSend={vi.fn()} onAtQuery={onAtQuery} onSlashQuery={onSlashQuery} />,
  );
  const editor = screen.getByRole("textbox");
  return { editor, onAtQuery, onSlashQuery };
}

const nonNullCalls = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.filter((c) => c[0] !== null);

describe("AG-02: Esc closes the @ and / lists and keyup does not reopen them", () => {
  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
  });

  it("/ : Esc keeps the list closed and the text intact; typing on reopens it", () => {
    const { editor, onSlashQuery } = setup();

    typeInto(editor, "/");
    expect(onSlashQuery).toHaveBeenLastCalledWith("");

    onSlashQuery.mockClear();
    pressEscape(editor);
    expect(nonNullCalls(onSlashQuery)).toEqual([]);
    expect(editor.textContent).toBe("/");

    typeInto(editor, "/a");
    expect(onSlashQuery).toHaveBeenLastCalledWith("a");
  });

  it("@ : Esc keeps the list closed and the text intact; typing on reopens it", () => {
    const { editor, onAtQuery } = setup();

    typeInto(editor, "@");
    expect(onAtQuery).toHaveBeenLastCalledWith("");

    onAtQuery.mockClear();
    pressEscape(editor);
    expect(nonNullCalls(onAtQuery)).toEqual([]);
    expect(editor.textContent).toBe("@");

    typeInto(editor, "@a");
    expect(onAtQuery).toHaveBeenLastCalledWith("a");
  });

  it("/ with a longer query: Esc keeps the typed characters and stays closed", () => {
    const { editor, onSlashQuery } = setup();

    typeInto(editor, "/品牌");
    expect(onSlashQuery).toHaveBeenLastCalledWith("品牌");

    onSlashQuery.mockClear();
    pressEscape(editor);
    expect(nonNullCalls(onSlashQuery)).toEqual([]);
    expect(editor.textContent).toBe("/品牌");
  });
});