import { describe, expect, it } from "vitest";

import {
  LEGACY_QUALITY_OPTIONS,
  qualityOptionsFor,
} from "../src/lib/image-quality-options";

describe("qualityOptionsFor", () => {
  it("MD-03: while the model is unknown the built-in 1K / 2K / 4K stay", () => {
    const options = qualityOptionsFor(undefined);

    expect(options).toEqual(LEGACY_QUALITY_OPTIONS);
    expect(options?.map((o) => o.label)).toEqual(["1K", "2K", "4K"]);
  });

  it("MD-03: a model without quality gets no selector", () => {
    expect(qualityOptionsFor({})).toBeNull();
  });

  it("MD-03: Imagen 4's top tier reads 超清（实际 2K）", () => {
    const options = qualityOptionsFor({
      quality: [
        { key: "standard", output: "1K", label: "标准 1K" },
        { key: "hd", output: "2K", label: "高清 2K" },
        { key: "ultra", output: "2K", label: "超清（实际 2K）" },
      ],
    });

    expect(options).toEqual([
      { value: "standard", label: "标准 1K" },
      { value: "hd", label: "高清 2K" },
      { value: "ultra", label: "超清（实际 2K）" },
    ]);
    expect(options?.[options.length - 1]).toEqual({
      value: "ultra",
      label: "超清（实际 2K）",
    });
  });

  it("MD-03: the server's order is kept", () => {
    const options = qualityOptionsFor({
      quality: [
        { key: "ultra", output: "4K", label: "超清 4K" },
        { key: "standard", output: "1K", label: "标准 1K" },
        { key: "hd", output: "2K", label: "高清 2K" },
      ],
    });

    expect(options?.map((o) => o.value)).toEqual(["ultra", "standard", "hd"]);
  });
});
