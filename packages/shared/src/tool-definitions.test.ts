import { describe, expect, it } from "vitest";

import { toolDefinitionSchema } from "./tool-definitions.js";

/**
 * MD-03 / X-P11 — the tool definition may carry slider groups.
 *
 * Only the CONTRACT is pinned here (does a group parse, is a bad default
 * rejected, does a tool without groups still parse); the 17 ED-01 sliders
 * themselves are the server table's data and are pinned in
 * `apps/server/src/features/tools/tool-definitions.test.ts`.
 */

/** A minimal valid row; the three cases below only vary the params part. */
const BASE_TOOL = {
  id: "adjust",
  label: "调整",
  icon: "adjust",
  testid: "image-toolbar-adjust",
  form: "panel" as const,
  default_slot: "more" as const,
  removable: true,
  consumes: false,
  pricing: null,
  output_kind: "image" as const,
  output_format: null,
  file_prefix: null,
  event_type: null,
  disabled_rules: [{ id: "no_adjustment", message: "未做任何调整" }],
  eta_seconds: null,
  agent_callable: false,
  availability: "enabled" as const,
};

describe("MD-03 tool definitions: slider groups", () => {
  it("MD-03: a tool may carry slider groups", () => {
    const parsed = toolDefinitionSchema.parse({
      ...BASE_TOOL,
      param_groups: [
        {
          id: "light",
          label: "光",
          params: [
            {
              id: "exposure",
              label: "曝光",
              min: -100,
              max: 100,
              defaultValue: 0,
              display: { kind: "linear", a: 0, k: 1, round: 0 },
            },
          ],
        },
        {
          id: "effect",
          label: "效果",
          params: [
            {
              id: "sharpen",
              label: "锐化",
              min: 0,
              max: 100,
              defaultValue: 0,
              display: { kind: "steps", labels: ["弱", "中", "强"] },
            },
          ],
        },
      ],
    });

    expect(parsed.param_groups).toHaveLength(2);
    expect(parsed.param_groups?.[0]?.id).toBe("light");
    expect(parsed.param_groups?.[0]?.params[0]?.display).toEqual({
      kind: "linear",
      a: 0,
      k: 1,
      round: 0,
    });
    expect(parsed.param_groups?.[1]?.params[0]?.display).toEqual({
      kind: "steps",
      labels: ["弱", "中", "强"],
    });
  });

  it("MD-03: a default outside the range is rejected", () => {
    expect(() =>
      toolDefinitionSchema.parse({
        ...BASE_TOOL,
        param_groups: [
          {
            id: "effect",
            label: "效果",
            params: [
              {
                id: "sharpen",
                label: "锐化",
                min: 0,
                max: 100,
                defaultValue: -1,
                display: { kind: "linear", a: 0, k: 1, round: 0 },
              },
            ],
          },
        ],
      }),
    ).toThrow(/defaultValue must lie within \[min, max\]/);
  });

  it("MD-03: tools without param groups still parse", () => {
    const parsed = toolDefinitionSchema.parse(BASE_TOOL);

    expect(parsed.id).toBe("adjust");
    expect(parsed.param_groups).toBeUndefined();
  });

  it("GN-05: a tool may name the model that runs it", () => {
    const parsed = toolDefinitionSchema.parse({
      ...BASE_TOOL,
      execution_model: "model-a",
    });

    expect(parsed.execution_model).toBe("model-a");
    // Config, not a free-form field: an empty name would leave the tool with no
    // model at all while still looking configured.
    expect(() =>
      toolDefinitionSchema.parse({ ...BASE_TOOL, execution_model: "" }),
    ).toThrow();
  });
});
