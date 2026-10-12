// X-52: the refresh-on-expiry rules, driven directly — no DOM, no canvas.
//
// The three cases are exactly the three ways this can go wrong: asking twice for
// one dead URL, never asking again after the first failure, or looping forever on
// a URL that cannot be fixed.
import { describe, expect, it, vi } from "vitest";

import { createCanvasMediaRefresh, isStorageMediaUrl } from "./canvas-media-refresh.js";

const EXPIRED = "https://proj.test/storage/v1/object/sign/project-assets/a.png?token=old";
const FRESH = "https://proj.test/storage/v1/object/sign/project-assets/a.png?token=new";

describe("canvas media refresh (X-52)", () => {
  it("case 1: the same failed URL asks for a refresh at most once", async () => {
    const refresh = createCanvasMediaRefresh();
    const sync = vi.fn(async () => {});

    // Two images can fail in the same tick; one dead URL is one request.
    const [first, second] = await Promise.all([
      refresh.reportFailure(EXPIRED, sync),
      refresh.reportFailure(EXPIRED, sync),
    ]);

    expect(await refresh.reportFailure(EXPIRED, sync)).toBe("ignored");
    expect([first, second].sort()).toEqual(["ignored", "refreshed"]);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(refresh.hasAsked(EXPIRED)).toBe(true);
  });

  it("case 2: the URL a refresh produces may ask again — the tab is not locked out", async () => {
    const refresh = createCanvasMediaRefresh();
    const sync = vi.fn(async () => {});

    expect(await refresh.reportFailure(EXPIRED, sync)).toBe("refreshed");
    // The refreshed projection is a different URL; when IT eventually expires it
    // must be able to ask. (A global "already refreshed once" flag would strand
    // the tab on the first expiry of a long session.)
    expect(await refresh.reportFailure(FRESH, sync)).toBe("refreshed");
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("case 3: a refresh that fails does not loop, and nothing is retried forever", async () => {
    const refresh = createCanvasMediaRefresh();
    const sync = vi.fn(async () => {
      throw new Error("canvas read failed");
    });

    // The failure is contained: the caller still gets an answer.
    await expect(refresh.reportFailure(EXPIRED, sync)).resolves.toBe("refreshed");

    // …and the same URL never triggers a second attempt, so a permanently broken
    // object cannot spin the tab.
    expect(await refresh.reportFailure(EXPIRED, sync)).toBe("ignored");
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("case 4: empty or non-storage URLs are not our business", async () => {
    const refresh = createCanvasMediaRefresh();
    const sync = vi.fn(async () => {});

    expect(await refresh.reportFailure(undefined, sync)).toBe("ignored");
    expect(await refresh.reportFailure("", sync)).toBe("ignored");
    expect(sync).not.toHaveBeenCalled();

    expect(isStorageMediaUrl(EXPIRED)).toBe(true);
    expect(isStorageMediaUrl("https://provider.test/old.mp4")).toBe(false);
    expect(isStorageMediaUrl(undefined)).toBe(false);
  });

  it("case 5: forgetting a URL lets a later failure ask again", async () => {
    const refresh = createCanvasMediaRefresh();
    const sync = vi.fn(async () => {});

    await refresh.reportFailure(EXPIRED, sync);
    expect(await refresh.reportFailure(EXPIRED, sync)).toBe("ignored");

    refresh.forget(EXPIRED);
    expect(await refresh.reportFailure(EXPIRED, sync)).toBe("refreshed");
    expect(sync).toHaveBeenCalledTimes(2);
  });
});
