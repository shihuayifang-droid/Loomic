// X-52 (工单14 T3): the browser's submission identity is `assetId`, and a URL is
// only ever a preview.
//
// The failure this guards against is quiet: a URL looks like it works right up
// until it expires, and by then the message is in the transcript. So the rule is
// enforced where the attachment list is built — a record with no `assetId` is not
// submittable at all, whatever URL it carries — and the session-storage preview
// is explicitly allowed to be stale.
//
// 工单14 fixup T1 adds the other half: the server no longer compares the client's
// url against the signature it mints, because a rotated signature differs from a
// stale one for reasons that have nothing to do with forgery. So a missing url is
// submitted as a MISSING KEY rather than as "", and case 6 pins that the shape
// the hook produces parses as the real request contract.
//
// Driven through the REAL hook with `renderHook`, so the cases exercise what the
// hook actually submits rather than a copy of the rule.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCreateRequestSchema } from "@loomic/shared";

import {
  toCanvasRefAttachments,
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
    // The url travels as a PREVIEW for this request. It is never what makes the
    // record valid, and the server does not read it (工单14 fixup T1): a rotation
    // makes it differ from the server's own signature without anything being
    // forged, so comparing the two would reject legitimate attachments.
    expect(ready[0]?.url).toBe(SIGNED);
  });

  it("case 2: a URL-only record is NOT submittable — a URL is not an identity", () => {
    const ready = toReadyAttachments([
      state({ url: SIGNED, preview: SIGNED }),
      state({ url: "https://cdn.test/legacy.png" }),
    ]);

    expect(ready).toHaveLength(0);
  });

  it("case 3: a missing url is submitted as an ABSENT key, never as a fabricated one", () => {
    const ready = toReadyAttachments([state({ assetId: "asset-1" })]);

    // No url recorded means NO url key. Two wrong answers are ruled out here:
    // sending the local `blob:` preview would pretend the preview is the media's
    // address, and sending "" would fabricate a projection that is not a url —
    // `z.string().url()` rejects it at the request schema, before the server ever
    // read the assetId. The identity alone is what makes the record submittable.
    expect(ready).toHaveLength(1);
    expect(ready[0]?.assetId).toBe("asset-1");
    expect(ready[0]).not.toHaveProperty("url");
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

  it("case 6: what the hook submits is accepted by the WIRE contract, url or no url", () => {
    // The end of the chain, and the acceptance criterion: "URL可省略、assetId仍可提交".
    // Parsing through the real request schema is what makes this more than a
    // statement about a local type — it is the contract the server enforces.
    const withUrl = runCreateRequestSchema.parse({
      sessionId: "s1",
      conversationId: "c1",
      prompt: "看这张图",
      attachments: toReadyAttachments([state({ assetId: "asset-1", url: SIGNED })]),
    });
    const withoutUrl = runCreateRequestSchema.parse({
      sessionId: "s1",
      conversationId: "c1",
      prompt: "看这张图",
      attachments: toReadyAttachments([state({ assetId: "asset-2" })]),
    });

    expect(withUrl.attachments?.[0]?.url).toBe(SIGNED);
    // Omitted, not emptied: an empty string would fail `z.string().url()`.
    expect(withoutUrl.attachments?.[0]?.url).toBeUndefined();
    expect(withoutUrl.attachments?.[0]?.assetId).toBe("asset-2");
    expect(withoutUrl.attachments?.[0]?.mimeType).toBe("image/png");
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

// The canvas-chip path: a sentence that references a canvas image attaches the
// object behind it. The bug this pins is that the ELEMENT id was submitted as the
// asset id, which the runtime answered by refusing the whole run
// ("attachment 1 references an asset that is not available to this user") — the
// first message of a conversation worked and every message referencing an image
// failed, which is what made it look like a model problem.
describe("toCanvasRefAttachments", () => {
  const ref = {
    refId: "element-abc123",
    assetId: "5f4c4d65-a118-40bc-816c-e5185584a5da",
    url: SIGNED,
  };

  it("submits the asset id, never the canvas element id", () => {
    const ready = toCanvasRefAttachments([ref], new Set());

    expect(ready).toHaveLength(1);
    expect(ready[0]?.assetId).toBe(ref.assetId);
    expect(ready[0]?.assetId).not.toBe(ref.refId);
    expect(ready[0]).toMatchObject({ url: SIGNED, source: "canvas-ref" });
  });

  it("drops a reference with no asset id instead of guessing one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ready = toCanvasRefAttachments([{ refId: "element-abc123", url: SIGNED }], new Set());

    // A missing attachment costs the prompt a reference; an invented id costs the
    // user the whole run, and the element id is exactly such an invention.
    expect(ready).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not attach the same object twice", () => {
    const ready = toCanvasRefAttachments([ref], new Set([ref.assetId]));
    expect(ready).toHaveLength(0);
  });

  it("produces a shape the run contract accepts", () => {
    const ready = toCanvasRefAttachments([ref], new Set());

    const parsed = runCreateRequestSchema.safeParse({
      sessionId: "session-1",
      conversationId: "session-1",
      prompt: "[图片:element-abc123] make it blue",
      attachments: ready,
    });

    expect(parsed.success).toBe(true);
  });
});
