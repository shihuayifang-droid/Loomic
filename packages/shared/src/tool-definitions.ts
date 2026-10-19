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
