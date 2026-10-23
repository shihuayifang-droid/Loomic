// 45D: the ownership rule that gates signing of canvas markers. Pure function,
// so the rule is pinned without any storage or repository fake.
import { describe, expect, it } from "vitest";

import { isMarkerOwned } from "./canvas-service.js";

const PAIR_KEY = (bucket: string, objectPath: string) => `${bucket}\u0000${objectPath}`;

describe("isMarkerOwned (45D)", () => {
  const owned = new Set([PAIR_KEY("project-assets", "legacy/pic.png")]);

  it("accepts an exact (bucket, path) pair from the asset rows", () => {
    expect(
      isMarkerOwned({ bucket: "project-assets", objectPath: "legacy/pic.png" }, owned, null),
    ).toBe(true);
  });

  it("does not accept the same path in another bucket", () => {
    expect(
      isMarkerOwned({ bucket: "user-avatars", objectPath: "legacy/pic.png" }, owned, null),
    ).toBe(false);
  });

  it("accepts a path under the workspace prefix", () => {
    expect(
      isMarkerOwned(
        { bucket: "project-assets", objectPath: "ws-1/canvas-files/c1/a.png" },
        new Set<string>(),
        "ws-1/",
      ),
    ).toBe(true);
  });

  it("rejects a path in another workspace", () => {
    expect(
      isMarkerOwned(
        { bucket: "project-assets", objectPath: "ws-2/canvas-files/c1/a.png" },
        new Set<string>(),
        "ws-1/",
      ),
    ).toBe(false);
  });

  it("rejects a sibling workspace whose id merely starts with the same characters", () => {
    expect(
      isMarkerOwned(
        { bucket: "project-assets", objectPath: "ws-10/a.png" },
        new Set<string>(),
        "ws-1/",
      ),
    ).toBe(false);
  });

  it("rejects the bare prefix and traversal segments under it", () => {
    const none = new Set<string>();
    expect(isMarkerOwned({ bucket: "b", objectPath: "ws-1/" }, none, "ws-1/")).toBe(false);
    expect(isMarkerOwned({ bucket: "b", objectPath: "ws-1/../ws-2/a.png" }, none, "ws-1/")).toBe(false);
    expect(isMarkerOwned({ bucket: "b", objectPath: "ws-1/./a.png" }, none, "ws-1/")).toBe(false);
    expect(isMarkerOwned({ bucket: "b", objectPath: "ws-1/a\\..\\b.png" }, none, "ws-1/")).toBe(false);
  });

  it("with no workspace prefix only the asset rows decide", () => {
    expect(
      isMarkerOwned({ bucket: "project-assets", objectPath: "ws-1/a.png" }, new Set<string>(), null),
    ).toBe(false);
  });
});