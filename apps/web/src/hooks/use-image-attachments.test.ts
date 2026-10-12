// X-52 (工单14 T3): the browser's submission identity is `assetId`, and a URL is
// only ever a preview.
//
// The failure this guards against is quiet: a URL looks like it works right up
// until it expires, and by then the message is in the transcript. So the rule is
// enforced where the attachment list is built — a record with no `assetId` is not
// submittable at all, whatever URL it carries — and the session-storage preview
// is explicitly allowed to be stale.
//
// Driven through the REAL hook with `renderHook`, so the cases exercise what the
// hook actually submits rather than a copy of the rule.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  toReadyAttachments,
  useImageAttachments,
  type ImageAttachmentState,
} from "./use-image-attachments.js";

const SIGNED = "https://proj.test/storage/v1/object/sign/project-assets/ws/a.png?token=this-read";

vi.mock("../lib/server-api", () => ({
  uploadFile: vi.fn(),
}));

import { uploadFile } from "../lib/server-api.js";

const uploadFileMock = vi.mocked(uploadFile);

function state(
  overrides: Partial<ImageAttachmentState> = {},
): ImageAttachmentState {
  return {
    id: "local-1",
    preview: "blob:preview",
    uploading: false,
    mimeType: "image/png",
    source: "upload",
    ...overrides,
  };
}

beforeEach(() => {
  uploadFileMock.mockReset();

  // jsdom has no object-URL store. The hook only needs the preview to be a
  // distinct, non-submittable string, so a stub is enough to prove the preview
  // never becomes the attachment's identity.
  URL.createObjectURL = vi.fn(() => "blob:preview") as never;
  URL.revokeObjectURL = vi.fn() as never;
});

describe("toReadyAttachments uses assetId as the only identity (X-52)", () => {
  it("case 1: an attachment with an assetId is submittable, and carries it", () => {
    const ready = toReadyAttachments([
      state({ assetId: "asset-1", url: SIGNED, name: "a.png" }),
    ]);

    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      assetId: "asset-1",
      mimeType: "image/png",
      source: "upload",
      name: "a.png",
    });
    // The url travels too — the server matches it against its own signature — but
    // it is never what makes the record valid.
    expect(ready[0]?.url).toBe(SIGNED);
  });

  it("case 2: a URL-only record is NOT submittable — a URL is not an identity", () => {
    const ready = toReadyAttachments([
      state({ url: SIGNED, preview: SIGNED }),
      state({ url: "https://cdn.test/legacy.png" }),
    ]);

    expect(ready).toHaveLength(0);
  });

  it("case 3: the preview blob never becomes the submitted url", () => {
    const ready = toReadyAttachments([state({ assetId: "asset-1" })]);

    // No url recorded means an empty url, not the local preview: sending
    // `blob:` would make the request fail its URL match, and pretending the
    // preview is the media's address is exactly the confusion X-52 removes.
    expect(ready[0]?.url).toBe("");
  });

  it("case 4: a failed or in-flight upload is not submittable", () => {
    expect(
      toReadyAttachments([
        state({ assetId: "asset-1", url: SIGNED, error: "boom" }),
        state({ assetId: "asset-2", url: SIGNED, uploading: true }),
      ]),
    ).toHaveLength(0);
  });

  it("case 5: a session-storage preview may be stale, and does not affect eligibility", () => {
    // A URL restored from sessionStorage is last read's signature. It is allowed
    // to be expired: the assetId is what the run is built on, and the server
    // re-signs before showing the model anything.
    const ready = toReadyAttachments([
      state({ assetId: "asset-1", url: "https://proj.test/expired.png?token=old" }),
    ]);

    expect(ready).toHaveLength(1);
    expect(ready[0]?.assetId).toBe("asset-1");
  });
});

describe("useImageAttachments submits the uploaded asset, not the preview (X-52)", () => {
  it("case 1: a completed upload becomes ready with the server's assetId", async () => {
    uploadFileMock.mockResolvedValue({
      asset: { id: "asset-uploaded" },
      url: SIGNED,
    } as never);

    const { result } = renderHook(() => useImageAttachments("token"));

    await act(async () => {
      result.current.addFiles([
        new File(["bytes"], "a.png", { type: "image/png" }),
      ]);
    });

    expect(result.current.readyAttachments).toHaveLength(1);
    expect(result.current.readyAttachments[0]).toMatchObject({
      assetId: "asset-uploaded",
      url: SIGNED,
      source: "upload",
      name: "a.png",
    });
    // The local object URL stayed a preview and never became the submitted url.
    expect(result.current.readyAttachments[0]?.url).not.toContain("blob:");
  });

  it("case 2: a canvas reference is submitted by assetId with its short-lived preview", async () => {
    const { result } = renderHook(() => useImageAttachments("token"));

    await act(async () => {
      result.current.addCanvasRef({
        assetId: "asset-canvas-1",
        url: SIGNED,
        mimeType: "image/png",
        name: "Board 1",
      });
    });

    expect(result.current.attachments[0]).toMatchObject({
      assetId: "asset-canvas-1",
      source: "canvas-ref",
    });
    expect(result.current.readyAttachments[0]).toMatchObject({
      assetId: "asset-canvas-1",
      url: SIGNED,
      source: "canvas-ref",
    });
    // No upload happens for a canvas reference — the object already exists.
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("case 3: a failed upload is never submitted, even though it has a preview", async () => {
    uploadFileMock.mockRejectedValue(new Error("storage said no"));

    const { result } = renderHook(() => useImageAttachments("token"));

    await act(async () => {
      result.current.addFiles([
        new File(["bytes"], "a.png", { type: "image/png" }),
      ]);
    });

    expect(result.current.attachments[0]?.error).toBeDefined();
    expect(result.current.attachments[0]?.preview).toContain("blob:");
    expect(result.current.readyAttachments).toHaveLength(0);
  });
});
