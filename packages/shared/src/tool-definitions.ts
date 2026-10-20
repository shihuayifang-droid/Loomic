import { z } from "zod";

/**
 * ED-00k — the per-image tool definition table, read by BOTH sides.
 *
 * One definition drives the per-image toolbar (ED-00), the "more" overflow menu
 * (ED-00f), the custom-toolbar grid (ED-00g), every tooltip and the Agent tool
 * registration (SK-13). The front end must not hard-code a tool list, so the
 * server ships the table over `GET /api/tools` and this file is the wire
 * contract both sides compile against.
 *
 * Field names are the spec's snake_case names on purpose: this is the
 * attachment ED-00k describes, so the table and the wire payload can be read
 * side by side.
 *
 * Prices are deliberately NOT in here (ED-00c / BL-14 own the price table and
 * the quote call): `pricing` names the billing generator and the tiers a quote
 * is asked for, never a number.
 */

/** ED-00d interaction forms, plus `insert` for the Mockup container (ED-04). */
export const toolFormSchema = z.enum(["panel", "subbar", "dropdown", "direct", "insert"]);
export type ToolForm = z.infer<typeof toolFormSchema>;

/** Where the tool sits by default: on the toolbar row, or in the "more" menu. */
export const toolSlotSchema = z.enum(["main", "more"]);
export type ToolSlot = z.infer<typeof toolSlotSchema>;

/** What a tool produces. `none` = a canvas-only action, no new artifact (ED-00i ②). */
export const toolOutputKindSchema = z.enum(["image", "svg", "mockup", "video", "none"]);
export type ToolOutputKind = z.infer<typeof toolOutputKindSchema>;

/**
 * `enabled` = usable today; `unavailable` = capability gap, purchase pending or
 * P1/P2 (the server still ships it, the client and the Agent hide it — ED-00k).
 */
export const toolAvailabilitySchema = z.enum(["enabled", "unavailable"]);
export type ToolAvailability = z.infer<typeof toolAvailabilitySchema>;

/**
 * One reason a tool's execute control is disabled. `message` is the reason the
 * user sees (ED-00e: a disabled tool must say why), so it may not be empty.
 */
export const toolDisabledRuleSchema = z.object({
  id: z.string().min(1),
  message: z.string().min(1),
});
export type ToolDisabledRule = z.infer<typeof toolDisabledRuleSchema>;

/**
 * MD-03 / ED-00h — how one slider's internal value is shown to the user.
 *
 * Same shape as the web's `ParamDisplay` (`apps/web/src/lib/param-slider.ts`):
 * `linear` maps an internal value with `a + v * k` and rounds to `round`
 * decimals, `steps` snaps to one of `labels`. The server ships it, so the web
 * panel owns neither the labels nor the numbers.
 */
export const toolParamDisplaySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("linear"),
    a: z.number(),
    k: z.number(),
    round: z.number().int().nonnegative().optional(),
    unit: z.string().optional(),
  }),
  z.object({
    kind: z.literal("steps"),
    labels: z.array(z.string().min(1)).min(1),
  }),
]);
export type ToolParamDisplay = z.infer<typeof toolParamDisplaySchema>;

/**
 * MD-03 — one slider. `min` / `max` default to 0 / 100 (the web's
 * `ParamSliderConfig` default), and the default value must lie inside the range:
 * a slider whose default is unreachable would render a position the user cannot
 * drag back to.
 */
export const toolParamSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    min: z.number().optional(),
    max: z.number().optional(),
    defaultValue: z.number(),
    display: toolParamDisplaySchema,
  })
  .refine(
    (param) =>
      (param.min ?? 0) <= param.defaultValue &&
      param.defaultValue <= (param.max ?? 100),
    { message: "defaultValue must lie within [min, max]" },
  );
export type ToolParam = z.infer<typeof toolParamSchema>;

/** MD-03 — a titled group of sliders; order is render order. */
export const toolParamGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  params: z.array(toolParamSchema).min(1),
});
export type ToolParamGroup = z.infer<typeof toolParamGroupSchema>;

export const toolDefinitionSchema = z
  .object({
    /** Canonical name, unique across the site (ED-00k). */
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().min(1),
    /** Icon key. */
    icon: z.string().min(1),
    /** `image-toolbar-{id with "_" -> "-"}`, and it does not change with state. */
    testid: z.string(),
    form: toolFormSchema,
    default_slot: toolSlotSchema,
    /** Whether ED-00g's custom toolbar may remove it. */
    removable: z.boolean(),
    /** Whether using it spends credits. */
    consumes: z.boolean(),
    /**
     * Billing generator + the tier list a quote is asked for. Not a price:
     * numbers come from the price table and the quote call (ED-00c / BL-14).
     */
    pricing: z
      .object({
        generator: z.string().min(1),
        tiers: z.array(z.string().min(1)),
      })
      .nullable(),
    output_kind: toolOutputKindSchema,
    output_format: z.string().nullable(),
    /** Download file name prefix (ED-05: `{file_prefix}_{id}.{ext}`). */
    file_prefix: z.string().nullable(),
    /** Canvas event / task type. */
    event_type: z.string().nullable(),
    disabled_rules: z.array(toolDisabledRuleSchema),
    eta_seconds: z.number().int().positive().nullable(),
    /** Whether SK-13 registers it as an Agent-callable tool. */
    agent_callable: z.boolean(),
    availability: toolAvailabilitySchema,
    /**
     * MD-03 / X-P11 — the panel's sliders, shipped by the server instead of being
     * hard-coded in the web app. Optional: only tools with a slider panel (now
     * just ED-01 调整) carry it, so every other row and every existing fixture
     * keeps parsing unchanged.
     */
    param_groups: z.array(toolParamGroupSchema).optional(),
    /**
     * GN-05: which model runs this tool; config only — changing it never touches
     * the client. A tool and a model are not one-to-one: several tools may name
     * the same model, and swapping the model behind a tool is an edit to this
     * row, not to any front-end code. Optional, so every existing row (and every
     * existing fixture) keeps parsing unchanged until purchasing decides.
     */
    execution_model: z.string().min(1).optional(),
  })
  /**
   * ED-00k: `consumes` and `pricing` may not disagree. A free tool must not
   * carry a billing generator, and a paying tool must say which generator a
   * quote is asked for — otherwise ED-00c has nothing to ask and the client
   * cannot tell "free" from "quote not implemented yet".
   */
  .superRefine((tool, context) => {
    if (!tool.consumes && tool.pricing !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pricing"],
        message: `tool ${tool.id} does not consume credits but carries pricing`,
      });
    }

    if (tool.consumes && tool.pricing === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pricing"],
        message: `tool ${tool.id} consumes credits but has no pricing`,
      });
    }
  });
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

/**
 * `GET /api/tools` response.
 *
 * The uniqueness rule on `id` ("规范名，全站唯一") is checked on the LIST rather
 * than per row, so the same parse that guards the table at module load also
 * rejects a copy-pasted id — otherwise a duplicate would ship silently and one
 * of the two tools would never render.
 */
export const toolListResponseSchema = z
  .object({ tools: z.array(toolDefinitionSchema) })
  .superRefine(({ tools }, context) => {
    const seen = new Set<string>();

    for (const [index, tool] of tools.entries()) {
      if (seen.has(tool.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tools", index, "id"],
          message: `duplicate tool id ${tool.id}`,
        });
      }

      seen.add(tool.id);
    }
  });
export type ToolListResponse = z.infer<typeof toolListResponseSchema>;
