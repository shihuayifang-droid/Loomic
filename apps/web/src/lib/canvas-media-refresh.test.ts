// X-52: the refresh-on-expiry rules, driven directly — no DOM, no canvas.
//
// The first three cases are exactly the three ways this can go wrong: asking
// twice for one dead URL, never asking again after the first failure, or looping
// forever on a URL that cannot be fixed. Cases 6-9 pin the BUDGET, which lives
// here for the same reason the dedupe set does: charges happen on real refreshes
// only, never on a repeat report of an already-known-bad URL.
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_REFRESHES,
  createCanvasMediaRefresh,
  isStorageMediaUrl,
} from "./canvas-media-refresh.js";

const EXPIRED = "https://proj.test/storage/v1/object/sign/project-assets/a.png?token=old";
const FRESH = "https://proj.test/storage/v1/object/sign/project-assets/a.png?token=new";

/** A distinct URL, i.e. one a successful re-read could hand over later. */
const reread = (n: number) =>
  `https://proj.test/storage/v1/object/sign/project-assets/a.png?token=re-${n}`;

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

  it("case 6: dedupe runs BEFORE the budget, so repeats of one dead URL are free", async () => {
    const refresh = createCanvasMediaRefresh();
    const sync = vi.fn(async () => {});

    expect(await refresh.reportFailure(EXPIRED, sync)).toBe("refreshed");
    // An element that keeps erroring reports the same known-bad URL forever. If
    // those reports were charged, this loop alone would spend the whole budget.
    for (let i = 0; i < 20; i++) {
      expect(await refresh.reportFailure(EXPIRED, sync)).toBe("ignored");
    }
    expect(refresh.refreshesStarted()).toBe(1);

    // The budget is therefore still intact for the URLs a successful re-read
    // produces: four more distinct URLs may each start a refresh…
    for (let n = 1; n <= DEFAULT_MAX_REFRESHES - 1; n++) {
      expect(await refresh.reportFailure(reread(n), sync)).toBe("refreshed");
    }
    // …and only then is the tab out of refreshes.
    expect(await refresh.reportFailure(reread(99), sync)).toBe("ignored");
    expect(sync).toHaveBeenCalledTimes(DEFAULT_MAX_REFRESHES);
    expect(refresh.refreshesStarted()).toBe(DEFAULT_MAX_REFRESHES);
  });

  it("case 7: at most five real refreshes, and past the cap nothing is requested", async () => {
    const refresh = createCanvasMediaRefresh();
    const sync = vi.fn(async () => {});

    const outcomes: string[] = [];
    for (let n = 1; n <= DEFAULT_MAX_REFRESHES + 1; n++) {
      outcomes.push(await refresh.reportFailure(reread(n), sync));
    }

    expect(outcomes).toEqual([
      "refreshed",
      "refreshed",
      "refreshed",
      "refreshed",
      "refreshed",
      "ignored",
    ]);
    expect(sync).toHaveBeenCalledTimes(DEFAULT_MAX_REFRESHES);
    expect(refresh.refreshesStarted()).toBe(DEFAULT_MAX_REFRESHES);

    // The URL that was turned away is not marked as asked: no request happened,
    // so nothing was asked for.
    expect(refresh.hasAsked(reread(DEFAULT_MAX_REFRESHES + 1))).toBe(false);
  });

  it("case 8: a refresh that failed already spent its charge — the cap counts attempts", async () => {
    const refresh = createCanvasMediaRefresh({ maxRefreshes: 1 });
    const failing = vi.fn(async () => {
      throw new Error("canvas read failed");
    });

    expect(await refresh.reportFailure(EXPIRED, failing)).toBe("refreshed");
    expect(refresh.refreshesStarted()).toBe(1);

    // The read failed, but asking again for the same URL is still deduped and a
    // new URL still cannot start a second read.
    expect(await refresh.reportFailure(EXPIRED, failing)).toBe("ignored");
    expect(await refresh.reportFailure(FRESH, failing)).toBe("ignored");
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("case 9: a zero cap never refreshes", async () => {
    const refresh = createCanvasMediaRefresh({ maxRefreshes: 0 });
    const sync = vi.fn(async () => {});

    expect(await refresh.reportFailure(EXPIRED, sync)).toBe("ignored");
    expect(refresh.refreshesStarted()).toBe(0);
    expect(sync).not.toHaveBeenCalled();
  });
});
