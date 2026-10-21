import { describe, expect, it } from "vitest";

import { videoSlotSize } from "./video-slot-size.js";

describe("videoSlotSize", () => {
  it("CV-02: an unspecified video slot keeps the 640x360 default", () => {
    expect(videoSlotSize()).toEqual({ width: 640, height: 360 });
    expect(videoSlotSize("16:9")).toEqual({ width: 640, height: 360 });
  });

  it("CV-02: a portrait video gets a portrait slot", () => {
    expect(videoSlotSize("9:16")).toEqual({ width: 360, height: 640 });
  });

  it("CV-02: a square video gets a square slot", () => {
    expect(videoSlotSize("1:1")).toEqual({ width: 640, height: 640 });
  });

  it("CV-02: an unreadable ratio falls back to 16:9", () => {
    expect(videoSlotSize("abc")).toEqual({ width: 640, height: 360 });
  });
});
