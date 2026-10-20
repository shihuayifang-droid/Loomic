import { describe, expect, it } from "vitest";

import { visibleOn, type ModelVisibilityInfo } from "../src/lib/model-visibility";

type Model = { id: string; visibility?: ModelVisibilityInfo };

function ids(models: Model[]): string[] {
  return models.map((m) => m.id);
}

describe("visibleOn", () => {
  it("MD-01: a list without visibility shows everything", () => {
    const models: Model[] = [{ id: "a" }, { id: "b" }];

    expect(ids(visibleOn(models, "generator"))).toEqual(["a", "b"]);
    expect(ids(visibleOn(models, "preference"))).toEqual(["a", "b"]);
    expect(ids(visibleOn(models, "agent"))).toEqual(["a", "b"]);
  });

  it("MD-01: a generator-only model shows in the generator but not in preferences or @", () => {
    const models: Model[] = [
      {
        id: "generator-only",
        visibility: {
          listed: true,
          agent_callable: false,
          generator_visible: true,
          in_preference: false,
        },
      },
    ];

    expect(ids(visibleOn(models, "generator"))).toEqual(["generator-only"]);
    expect(ids(visibleOn(models, "preference"))).toEqual([]);
    expect(ids(visibleOn(models, "agent"))).toEqual([]);
  });

  it("MD-01: a delisted model disappears everywhere", () => {
    const models: Model[] = [
      {
        id: "delisted",
        visibility: {
          listed: false,
          agent_callable: true,
          generator_visible: true,
          in_preference: true,
        },
      },
    ];

    expect(ids(visibleOn(models, "generator"))).toEqual([]);
    expect(ids(visibleOn(models, "preference"))).toEqual([]);
    expect(ids(visibleOn(models, "agent"))).toEqual([]);
  });

  it("MD-01: order is kept", () => {
    const shown: ModelVisibilityInfo = {
      listed: true,
      agent_callable: true,
      generator_visible: true,
      in_preference: true,
    };
    const hidden: ModelVisibilityInfo = {
      listed: false,
      agent_callable: true,
      generator_visible: true,
      in_preference: true,
    };
    const models: Model[] = [
      { id: "third", visibility: shown },
      { id: "hidden", visibility: hidden },
      { id: "first", visibility: shown },
      { id: "second", visibility: shown },
    ];

    expect(ids(visibleOn(models, "generator"))).toEqual(["third", "first", "second"]);
    expect(ids(visibleOn(models, "preference"))).toEqual(["third", "first", "second"]);
    expect(ids(visibleOn(models, "agent"))).toEqual(["third", "first", "second"]);
  });
});
