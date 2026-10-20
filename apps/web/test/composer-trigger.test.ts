import { beforeEach, describe, expect, it } from "vitest";

import { deleteAtQueryBeforeCaret } from "../src/components/chat-composer-dom";
import { triggerBeforeCaret } from "../src/lib/composer-trigger";

describe("triggerBeforeCaret", () => {
  it("recognises @ at the start", () => {
    expect(triggerBeforeCaret("@ap")).toEqual({ char: "@", query: "ap" });
  });

  it("recognises / after whitespace", () => {
    expect(triggerBeforeCaret("做一张 /pos")).toEqual({ char: "/", query: "pos" });
  });

  it("recognises a bare /", () => {
    expect(triggerBeforeCaret("/")).toEqual({ char: "/", query: "" });
  });

  it("ignores / not preceded by whitespace", () => {
    expect(triggerBeforeCaret("a/b")).toBeNull();
  });

  it("closes once whitespace appears in the query", () => {
    expect(triggerBeforeCaret("/pos ter")).toBeNull();
  });

  it("the later trigger wins", () => {
    expect(triggerBeforeCaret("@x /y")).toEqual({ char: "/", query: "y" });
  });

  it("ignores slashes inside URLs", () => {
    expect(triggerBeforeCaret("https://a.com/x")).toBeNull();
  });
});

describe("deleteAtQueryBeforeCaret", () => {
  let editor: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    editor = document.createElement("div");
    editor.contentEditable = "true";
    document.body.appendChild(editor);
  });

  function placeCaretAtEnd(text: string): void {
    const node = document.createTextNode(text);
    editor.appendChild(node);
    const range = document.createRange();
    range.setStart(node, text.length);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  it("deletes the /query run when char is '/'", () => {
    placeCaretAtEnd("做一张 /pos");
    deleteAtQueryBeforeCaret(editor, "/");
    expect(editor.textContent).toBe("做一张 ");
  });

  it("defaults to @ when no char is passed", () => {
    placeCaretAtEnd("看 @app");
    deleteAtQueryBeforeCaret(editor);
    expect(editor.textContent).toBe("看 ");
  });
});
