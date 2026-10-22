// @credits-system — Shared types and configs for the credits/billing system.
// Prices are NOT here: a price exists only in the `pricing_rules` table (BL-14)
// and is asked for at charge time by the price quoter.
import { z } from "zod";

import { IMAGE_MODEL_CATALOG, VIDEO_MODEL_CATALOG } from "./model-catalog.js";

// ── Plan types ───────────────────────────────────────────────

export const subscriptionPlanSchema = z.enum([
  "free",
  "starter",
  "pro",
  "ultra",
  "business",
]);
export type SubscriptionPlan = z.infer<typeof subscriptionPlanSchema>;

export const billingPeriodSchema = z.enum(["monthly", "yearly"]);
export type BillingPeriod = z.infer<typeof billingPeriodSchema>;

export const creditTransactionTypeSchema = z.enum([
  "subscription_grant",
  "daily_grant",
  "purchase",
  "generation_deduct",
  "generation_refund",
  "admin_adjustment",
  "bonus",
  // BL-06 / workorder 38C: the three the database gained in 37O.
  "cycle_grant",
  "cycle_reset",
  "daily_expire",
]);
export type CreditTransactionType = z.infer<typeof creditTransactionTypeSchema>;

/**
 * BL-06: the ledger entry types, one list for client and server. The database
 * enum predates it; `ledgerEntryTypeOf` is the one translation between the two.
 */
export const ledgerEntryTypeSchema = z.enum([
  "consume",
  "refund_failed",
  "refund_canceled",
  "daily_grant",
  "daily_expire",
  "cycle_grant",
  "cycle_reset",
  "topup",
  "admin_adjust",
  "trial",
]);
export type LedgerEntryType = z.infer<typeof ledgerEntryTypeSchema>;

const LEDGER_ENTRY_TYPE_BY_TRANSACTION_TYPE = {
  generation_deduct: "consume",
  generation_refund: "refund_failed",
  daily_grant: "daily_grant",
  subscription_grant: "cycle_grant",
  purchase: "topup",
  admin_adjustment: "admin_adjust",
  bonus: "admin_adjust",
  cycle_grant: "cycle_grant",
  cycle_reset: "cycle_reset",
  daily_expire: "daily_expire",
} as const satisfies Record<CreditTransactionType, LedgerEntryType>;

/**
 * BL-41 / workorder 39M: the opening of the sentence a cancel refund carries. The
 * stored transaction type stays `generation_refund` (workorder 37S: one type, one
 * unique index), so the DESCRIPTION is the only thing that tells a cancel apart
 * from a failure — and it must be the same prefix on both sides of the wire.
 * `CANCEL_REFUND_DESCRIPTION` in the server builds its sentence from this.
 */
export const CANCELED_REFUND_DESCRIPTION_PREFIX = "Auto-refund: job canceled";

/**
 * The entry type one transaction shows as. `description` is read ONLY to split a
 * cancel refund from a failed one; every other mapping is unchanged, and a caller
 * that passes no description keeps the pre-39M answer (`refund_failed`).
 */
export function ledgerEntryTypeOf(
  transactionType: CreditTransactionType,
  _amount?: number,
  description?: string | null,
): LedgerEntryType {
  if (
    transactionType === "generation_refund" &&
    typeof description === "string" &&
    description.startsWith(CANCELED_REFUND_DESCRIPTION_PREFIX)
  ) {
    return "refund_canceled";
  }
  return LEDGER_ENTRY_TYPE_BY_TRANSACTION_TYPE[transactionType];
}

// ── Quality / resolution types ────────────────────────────────

export type ImageQualityLevel = "standard" | "hd" | "ultra";
export type VideoResolution = "720p" | "1080p" | "4k";

// ── Plan configuration ───────────────────────────────────────

export interface PlanConfig {
  /** Plan identifier */
  plan: SubscriptionPlan;
  /** Monthly subscription credits (0 for free — uses daily instead) */
  monthlyCredits: number;
  /** Daily free credits (only for free plan) */
  dailyCredits: number;
  /** Max concurrent generation jobs */
  maxConcurrentJobs: number;
  /** Max image quality tier */
  maxResolution: ImageQualityLevel;
  /** Max video resolution */
  maxVideoResolution: VideoResolution;
  /** Max projects allowed */
  maxProjects: number;
  /** Max brand kits allowed */
  maxBrandKits: number;
  /** Whether watermark is applied to generated content */
  watermark: boolean;
  /** Monthly price in USD */
  monthlyPrice: number;
  /** Yearly price per month in USD */
  yearlyPrice: number;
}

export const PLAN_CONFIGS: Record<SubscriptionPlan, PlanConfig> = {
  free: {
    plan: "free",
    monthlyCredits: 0,
    dailyCredits: 50,
    maxConcurrentJobs: 1,
    maxResolution: "standard",
    maxVideoResolution: "720p",
    maxProjects: 3,
    maxBrandKits: 1,
    watermark: true,
    monthlyPrice: 0,
    yearlyPrice: 0,
  },
  starter: {
    plan: "starter",
    monthlyCredits: 1200,
    dailyCredits: 0,
    maxConcurrentJobs: 2,
    maxResolution: "standard",
    maxVideoResolution: "720p",
    maxProjects: 10,
    maxBrandKits: 3,
    watermark: false,
    monthlyPrice: 12,
    yearlyPrice: 9,
  },
  pro: {
    plan: "pro",
    monthlyCredits: 5000,
    dailyCredits: 0,
    maxConcurrentJobs: 4,
    maxResolution: "hd",
    maxVideoResolution: "1080p",
    maxProjects: 50,
    maxBrandKits: 10,
    watermark: false,
    monthlyPrice: 39,
    yearlyPrice: 29,
  },
  ultra: {
    plan: "ultra",
    monthlyCredits: 15000,
    dailyCredits: 0,
    maxConcurrentJobs: 8,
    maxResolution: "ultra",
    maxVideoResolution: "4k",
    maxProjects: 200,
    maxBrandKits: 30,
    watermark: false,
    monthlyPrice: 99,
    yearlyPrice: 79,
  },
  business: {
    plan: "business",
    monthlyCredits: 50000,
    dailyCredits: 0,
    maxConcurrentJobs: 12,
    maxResolution: "ultra",
    maxVideoResolution: "4k",
    maxProjects: -1, // unlimited
    maxBrandKits: 100,
    watermark: false,
    monthlyPrice: 249,
    yearlyPrice: 199,
  },
};

// ── Model access tiers ───────────────────────────────────────
// Type-only cycle: model-catalog.ts imports types from here, this imports values
// from there. `import type` is erased at compile time, so there is no runtime
// cycle.

/** Plans in ascending order of entitlement, used for tier comparisons. */
const PLAN_ORDER: SubscriptionPlan[] = [
  "free",
  "starter",
  "pro",
  "ultra",
  "business",
];

/** Check if a given plan meets the minimum tier required for a model. */
export function canAccessModel(
  userPlan: SubscriptionPlan,
  modelId: string,
): boolean {
  // The `?? "pro"` only applies to ids that are not in the catalog at all. Every
  // model any provider exposes is catalogued, so this is reached only for a bogus
  // or retired id — not for a real model that someone forgot to register, which
  // is what used to happen.
  const minTier = MODEL_MIN_TIER[modelId] ?? "pro";
  return PLAN_ORDER.indexOf(userPlan) >= PLAN_ORDER.indexOf(minTier);
}

/** Get the plan config for a given plan. */
export function getPlanConfig(plan: SubscriptionPlan): PlanConfig {
  return PLAN_CONFIGS[plan];
}

// ── Catalog-derived tier table ───────────────────────────────
//
// The catalog (model-catalog.ts) is the single place a model's plan tier is
// declared, so a model can no longer be present in one table and missing from
// another — which is what produced 17 silent fallbacks.
//
// Derived at module load rather than written out again, so there is exactly one
// copy of each value.

export const MODEL_MIN_TIER: Record<string, SubscriptionPlan> =
  Object.fromEntries([
    ...Object.entries(IMAGE_MODEL_CATALOG).map(
      ([id, entry]) => [id, entry.minTier] as const,
    ),
    ...Object.entries(VIDEO_MODEL_CATALOG).map(
      ([id, entry]) => [id, entry.minTier] as const,
    ),
  ]);

// ── Resolution guard ─────────────────────────────────────────

const RESOLUTION_ORDER: ImageQualityLevel[] = ["standard", "hd", "ultra"];

/** Check if a plan allows a given image quality level. */
export function canUseResolution(
  plan: SubscriptionPlan,
  quality: ImageQualityLevel,
): boolean {
  const config = PLAN_CONFIGS[plan];
  return (
    RESOLUTION_ORDER.indexOf(quality) <=
    RESOLUTION_ORDER.indexOf(config.maxResolution)
  );
}

const VIDEO_RESOLUTION_ORDER: VideoResolution[] = ["720p", "1080p", "4k"];

/** Check if a plan allows a given video resolution. */
export function canUseVideoResolution(
  plan: SubscriptionPlan,
  resolution: VideoResolution,
): boolean {
  const config = PLAN_CONFIGS[plan];
  return (
    VIDEO_RESOLUTION_ORDER.indexOf(resolution) <=
    VIDEO_RESOLUTION_ORDER.indexOf(config.maxVideoResolution)
  );
}

// ── API schemas ──────────────────────────────────────────────

/**
 * BL-45 / workorder 37Q: the three pools behind the ONE available-credit figure,
 * as `GET /api/credits` carries them. Same five numbers as `PoolBalances` in
 * `credit-pools.ts`; the schema exists so the balance contract does not
 * silently accept a missing or fractional pool.
 */
export const poolBalancesSchema = z.object({
  daily: z.number().int().nonnegative(),
  teamRemaining: z.number().int().nonnegative(),
  personalTeamUsed: z.number().int().nonnegative(),
  personalCap: z.number().int().nonnegative(),
  topup: z.number().int().nonnegative(),
});
export type PoolBalancesResponse = z.infer<typeof poolBalancesSchema>;

/**
 * AD-01 / workorder 37Z: one member's credit numbers for the admin member list,
 * merged onto the existing `GET /api/admin/team/members` rows by `userId`.
 *
 * Same four readings `poolBalancesSchema` carries for the member's own surface
 * (`personalCap`, `personalTeamUsed`, `topup`, `daily`), renamed for the admin
 * view and answered for EVERY member of a workspace rather than for the caller,
 * so "本月个人上限 / 本月已从团队池用 / 充值池余额 / 今日赠送剩余" and the
 * member's own screen cannot disagree about any of them.
 */
export const memberCreditSummarySchema = z.object({
  userId: z.string().min(1),
  personalCap: z.number().int().nonnegative(),
  teamUsed: z.number().int().nonnegative(),
  topup: z.number().int().nonnegative(),
  dailyRemaining: z.number().int().nonnegative(),
});
export type MemberCreditSummary = z.infer<typeof memberCreditSummarySchema>;

/** AD-01 / workorder 37Z: the body of `GET /api/admin/team/members/credits`. */
export const memberCreditSummaryListResponseSchema = z.object({
  members: z.array(memberCreditSummarySchema),
});
export type MemberCreditSummaryListResponse = z.infer<
  typeof memberCreditSummaryListResponseSchema
>;

export const creditBalanceResponseSchema = z.object({
  balance: z.number().int(),
  plan: subscriptionPlanSchema,
  dailyClaimed: z.boolean(),
  limits: z.object({
    maxConcurrentJobs: z.number().int(),
    maxResolution: z.string(),
    monthlyCredits: z.number().int(),
    dailyCredits: z.number().int(),
  }),
  // BL-45 / workorder 37Q: additive only — a caller that knows nothing about the
  // pools still sees the four fields above, and `pools` is absent rather than an
  // empty object. `null` means "there is a reader, but this caller has no team
  // workspace to read pools for".
  pools: z
    .object({
      balances: poolBalancesSchema,
      available: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});
export type CreditBalanceResponse = z.infer<typeof creditBalanceResponseSchema>;

export const creditTransactionSchema = z.object({
  id: z.string().uuid(),
  transaction_type: creditTransactionTypeSchema,
  entry_type: ledgerEntryTypeSchema.optional(),
  amount: z.number().int(),
  balance_after: z.number().int(),
  job_id: z.string().uuid().nullable(),
  description: z.string().nullable(),
  created_at: z.string(),
  // BL-06 / workorder 38U: which pool a ledger line was charged to, and how much
  // came out of each of the three when it was split. Both are ADDITIVE and
  // optional on purpose: the older reads project neither column, so a caller that
  // knows nothing about the pools sees exactly the payload it saw before, while a
  // pool-aware read can publish the two fields the requirement (BL-06) asks for.
  // `null` is the database's own answer for "one pool, or not a pool line at all"
  // (`deduct_from_pools` writes a single `pool` name only when the charge came out
  // of exactly one pool), so it is a value rather than an absence.
  pool: z.enum(["daily", "team", "topup"]).nullable().optional(),
  pool_breakdown: z
    .object({
      daily: z.number().int(),
      team: z.number().int(),
      topup: z.number().int(),
    })
    .nullable()
    .optional(),
});
export type CreditTransaction = z.infer<typeof creditTransactionSchema>;

export const creditTransactionsResponseSchema = z.object({
  transactions: z.array(creditTransactionSchema),
});
export type CreditTransactionsResponse = z.infer<
  typeof creditTransactionsResponseSchema
>;

export const claimDailyResponseSchema = z.object({
  success: z.boolean(),
  balance: z.number().int().optional(),
  message: z.string().optional(),
});
export type ClaimDailyResponse = z.infer<typeof claimDailyResponseSchema>;

export const setPlanRequestSchema = z.object({
  plan: subscriptionPlanSchema,
});
export type SetPlanRequest = z.infer<typeof setPlanRequestSchema>;

// ── Annotated model (returned by model list APIs) ────────────

export const annotatedModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  iconUrl: z.string().optional(),
  provider: z.string(),
  accessible: z.boolean(),
  minTier: subscriptionPlanSchema,
  capabilities: z
    .object({
      textToVideo: z.boolean(),
      imageToVideo: z.boolean(),
      videoToVideo: z.boolean(),
      audio: z.boolean(),
    })
    .optional(),
  limits: z
    .object({
      maxDuration: z.number().int().positive(),
      allowedDurations: z.array(z.number().int().positive()).optional(),
      maxResolution: z.enum(["480p", "720p", "1080p", "2160p"]),
      maxInputImages: z.number().int().nonnegative(),
    })
    .optional(),
  pricing: z
    .object({
      currency: z.literal("CNY"),
      billingUnit: z.literal("generated_second"),
      providerPointsName: z.string(),
      evidenceDate: z.string(),
      rates: z.array(
        z.object({
          resolution: z.enum(["720p", "1080p"]),
          displayResolution: z.string(),
          providerPointsPerSecond: z.number().positive(),
          cnyPerSecond: z.object({
            min: z.number().nonnegative(),
            max: z.number().nonnegative(),
          }),
        }),
      ),
    })
    .optional(),
});
export type AnnotatedModel = z.infer<typeof annotatedModelSchema>;

// -- BL-12 / BL-01 / workorder 37V: admin credit adjust and personal cap ------

/**
 * The admin adjustment. `delta` is signed and may not be zero, and `reason` is
 * mandatory — the database refuses either omission with SQLSTATE 22023, so the
 * route refuses them first with the same 400 the browser already understands.
 */
export const adminCreditAdjustRequestSchema = z.object({
  delta: z
    .number()
    .int()
    .refine((n) => n !== 0),
  reason: z.string().trim().min(1),
});
export type AdminCreditAdjustRequest = z.infer<
  typeof adminCreditAdjustRequestSchema
>;

export const adminCreditAdjustResponseSchema = z.object({
  transactionId: z.string().min(1),
});
export type AdminCreditAdjustResponse = z.infer<
  typeof adminCreditAdjustResponseSchema
>;

/** BL-01: the admin's per-member monthly cap; zero is legal, negative is not. */
export const adminPersonalCapRequestSchema = z.object({
  cap: z.number().int().nonnegative(),
});
export type AdminPersonalCapRequest = z.infer<
  typeof adminPersonalCapRequestSchema
>;

export const adminPersonalCapResponseSchema = z.object({
  cap: z.number().int().nonnegative(),
});
export type AdminPersonalCapResponse = z.infer<
  typeof adminPersonalCapResponseSchema
>;

// -- BL-01 / workorder 37Y: credit cap templates ------------------------------

/**
 * One stored template. `cap` is a whole number of credits and may be zero, the
 * same range `member_cap_settings` accepts; a negative or fractional cap is not
 * representable, so it is not accepted here either.
 */
export const creditCapTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cap: z.number().int().nonnegative(),
});
export type CreditCapTemplate = z.infer<typeof creditCapTemplateSchema>;

/**
 * The create body. The name is trimmed before the length check, so a name of
 * blanks is refused here rather than by the table's `btrim(name) <> ''` check
 * (which would arrive as an unmapped SQLSTATE).
 */
export const creditCapTemplateCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(40),
  cap: z.number().int().nonnegative(),
});
export type CreditCapTemplateCreateRequest = z.infer<
  typeof creditCapTemplateCreateRequestSchema
>;

export const creditCapTemplateListResponseSchema = z.object({
  templates: z.array(creditCapTemplateSchema),
});
export type CreditCapTemplateListResponse = z.infer<
  typeof creditCapTemplateListResponseSchema
>;

/**
 * The apply body: 1..500 member ids, each a uuid. The upper bound keeps one
 * request from becoming an unbounded loop inside the database function.
 */
export const creditCapTemplateApplyRequestSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(500),
});
export type CreditCapTemplateApplyRequest = z.infer<
  typeof creditCapTemplateApplyRequestSchema
>;

/**
 * How many members the template actually changed. Everyone whose cap was set by
 * hand is skipped by `apply_cap_template`, so this is deliberately not
 * `userIds.length`.
 */
export const creditCapTemplateApplyResponseSchema = z.object({
  applied: z.number().int().nonnegative(),
});
export type CreditCapTemplateApplyResponse = z.infer<
  typeof creditCapTemplateApplyResponseSchema
>;