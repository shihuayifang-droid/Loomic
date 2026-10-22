// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HomePrompt, type HomePromptHandle } from "@/components/home-prompt";

describe("AG-02 home prompt on the shared composer", () => {
  afterEach(() => {
    cleanup();
  });

  it("AG-02: the home input is the large composer", () => {
    render(<HomePrompt onSubmit={vi.fn()} />);

    const input = screen.getByTestId("home-prompt-input");
    expect(input.getAttribute("role")).toBe("textbox");
    expect(input.getAttribute("contenteditable")).toBe("true");
    expect(input.className).toContain("min-h-[56px]");
  });

  it("AG-02: fill puts the text in and enables submit", () => {
    const ref = createRef<HomePromptHandle>();
    const onSubmit = vi.fn();
    render(<HomePrompt ref={ref} onSubmit={onSubmit} />);

    const submit = screen.getByTestId("home-prompt-submit");
    expect(submit).toBeDisabled();

    act(() => {
      ref.current?.fill("一张海报");
    });

    expect(screen.getByTestId("home-prompt-input").textContent).toBe("一张海报");
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toBe("一张海报");
    expect(screen.getByTestId("home-prompt-input").textContent).toBe("");
  });

  it("AG-02: an empty home input cannot be submitted", () => {
    const onSubmit = vi.fn();
    render(<HomePrompt onSubmit={onSubmit} />);

    const submit = screen.getByTestId("home-prompt-submit");
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
