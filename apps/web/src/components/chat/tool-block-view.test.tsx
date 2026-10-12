// @vitest-environment jsdom
//
// X-52 (工单14 fixup2): what the chat renders for a tool artifact that HAS an
// identity but NO url this read.
//
// `chat-service.projectBlockUrls()` drops the url of an artifact whose asset the
// caller may not read (or whose signature the signer refused) and answers with
// the stable artifact instead. The ticket's rule is that this is a legal answer,
// so the view must not invent a preview for it: no `<img>`/`<video>` built from
// an absent url, no fallback to the stale url still sitting in the row, and no
// pretending `assetId` is a URL. A safe "currently unavailable" line is the
// honest rendering. The url-carrying and legacy url-only shapes must render
// exactly as before.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolBlock } from "@loomic/shared";

import { ToolBlockView } from "./tool-block-view";

const SIGNED =
  "https://proj.test/storage/v1/object/sign/project-assets/ws-team/p/a.png?token=fresh";
const STALE =
  "https://proj.test/storage/v1/object/sign/project-assets/ws-team/p/a.png?token=stale";

function toolBlock(
  toolName: string,
  artifacts: ToolBlock["artifacts"],
): ToolBlock {
  return {
    type: "tool",
    toolCallId: "call-1",
    toolName,
    status: "completed",
    output: { summary: "done" },
    outputSummary: "done",
    artifacts,
  };
}

/** The same shape the server returns when it cannot project a url. */
const STABLE_IMAGE = {
  type: "image" as const,
  assetId: "asset-locked",
  objectPath: "ws-team/p/secret.png",
  mimeType: "image/png",
  width: 512,
  height: 512,
};

const STABLE_VIDEO = {
  type: "video" as const,
  assetId: "asset-locked-video",
  objectPath: "ws-team/p/secret.mp4",
  mimeType: "video/mp4",
  width: 1280,
  height: 720,
  durationSeconds: 5,
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("ToolBlockView artifact projections (X-52 fixup2)", () => {
  it("case 1: an artifact WITH a url still renders its preview, unchanged", () => {
    render(
      <ToolBlockView
        block={toolBlock("generate_image", [
          { ...STABLE_IMAGE, assetId: "asset-1", url: SIGNED },
        ])}
      />,
    );

    expect(screen.getByRole("img")).toHaveAttribute("src", SIGNED);
    expect(screen.queryByText("附件当前不可访问")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("case 2: a stable artifact with NO url renders no media and says so", () => {
    render(<ToolBlockView block={toolBlock("generate_image", [STABLE_IMAGE])} />);

    // No <img> at all: an `src` of undefined is not a preview.
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
    expect(screen.getByText("附件当前不可访问")).toBeInTheDocument();
    // And the identity is not dressed up as a url to get a picture on screen.
    expect(document.body.innerHTML).not.toContain("asset-locked");
    // Nothing was requested: there is no url to request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("case 3: a historical url-only artifact still renders (no identity required)", () => {
    render(
      <ToolBlockView
        block={toolBlock("generate_image", [
          { type: "image", url: STALE, mimeType: "image/png", width: 512, height: 512 },
        ])}
      />,
    );

    expect(screen.getByRole("img")).toHaveAttribute("src", STALE);
  });

  it("case 4: the detail panel renders a url-carrying artifact", async () => {
    render(
      <ToolBlockView
        block={toolBlock("generate_image", [{ ...STABLE_IMAGE, assetId: "asset-1", url: SIGNED }])}
      />,
    );

    // Clicking the card opens the floating panel (portal into document.body).
    fireEvent.click(screen.getByRole("img"));
    await screen.findByText("附件");

    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[1]).toHaveAttribute("src", SIGNED);
  });

  it("case 5: the detail panel refuses to build a preview without a url", async () => {
    // A non-media tool keeps the generic card, whose "查看详情" button is the
    // way into the panel that lists the artifacts.
    render(
      <ToolBlockView block={toolBlock("screenshot_canvas", [STABLE_IMAGE])} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /查看详情/ }));
    await screen.findByText("附件");

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("附件当前不可访问")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("case 6: a url-less VIDEO artifact constructs no video preview either", async () => {
    render(<ToolBlockView block={toolBlock("generate_video", [STABLE_VIDEO])} />);

    fireEvent.click(screen.getByRole("button", { name: /查看详情/ }));
    await screen.findByText("附件");

    expect(document.querySelector("video")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
