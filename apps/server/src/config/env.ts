import { readFileSync } from "node:fs";

export const DEFAULT_AGENT_BACKEND_MODE = "state";
// LOCAL FORK: upstream default was "gpt-4.1", which the kwjm gateway rejects
// with 400 "undefined model name". Must stay in sync with the first entry of
// OPENAI_MODELS in http/models.ts.
export const DEFAULT_AGENT_MODEL = "claude-sonnet-5";
export const DEFAULT_GOOGLE_AGENT_MODEL = "gemini-2.5-flash";
export const DEFAULT_SERVER_PORT = 3001;
export const DEFAULT_WEB_ORIGIN = "http://localhost:3000";

/**
 * BR-20: HAHART_* is the current, official spelling of this server's own
 * variables. LOOMIC_* is kept only for compatibility - it is the legacy
 * spelling that the `.37` deployment's `.env.production` still uses - and it
 * will be deleted once that file has been switched over.
 *
 * Every one of these settings is therefore read as
 * `HAHART_<suffix> ?? <legacy LOOMIC_ suffix>`: the new name wins when both are
 * set, the old name still works while it exists, and `??` is used instead of
 * `||` so an empty string keeps its old "present but empty" meaning. The legacy
 * reads go through the index signature (like NODE_ENV below) so that the
 * `.env.example` scan in `env-example.test.ts`, which collects literal
 * `source.<KEY>` accesses, does not require the retirable names to stay listed
 * in `.env.example`.
 */

/**
 * Resolve the default agent model based on available provider configuration.
 * When Google/Vertex is configured but OpenAI is not, defaults to Gemini 2.5 Flash.
 */
export function resolveDefaultAgentModel(env: {
  googleApiKey?: string | undefined;
  googleVertexProject?: string | undefined;
  openAIApiKey?: string | undefined;
}): string {
  const hasOpenAI = !!env.openAIApiKey;
  const hasGoogle = !!(env.googleApiKey || env.googleVertexProject);

  if (!hasOpenAI && hasGoogle) return DEFAULT_GOOGLE_AGENT_MODEL;
  return DEFAULT_AGENT_MODEL;
}

export type AgentBackendMode = "filesystem" | "state";

/** S-A3 / ADR-0001: which request authenticator validates access tokens. */
export type AuthProvider = "supabase" | "self";

/**
 * OP-05: which object storage backend the server uses. `supabase` keeps the
 * pre-OP-05 behaviour; `fs` is the private file volume and is not implemented
 * yet, so selecting it fails at the point the store is built.
 */
export type StorageProvider = "supabase" | "fs";

/**
 * 43L: which message-queue client the server and the worker build. `pgmq` is the
 * Supabase-era extension client; `native` is the plain-table queue of the new
 * database (43K) and connects through `DATABASE_URL`.
 */
export type QueueProvider = "pgmq" | "native";

/**
 * OP-13: the one place that decides "this is production". NODE_ENV=production.
 *
 * Read through the index signature on purpose: the `.env.example` guard in
 * `env-example.test.ts` treats every property-access reference to the source
 * object as a variable the server reads at runtime, and NODE_ENV is set by the
 * process supervisor rather than by `.env`. Keeping it out of that scan keeps
 * the two guards independent.
 */
export function isProductionEnv(
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  return source["NODE_ENV"] === "production";
}

export type ServerEnv = {
  agentBackendMode: AgentBackendMode;
  agentFilesRoot?: string;
  agentModel: string;
  /**
   * Canonical PostgreSQL connection string for the self-hosted backend
   * (ADR-0001). Optional: nothing connects at import time, and the pure `pg`
   * pool in `src/db/pool.ts` fails loud when a caller asks for a pool without
   * this value. The Supabase-era variables below are untouched by this field.
   */
  databaseUrl?: string;
  /**
   * Override the Gemini API endpoint, e.g. an OpenAI/Gemini-compatible gateway.
   * Value is the host root WITHOUT the version segment (the SDK appends
   * `/v1beta/models/...` itself), e.g. "https://kwjm.com".
   */
  googleApiBase?: string;
  googleApiKey?: string;
  googleApplicationCredentials?: string;
  googleFontsApiKey?: string;
  googleVertexLocation?: string;
  googleVertexProject?: string;
  googleVertexVideoLocation?: string;
  /**
   * HAHART_IMAGE_PROVIDER_MOCK=1|true: every image provider that would be
   * registered is replaced by an offline mock with the same name and models
   * (deterministic fake image, no network). Absent / false = real providers.
   */
  hahartImageProviderMock?: boolean;
  metasoApiBase?: string;
  metasoApiKey?: string;
  openAIApiBase?: string;
  openAIApiKey?: string;
  port: number;
  replicateApiToken?: string;
  supabaseAnonKey?: string;
  supabaseDbUrl?: string;
  supabaseJwtSecret?: string;
  supabaseProjectId?: string;
  supabaseServiceRoleKey?: string;
  supabaseUrl?: string;
  version: string;
  volcesApiKey?: string;
  volcesBaseUrl?: string;
  lemonSqueezyApiKey?: string;
  lemonSqueezyStoreId?: string;
  lemonSqueezyWebhookSecret?: string;
  lemonSqueezyVariantStarterMonthly?: string;
  lemonSqueezyVariantStarterYearly?: string;
  lemonSqueezyVariantProMonthly?: string;
  lemonSqueezyVariantProYearly?: string;
  lemonSqueezyVariantUltraMonthly?: string;
  lemonSqueezyVariantUltraYearly?: string;
  lemonSqueezyVariantBusinessMonthly?: string;
  lemonSqueezyVariantBusinessYearly?: string;
  skillsRoot?: string;
  webOrigin: string;
  workerConcurrency?: number;
  workerImageConcurrency?: number;
  workerVideoConcurrency?: number;
  workerId?: string;
  workerPollIntervalMs?: number;
  workerMaxBatchSize?: number;
  /**
   * AG-10: an Agent generation priced above this many credits asks for
   * confirmation first. Optional on the type so existing literals keep
   * compiling; `loadServerEnv` always fills it (default 50).
   */
  agentConfirmThreshold?: number;
  /**
   * S-A3 / ADR-0001: which authenticator checks access tokens. Optional on the
   * type so existing literals keep compiling; `loadServerEnv` always fills it
   * (default "supabase", so an unset variable keeps the pre-42 behaviour).
   */
  authProvider?: AuthProvider;
  /**
   * S-A3: HS256 secret for the self-hosted access tokens (42A). Only consulted
   * when `authProvider` is "self", where it is mandatory and must be at least
   * 32 bytes. The value never appears in an error message.
   */
  authJwtSecret?: string;
  /** S-A3: `iss` of the self-hosted access tokens (default "hahart"). */
  authJwtIssuer?: string;
  /** S-A3: `aud` of the self-hosted access tokens (default "hahart-api"). */
  authJwtAudience?: string;
  /**
   * OP-05: which object storage backend to use. Optional on the type so existing
   * literals keep compiling; `loadServerEnv` always fills it (default
   * "supabase", so an unset variable keeps the pre-OP-05 behaviour).
   */
  storageProvider?: StorageProvider;
  /**
   * 43L: which queue client to build. Optional on the type so existing literals
   * keep compiling; `loadServerEnv` always fills it (default "pgmq", so an unset
   * variable keeps the pre-43L behaviour).
   */
  queueProvider?: QueueProvider;
  /**
   * OP-05 / 43E: the private file volume. `objectRoot` is the directory that
   * holds `<root>/<bucket>/<key>`; `objectUrlSecret` is the HMAC key of the
   * signed read links (at least 32 bytes); `objectPublicBase` is the origin the
   * links are built on (trailing slashes removed). All three are mandatory once
   * `storageProvider` is "fs" and unused otherwise.
   */
  objectRoot?: string;
  objectUrlSecret?: string;
  objectPublicBase?: string;
};

export const DEFAULT_AGENT_CONFIRM_THRESHOLD = 50;

export const DEFAULT_AUTH_PROVIDER: AuthProvider = "supabase";
export const DEFAULT_AUTH_JWT_ISSUER = "hahart";
export const DEFAULT_AUTH_JWT_AUDIENCE = "hahart-api";
/** OP-05: an unset storage switch means "keep reading and writing objects where we do today". */
export const DEFAULT_STORAGE_PROVIDER: StorageProvider = "supabase";

/** 43L: an unset queue switch means "keep using the pgmq extension client". */
export const DEFAULT_QUEUE_PROVIDER: QueueProvider = "pgmq";

/** HS256 key material below this many UTF-8 bytes is a configuration error. */
const MIN_AUTH_JWT_SECRET_BYTES = 32;

/** OP-05: HMAC key material below this many UTF-8 bytes is a configuration error. */
const MIN_OBJECT_URL_SECRET_BYTES = 32;

function parseAgentConfirmThreshold(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return DEFAULT_AGENT_CONFIRM_THRESHOLD;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid HAHART_AGENT_CONFIRM_THRESHOLD value: ${raw}`);
  }
  return Number.parseInt(trimmed, 10);
}

function parseAuthProvider(raw: string | undefined): AuthProvider {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return DEFAULT_AUTH_PROVIDER;
  }
  if (trimmed === "supabase" || trimmed === "self") {
    return trimmed;
  }
  throw new Error(`Invalid HAHART_AUTH_PROVIDER value: ${raw}`);
}

/**
 * OP-05: the object storage switch. An unknown value is a configuration error
 * rather than a silent fallback: bytes must never land on a backend the
 * operator did not choose.
 */
function parseStorageProvider(raw: string | undefined): StorageProvider {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return DEFAULT_STORAGE_PROVIDER;
  }
  if (trimmed === "supabase" || trimmed === "fs") {
    return trimmed;
  }
  throw new Error(`Invalid HAHART_STORAGE_PROVIDER value: ${raw}`);
}

/**
 * 43L: the message-queue switch. Same rule as the storage switch: an unknown
 * value is a configuration error rather than a silent fallback, because a worker
 * polling the wrong queue looks healthy while jobs pile up untouched.
 */
function parseQueueProvider(raw: string | undefined): QueueProvider {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return DEFAULT_QUEUE_PROVIDER;
  }
  if (trimmed === "pgmq" || trimmed === "native") {
    return trimmed;
  }
  throw new Error(`Invalid HAHART_QUEUE_PROVIDER value: ${raw}`);
}

/**
 * S-A3: the self-hosted mode signs its own tokens, so it needs key material of
 * its own. The message names the variables and never their values, so it stays
 * safe to log verbatim.
 */
function authJwtSecretError(): Error {
  return new Error(
    "HAHART_AUTH_JWT_SECRET must be at least 32 bytes when HAHART_AUTH_PROVIDER=self",
  );
}

function hasEnoughAuthJwtSecret(secret: string | undefined): boolean {
  if (!secret) {
    return false;
  }
  return new TextEncoder().encode(secret).byteLength >= MIN_AUTH_JWT_SECRET_BYTES;
}

/**
 * OP-05 / 43E: the file volume signs its own read links, so it needs key
 * material of its own. Same rule and same "names only, never values" message as
 * the self-hosted auth secret.
 */
function objectStorageConfigError(): Error {
  return new Error(
    "HAHART_STORAGE_PROVIDER=fs requires HAHART_OBJECT_ROOT, HAHART_OBJECT_URL_SECRET (at least 32 bytes) and HAHART_OBJECT_PUBLIC_BASE",
  );
}

function hasEnoughObjectUrlSecret(secret: string | undefined): boolean {
  if (!secret) {
    return false;
  }
  return new TextEncoder().encode(secret).byteLength >= MIN_OBJECT_URL_SECRET_BYTES;
}

/**
 * OP-05 / 43E: signed links are built as `<base>/objects/...`, so a trailing
 * slash on the configured origin would produce a double slash. Normalising it
 * here keeps `signObjectUrl` and the route guessing about nothing.
 */
function normalizePublicBase(raw: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

/**
 * OP-13: the ServerEnv fields production cannot start without, in report order.
 *
 * The check below reads the RESOLVED ServerEnv, not the process environment, so
 * an `overrides` entry satisfies it exactly like an env var does. Field names
 * rather than variable names keep this list free of configuration literals that
 * the dependency audit counts.
 */
export const PRODUCTION_REQUIRED_FIELDS = [
  "databaseUrl",
] as const satisfies readonly (keyof ServerEnv)[];

/**
 * OP-06 / OP-13: the hosted-Supabase fields are required only when the chosen
 * backend actually uses them - a self-hosted production env carries no
 * Supabase keys, and the Supabase clients are created lazily, so nothing reads
 * them at start-up. In report order:
 * - supabaseUrl + supabaseServiceRoleKey: auth OR storage on Supabase;
 * - supabaseJwtSecret: auth on Supabase.
 */
export const PRODUCTION_SUPABASE_ACCESS_FIELDS = [
  "supabaseUrl",
  "supabaseServiceRoleKey",
] as const satisfies readonly (keyof ServerEnv)[];

export const PRODUCTION_SUPABASE_AUTH_FIELDS = [
  "supabaseJwtSecret",
] as const satisfies readonly (keyof ServerEnv)[];

/** OP-13: production needs at least one of these image-provider credentials. */
export const PRODUCTION_IMAGE_PROVIDER_FIELDS = [
  "openAIApiKey",
  "googleApiKey",
  "googleVertexProject",
  "replicateApiToken",
  "volcesApiKey",
] as const satisfies readonly (keyof ServerEnv)[];

/**
 * OP-13 start-up self-check: the NAMES of the fields that are missing, and
 * never their values, so the thrown message stays safe to log verbatim.
 */
export function missingProductionKeys(resolved: ServerEnv): string[] {
  const usesSupabaseAuth = resolved.authProvider === "supabase";
  const usesSupabaseStorage = resolved.storageProvider === "supabase";
  const requiredFields: (keyof ServerEnv)[] = [
    ...PRODUCTION_REQUIRED_FIELDS,
    ...(usesSupabaseAuth || usesSupabaseStorage
      ? PRODUCTION_SUPABASE_ACCESS_FIELDS
      : []),
    ...(usesSupabaseAuth ? PRODUCTION_SUPABASE_AUTH_FIELDS : []),
  ];
  const missing: string[] = requiredFields.filter((field) => !resolved[field]);

  if (!PRODUCTION_IMAGE_PROVIDER_FIELDS.some((field) => resolved[field])) {
    missing.push(`one of ${PRODUCTION_IMAGE_PROVIDER_FIELDS.join("|")}`);
  }

  return missing;
}

export function loadServerEnv(
  overrides: Partial<ServerEnv> = {},
  source: NodeJS.ProcessEnv = process.env,
): ServerEnv {
  const agentFilesRoot =
    overrides.agentFilesRoot ??
    parseAgentFilesRoot(
      source.HAHART_AGENT_FILES_ROOT ?? source["LOOMIC_AGENT_FILES_ROOT"],
    );
  const databaseUrl =
    overrides.databaseUrl ?? normalizeOptionalString(source.DATABASE_URL);
  // Read through the index signature, same reason as NODE_ENV in
  // `isProductionEnv`: keeps this test switch out of the `.env.example` scan.
  const hahartImageProviderMock =
    overrides.hahartImageProviderMock ??
    /^(1|true)$/i.test(
      normalizeOptionalString(source["HAHART_IMAGE_PROVIDER_MOCK"]) ?? "",
    );
  const openAIApiBase =
    overrides.openAIApiBase ?? normalizeOptionalString(source.OPENAI_API_BASE);
  const openAIApiKey =
    overrides.openAIApiKey ?? normalizeOptionalString(source.OPENAI_API_KEY);
  const supabaseUrl =
    overrides.supabaseUrl ?? normalizeOptionalString(source.SUPABASE_URL);
  const supabaseAnonKey =
    overrides.supabaseAnonKey ??
    normalizeOptionalString(source.SUPABASE_ANON_KEY);
  const supabaseDbUrl =
    overrides.supabaseDbUrl ?? normalizeOptionalString(source.SUPABASE_DB_URL);
  const supabaseJwtSecret =
    overrides.supabaseJwtSecret ??
    normalizeOptionalString(source.SUPABASE_JWT_SECRET);
  const supabaseServiceRoleKey =
    overrides.supabaseServiceRoleKey ??
    normalizeOptionalString(source.SUPABASE_SERVICE_ROLE_KEY);
  const supabaseProjectId =
    overrides.supabaseProjectId ??
    normalizeOptionalString(source.SUPABASE_PROJECT_ID);
  const googleApiKey =
    overrides.googleApiKey ?? normalizeOptionalString(source.GOOGLE_API_KEY);
  const googleApiBase =
    overrides.googleApiBase ?? normalizeOptionalString(source.GOOGLE_API_BASE);
  const googleApplicationCredentials =
    overrides.googleApplicationCredentials ??
    normalizeOptionalString(source.GOOGLE_APPLICATION_CREDENTIALS);
  const googleFontsApiKey =
    overrides.googleFontsApiKey ??
    normalizeOptionalString(source.GOOGLE_FONTS_API_KEY);
  const googleVertexProject =
    overrides.googleVertexProject ??
    normalizeOptionalString(source.GOOGLE_VERTEX_PROJECT);
  const googleVertexLocation =
    overrides.googleVertexLocation ??
    normalizeOptionalString(source.GOOGLE_VERTEX_LOCATION);
  const googleVertexVideoLocation =
    overrides.googleVertexVideoLocation ??
    normalizeOptionalString(source.GOOGLE_VERTEX_VIDEO_LOCATION);
  const replicateApiToken =
    overrides.replicateApiToken ??
    normalizeOptionalString(source.REPLICATE_API_TOKEN);
  const metasoApiKey =
    overrides.metasoApiKey ?? normalizeOptionalString(source.METASO_API_KEY);
  const metasoApiBase =
    overrides.metasoApiBase ?? normalizeOptionalString(source.METASO_API_BASE);
  const volcesApiKey =
    overrides.volcesApiKey ?? normalizeOptionalString(source.VOLCES_API_KEY);
  const volcesBaseUrl =
    overrides.volcesBaseUrl ?? normalizeOptionalString(source.VOLCES_BASE_URL);
  const lemonSqueezyApiKey =
    overrides.lemonSqueezyApiKey ??
    normalizeOptionalString(source.LEMONSQUEEZY_API_KEY);
  const lemonSqueezyStoreId =
    overrides.lemonSqueezyStoreId ??
    normalizeOptionalString(source.LEMONSQUEEZY_STORE_ID);
  const lemonSqueezyWebhookSecret =
    overrides.lemonSqueezyWebhookSecret ??
    normalizeOptionalString(source.LEMONSQUEEZY_WEBHOOK_SECRET);
  const lemonSqueezyVariantStarterMonthly =
    overrides.lemonSqueezyVariantStarterMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_STARTER_MONTHLY);
  const lemonSqueezyVariantStarterYearly =
    overrides.lemonSqueezyVariantStarterYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_STARTER_YEARLY);
  const lemonSqueezyVariantProMonthly =
    overrides.lemonSqueezyVariantProMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_PRO_MONTHLY);
  const lemonSqueezyVariantProYearly =
    overrides.lemonSqueezyVariantProYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_PRO_YEARLY);
  const lemonSqueezyVariantUltraMonthly =
    overrides.lemonSqueezyVariantUltraMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_ULTRA_MONTHLY);
  const lemonSqueezyVariantUltraYearly =
    overrides.lemonSqueezyVariantUltraYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_ULTRA_YEARLY);
  const lemonSqueezyVariantBusinessMonthly =
    overrides.lemonSqueezyVariantBusinessMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_BUSINESS_MONTHLY);
  const lemonSqueezyVariantBusinessYearly =
    overrides.lemonSqueezyVariantBusinessYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_BUSINESS_YEARLY);
  const skillsRoot =
    overrides.skillsRoot ??
    normalizeOptionalString(
      source.HAHART_SKILLS_ROOT ?? source["LOOMIC_SKILLS_ROOT"],
    );
  const workerConcurrency =
    overrides.workerConcurrency ??
    (source.WORKER_CONCURRENCY
      ? Number.parseInt(source.WORKER_CONCURRENCY, 10)
      : undefined);
  const workerImageConcurrency =
    overrides.workerImageConcurrency ??
    (source.WORKER_IMAGE_CONCURRENCY
      ? Number.parseInt(source.WORKER_IMAGE_CONCURRENCY, 10)
      : undefined);
  const workerVideoConcurrency =
    overrides.workerVideoConcurrency ??
    (source.WORKER_VIDEO_CONCURRENCY
      ? Number.parseInt(source.WORKER_VIDEO_CONCURRENCY, 10)
      : undefined);
  const workerId =
    overrides.workerId ?? normalizeOptionalString(source.WORKER_ID);
  const workerPollIntervalMs =
    overrides.workerPollIntervalMs ??
    (source.WORKER_POLL_INTERVAL_MS
      ? Number.parseInt(source.WORKER_POLL_INTERVAL_MS, 10)
      : undefined);
  const workerMaxBatchSize =
    overrides.workerMaxBatchSize ??
    (source.WORKER_MAX_BATCH_SIZE
      ? Number.parseInt(source.WORKER_MAX_BATCH_SIZE, 10)
      : undefined);
  const agentConfirmThreshold = parseAgentConfirmThreshold(
    source.HAHART_AGENT_CONFIRM_THRESHOLD,
  );
  const authProvider =
    overrides.authProvider ?? parseAuthProvider(source.HAHART_AUTH_PROVIDER);
  const authJwtSecret =
    overrides.authJwtSecret ??
    normalizeOptionalString(source.HAHART_AUTH_JWT_SECRET);
  const authJwtIssuer =
    overrides.authJwtIssuer ??
    normalizeOptionalString(source.HAHART_AUTH_JWT_ISSUER) ??
    DEFAULT_AUTH_JWT_ISSUER;
  const authJwtAudience =
    overrides.authJwtAudience ??
    normalizeOptionalString(source.HAHART_AUTH_JWT_AUDIENCE) ??
    DEFAULT_AUTH_JWT_AUDIENCE;
  const storageProvider =
    overrides.storageProvider ?? parseStorageProvider(source.HAHART_STORAGE_PROVIDER);
  const queueProvider =
    overrides.queueProvider ?? parseQueueProvider(source.HAHART_QUEUE_PROVIDER);
  const objectRoot =
    overrides.objectRoot ?? normalizeOptionalString(source.HAHART_OBJECT_ROOT);
  const objectUrlSecret =
    overrides.objectUrlSecret ??
    normalizeOptionalString(source.HAHART_OBJECT_URL_SECRET);
  const objectPublicBase = normalizePublicBase(
    overrides.objectPublicBase ??
      normalizeOptionalString(source.HAHART_OBJECT_PUBLIC_BASE),
  );

  // S-A3: the self-hosted mode is unusable without its own signing key, so it
  // fails at load time instead of at the first request.
  if (authProvider === "self" && !hasEnoughAuthJwtSecret(authJwtSecret)) {
    throw authJwtSecretError();
  }

  // OP-05 / 43E: the file volume has no sensible default for any of its three
  // settings - a missing directory, key or origin would only surface on the
  // first request - so it refuses to load without them.
  if (
    storageProvider === "fs" &&
    (!objectRoot ||
      !objectPublicBase ||
      !hasEnoughObjectUrlSecret(objectUrlSecret))
  ) {
    throw objectStorageConfigError();
  }

  // Resolve default agent model based on available provider keys.
  // Explicit HAHART_AGENT_MODEL (or the legacy LOOMIC_ spelling) always takes
  // precedence; otherwise fall back to Gemini 2.5 Flash when only
  // Google/Vertex is configured.
  const explicitModel =
    overrides.agentModel ??
    parseAgentModel(source.HAHART_AGENT_MODEL ?? source["LOOMIC_AGENT_MODEL"]);
  const resolvedAgentModel =
    explicitModel ??
    resolveDefaultAgentModel({
      googleApiKey,
      googleVertexProject,
      openAIApiKey,
    });

  // AG-39 / QA-12: production must never run on the filesystem backend. The
  // check runs on the RESOLVED value, so neither the env var nor an explicit
  // `overrides.agentBackendMode` can smuggle "filesystem" into production.
  const agentBackendMode =
    overrides.agentBackendMode ??
    parseAgentBackendMode(
      source.HAHART_AGENT_BACKEND_MODE ?? source["LOOMIC_AGENT_BACKEND_MODE"],
    );
  if (agentBackendMode === "filesystem" && isProductionEnv(source)) {
    throw new Error(
      "HAHART_AGENT_BACKEND_MODE (or legacy LOOMIC_AGENT_BACKEND_MODE)=filesystem is not allowed in production (AG-39)",
    );
  }

  const env: ServerEnv = {
    agentBackendMode,
    agentModel: resolvedAgentModel,
    port:
      overrides.port ??
      parsePort(
        source.HAHART_SERVER_PORT ?? source["LOOMIC_SERVER_PORT"] ?? source.PORT,
      ),
    version: overrides.version ?? readServerVersion(),
    webOrigin:
      overrides.webOrigin ??
      source.HAHART_WEB_ORIGIN ??
      source["LOOMIC_WEB_ORIGIN"] ??
      DEFAULT_WEB_ORIGIN,
    ...(agentFilesRoot ? { agentFilesRoot } : {}),
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(googleApiBase ? { googleApiBase } : {}),
    ...(googleApiKey ? { googleApiKey } : {}),
    ...(googleApplicationCredentials ? { googleApplicationCredentials } : {}),
    ...(hahartImageProviderMock ? { hahartImageProviderMock } : {}),
    ...(openAIApiBase ? { openAIApiBase } : {}),
    ...(openAIApiKey ? { openAIApiKey } : {}),
    ...(supabaseUrl ? { supabaseUrl } : {}),
    ...(supabaseAnonKey ? { supabaseAnonKey } : {}),
    ...(supabaseDbUrl ? { supabaseDbUrl } : {}),
    ...(supabaseJwtSecret ? { supabaseJwtSecret } : {}),
    ...(supabaseServiceRoleKey ? { supabaseServiceRoleKey } : {}),
    ...(supabaseProjectId ? { supabaseProjectId } : {}),
    ...(googleFontsApiKey ? { googleFontsApiKey } : {}),
    ...(googleVertexProject ? { googleVertexProject } : {}),
    ...(googleVertexLocation ? { googleVertexLocation } : {}),
    ...(googleVertexVideoLocation ? { googleVertexVideoLocation } : {}),
    ...(replicateApiToken ? { replicateApiToken } : {}),
    ...(metasoApiKey ? { metasoApiKey } : {}),
    ...(metasoApiBase ? { metasoApiBase } : {}),
    ...(volcesApiKey ? { volcesApiKey } : {}),
    ...(volcesBaseUrl ? { volcesBaseUrl } : {}),
    ...(lemonSqueezyApiKey ? { lemonSqueezyApiKey } : {}),
    ...(lemonSqueezyStoreId ? { lemonSqueezyStoreId } : {}),
    ...(lemonSqueezyWebhookSecret ? { lemonSqueezyWebhookSecret } : {}),
    ...(lemonSqueezyVariantStarterMonthly
      ? { lemonSqueezyVariantStarterMonthly }
      : {}),
    ...(lemonSqueezyVariantStarterYearly
      ? { lemonSqueezyVariantStarterYearly }
      : {}),
    ...(lemonSqueezyVariantProMonthly ? { lemonSqueezyVariantProMonthly } : {}),
    ...(lemonSqueezyVariantProYearly ? { lemonSqueezyVariantProYearly } : {}),
    ...(lemonSqueezyVariantUltraMonthly
      ? { lemonSqueezyVariantUltraMonthly }
      : {}),
    ...(lemonSqueezyVariantUltraYearly
      ? { lemonSqueezyVariantUltraYearly }
      : {}),
    ...(lemonSqueezyVariantBusinessMonthly
      ? { lemonSqueezyVariantBusinessMonthly }
      : {}),
    ...(lemonSqueezyVariantBusinessYearly
      ? { lemonSqueezyVariantBusinessYearly }
      : {}),
    ...(skillsRoot ? { skillsRoot } : {}),
    ...(workerConcurrency ? { workerConcurrency } : {}),
    ...(workerImageConcurrency ? { workerImageConcurrency } : {}),
    ...(workerVideoConcurrency ? { workerVideoConcurrency } : {}),
    ...(workerId ? { workerId } : {}),
    ...(workerPollIntervalMs ? { workerPollIntervalMs } : {}),
    ...(workerMaxBatchSize ? { workerMaxBatchSize } : {}),
    agentConfirmThreshold,
    authProvider,
    authJwtIssuer,
    authJwtAudience,
    storageProvider,
    queueProvider,
    ...(objectRoot ? { objectRoot } : {}),
    ...(objectUrlSecret ? { objectUrlSecret } : {}),
    ...(objectPublicBase ? { objectPublicBase } : {}),
    ...(authJwtSecret ? { authJwtSecret } : {}),
  };

  // OP-13: production must refuse to start with a material configuration gap.
  // Runs on the RESOLVED env (so overrides count) and AFTER the filesystem
  // backend check, which keeps its own error priority (AG-39). The message
  // carries key names only - a value must never reach a log line.
  if (isProductionEnv(source)) {
    const missing = missingProductionKeys(env);
    if (missing.length > 0) {
      throw new Error(
        `Missing required configuration in production (OP-13): ${missing.join(", ")}`,
      );
    }
  }

  return env;
}

function parseAgentBackendMode(rawMode: string | undefined): AgentBackendMode {
  if (!rawMode) {
    return DEFAULT_AGENT_BACKEND_MODE;
  }

  if (rawMode === "state" || rawMode === "filesystem") {
    return rawMode;
  }

  throw new Error(
    `Invalid HAHART_AGENT_BACKEND_MODE (or legacy LOOMIC_AGENT_BACKEND_MODE) value: ${rawMode}`,
  );
}

function parseAgentFilesRoot(rawRoot: string | undefined) {
  return normalizeOptionalString(rawRoot);
}

function parseAgentModel(rawModel: string | undefined) {
  return normalizeOptionalString(rawModel);
}

function normalizeOptionalString(value: string | undefined) {
  const normalizedValue = value?.trim();
  return normalizedValue || undefined;
}

function parsePort(rawPort: string | undefined) {
  if (!rawPort) {
    return DEFAULT_SERVER_PORT;
  }

  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `Invalid HAHART_SERVER_PORT (or legacy LOOMIC_SERVER_PORT) value: ${rawPort}`,
    );
  }

  return port;
}

function readServerVersion() {
  const packageJson = readFileSync(
    new URL("../../package.json", import.meta.url),
    "utf8",
  );

  const parsed = JSON.parse(packageJson) as { version?: string };
  return parsed.version ?? "0.0.0";
}
