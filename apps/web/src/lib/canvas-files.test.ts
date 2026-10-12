// X-52: the canvas.sync path has to reach the same signature-refresh callback the
// first editor load uses.
//
// `fetchPendingCanvasFiles` always accepted an `onFailure` reporter; the defect
// this pins is that `syncCanvasFilesIntoScene` — the WebSocket / job-fallback /
// Chat sync path — did not forward it, so an image that arrived on a sync with an
// expired signature stayed a broken box until the page was reloaded.
//
// DRIVEN WITHOUT A DOM: `fetch` is the only thing stubbed. The cases below are
// exactly the ways this can go wrong — reporting zero times (the defect), more
// than once per file, reporting the fallback instead of the primary URL, or a
// reporter that throws and takes the rest of the canvas down with it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchPendingCanvasFiles,
  syncCanvasFilesIntoScene,
  type PendingCanvasFile,
} from "./canvas-files.js";

/** A 403 from the signed-read endpoint: the URL expired, so a refresh is due. */
const FORBIDDEN = { ok: false, status: 403 };

const DOWNSCALED =
  "https://proj.test/storage/v1/render/image/sign/project-assets/team/gen/a.png?token=old&width=512";
const ORIGINAL =
  "https://proj.test/storage/v1/object/sign/project-assets/team/gen/a.png?token=old";
const OTHER =
  "https://proj.test/storage/v1/render/image/sign/project-assets/team/gen/b.png?token=old&width=512";

function fileRecord(url: string, original?: string): Record<string, unknown> {
  return {
    id: url,
    mimeType: "image/png",
    created: 1,
    storageUrl: url,
    ...(original === undefined ? {} : { storageUrlOriginal: original }),
  };
}

/** Every candidate answers 403; `blob()` is never reached. */
function stubForbidden(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => FORBIDDEN),
  );
}

/** One fetch per URL, counted so a retry of a dead URL would show up. */
function fetchCalls(): number {
  return (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}

describe("canvas file sync (X-52)", () => {
  beforeEach(() => {
    // The module warns on every failed candidate; the assertions are about the
    // callback, so keep the test output readable.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("case 1: a 403 during canvas.sync reports the primary storage URL once per file", async () => {
    stubForbidden();

    const addFiles = vi.fn();
    const onFailure = vi.fn();

    await syncCanvasFilesIntoScene(
      { addFiles },
      { "file-a": fileRecord(DOWNSCALED, ORIGINAL) },
      [{ id: "el-a", type: "image", fileId: "file-a" }],
      "canvas-1",
      onFailure,
    );

    // Once — not once per candidate: the downscaled URL and the full-size
    // original were both tried, and only the primary is reported because a
    // re-read re-signs both variants together.
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(DOWNSCALED);
    expect(onFailure).not.toHaveBeenCalledWith(ORIGINAL);
    expect(fetchCalls()).toBe(2);

    // Nothing resolved, so nothing was pushed: the element stays a placeholder
    // until the refresh this report asks for brings back a fresh URL.
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("case 2: two unreachable files report two failures, each naming its own URL", async () => {
    stubForbidden();

    const onFailure = vi.fn();

    await syncCanvasFilesIntoScene(
      { addFiles: vi.fn() },
      { "file-a": fileRecord(DOWNSCALED), "file-b": fileRecord(OTHER) },
      [
        { id: "el-a", type: "image", fileId: "file-a" },
        { id: "el-b", type: "image", fileId: "file-b" },
      ],
      "canvas-2",
      onFailure,
    );

    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure.mock.calls.map((call) => call[0]).sort()).toEqual(
      [DOWNSCALED, OTHER].sort(),
    );
  });

  it("case 3: the callback is optional, and a throwing one cannot break the sync", async () => {
    stubForbidden();

    const pending: PendingCanvasFile[] = [
      { fileId: "file-a", url: DOWNSCALED, fallbackUrl: ORIGINAL, meta: fileRecord(DOWNSCALED) },
    ];

    // No callback at all: a caller that does not care still gets a clean result.
    await expect(fetchPendingCanvasFiles(pending)).resolves.toEqual([]);

    // A reporter that throws is contained; the canvas that did resolve is
    // already on its way, and the sync itself still settles.
    await expect(
      syncCanvasFilesIntoScene(
        { addFiles: vi.fn() },
        { "file-a": fileRecord(DOWNSCALED) },
        [{ id: "el-a", type: "image", fileId: "file-a" }],
        "canvas-3",
        () => {
          throw new Error("reporter exploded");
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("case 4: files whose bytes arrive are added and never reported", async () => {
    const bytes = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => bytes })),
    );

    const addFiles = vi.fn();
    const onFailure = vi.fn();

    await syncCanvasFilesIntoScene(
      { addFiles },
      { "file-a": fileRecord(DOWNSCALED) },
      [{ id: "el-a", type: "image", fileId: "file-a" }],
      "canvas-4",
      onFailure,
    );

    expect(onFailure).not.toHaveBeenCalled();
    expect(addFiles).toHaveBeenCalledTimes(1);
    const [entries] = addFiles.mock.calls[0] as [Array<{ id: string; dataURL: string }>];
    expect(entries).toHaveLength(1);
    // The mimeType follows the bytes actually returned, not the document's claim.
    expect(entries[0]?.dataURL.startsWith("data:image/webp;base64,")).toBe(true);
  });

  it("case 5: an orphan file is neither fetched nor reported", async () => {
    stubForbidden();

    const onFailure = vi.fn();

    // No element points at this file id, so the sync must not even ask for it —
    // which is why the failure callback stays silent as well.
    await syncCanvasFilesIntoScene(
      { addFiles: vi.fn() },
      { "file-dead": fileRecord(DOWNSCALED) },
      [{ id: "el-a", type: "image", fileId: "file-a" }],
      "canvas-5",
      onFailure,
    );

    expect(fetchCalls()).toBe(0);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
