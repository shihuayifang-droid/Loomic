import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { UPLOAD_MAX_BYTES } from "@loomic/shared";

import type { LoomicAgentFactory } from "./agent/deep-agent.js";
import {
  createAgentPersistenceService,
  type AgentPersistenceService,
} from "./agent/persistence/index.js";
import { createAgentRunService } from "./agent/runtime.js";
import { registerAllProviders } from "./generation/providers/register-all.js";
import {
  createViewerService,
  type ViewerService,
} from "./features/bootstrap/ensure-user-foundation.js";
import {
  createCanvasService,
  type CanvasService,
} from "./features/canvas/canvas-service.js";
import {
  createBrandKitService,
  type BrandKitService,
} from "./features/brand-kit/brand-kit-service.js";
import {
  createProjectService,
  type ProjectService,
} from "./features/projects/project-service.js";
import {
  createChatService,
  type ChatService,
} from "./features/chat/chat-service.js";
import {
  createThreadService,
  type ThreadService,
} from "./features/chat/thread-service.js";
import {
  createAgentRunMetadataService,
  type AgentRunMetadataService,
} from "./features/agent-runs/agent-run-service.js";
import {
  createSettingsService,
  type SettingsService,
} from "./features/settings/settings-service.js";
import {
  createTeamAdminService,
  type TeamAdminService,
} from "./features/team/team-admin.js";
import {
  createTeamMembershipService,
  type TeamMembershipService,
} from "./features/team/team-membership.js";
import {
  createUploadService,
  type UploadService,
} from "./features/uploads/upload-service.js";
import { type ServerEnv, loadServerEnv, resolveDefaultAgentModel } from "./config/env.js";
import {
  createIdentityReadRepository,
  type IdentityReadRepository,
} from "./db/identity-read-repository.js";
import {
  createBrandKitReadRepository,
  type BrandKitReadRepository,
} from "./db/brand-kit-read-repository.js";
import {
  createBrandKitWriteRepository,
} from "./db/brand-kit-write-repository.js";
import {
  createCanvasReadRepository,
  type CanvasReadRepository,
} from "./db/canvas-read-repository.js";
import {
  createChatReadRepository,
  type ChatReadRepository,
} from "./db/chat-read-repository.js";
import {
  createChatSessionWriteRepository,
  type ChatSessionWriteRepository,
} from "./db/chat-session-write-repository.js";
import {
  createChatWriteRepository,
  type ChatWriteRepository,
} from "./db/chat-write-repository.js";
import {
  createProfileWriteRepository,
  type ProfileWriteRepository,
} from "./db/profile-write-repository.js";
import {
  createProjectReadRepository,
  type ProjectReadRepository,
} from "./db/project-read-repository.js";
import { createProjectWriteRepository } from "./db/project-write-repository.js";
import {
  createAssetReadRepository,
  type AssetReadRepository,
} from "./db/asset-read-repository.js";
import { createAssetProvenanceRepository } from "./db/asset-provenance-repository.js";
import { createAssetRecordRepository } from "./db/asset-record-repository.js";
import { createAssetWriteRepository } from "./db/asset-write-repository.js";
import {
  createWorkspaceSkillReadRepository,
} from "./db/workspace-skill-read-repository.js";
import { createSkillRepository, type SkillRepository } from "./db/skill-repository.js";
import {
  createTeamAdminReadRepository,
  type TeamAdminReadRepository,
} from "./db/team-admin-read-repository.js";
import {
  createWorkspaceSettingsReadRepository,
} from "./db/workspace-settings-read-repository.js";
import {
  createWorkspaceSettingsWriteRepository,
  type WorkspaceSettingsWriteRepository,
} from "./db/workspace-settings-write-repository.js";
import {
  createJobAttemptRepository,
  type JobAttemptRepository,
} from "./db/job-attempt-repository.js";
import { createJobAdminReadRepository } from "./db/job-admin-read-repository.js";
import { createJobOwnerReadRepository } from "./db/job-owner-read-repository.js";
import { createJobOwnerWriteRepository } from "./db/job-owner-write-repository.js";
import { createJobConcurrencyRepository } from "./db/job-concurrency-repository.js";
import { createJobTransitionRepository } from "./db/job-transition-repository.js";
import { createCreditReadRepository } from "./db/credit-read-repository.js";
import { createCreditLedgerWriteRepository } from "./db/credit-ledger-write-repository.js";
import { createPricingRuleRepository } from "./db/pricing-rule-repository.js";
import { createChargedJobWriteRepository } from "./db/charged-job-write-repository.js";
import {
  createJobCreditsLinkRepository,
  type JobCreditsLinkRepository,
} from "./db/job-credits-link-repository.js";
import {
  createAgentRunWriteRepository,
  type AgentRunWriteRepository,
} from "./db/agent-run-write-repository.js";
// BL-45 / workorder 37Q: the three-pool read behind `GET /api/credits`. The
// factory takes a pool, so the wiring below makes it lazy instead of connecting
// at startup.
import {
  createPoolBalanceReadRepository,
  type PoolBalanceReadRepository,
} from "./db/pool-balance-read-repository.js";
// AD-01 / workorder 37Z: the per-member credit numbers the admin member list
// merges by `userId`. Unlike the balance reader above its factory takes a pool
// GETTER, so the wiring below is lazy already and `buildApp` never connects.
import {
  createMemberCreditReadRepository,
  type MemberCreditReadRepository,
} from "./db/member-credit-read-repository.js";
// BL-45 / workorder 37R: the daily grant that `GET /api/credits` places before it
// reads the pools. Unlike the balance reader above, its factory takes a pool
// GETTER, so it is lazy already: the wiring below passes the same lazy getter and
// `buildApp` still never connects.
import { createPoolGrantWriteRepository } from "./db/pool-grant-write-repository.js";
// BL-06 / workorder 38U: the member's own three-pool ledger lines out of the team
// workspace, so `GET /api/credits/transactions` shows the charges and refunds the
// pools wrote. Like the balance reader above its factory takes a pool, so the
// wiring below makes it lazy rather than connecting at startup.
import {
  createPoolTransactionReadRepository,
  type PoolTransactionReadRepository,
} from "./db/pool-transaction-read-repository.js";
// BL-12 / BL-01 / workorder 37V: the two admin credit writes. Built lazily
// against the same pool getter as everything above, so the admin surface costs
// no connection until an administrator actually adjusts something.
import {
  createAdminCreditWriteRepository,
  type AdminCreditWriteRepository,
} from "./db/admin-credit-write-repository.js";
import { registerAdminTeamCreditRoutes } from "./http/admin-team-credits.js";
import { createCreditPoolWriteRepository } from "./db/credit-pool-write-repository.js";
import {
  creditPoolsEnabled,
  withCreditPools,
} from "./features/credits/credit-pools-billing.js";
// AD-01 / BL-21 / workorder 39P: the administrator's generation pause. The read
// is lazy (pool getter), like every repository above, and the wrapper is applied
// to the FINAL credit service below so the gate works whether or not
// `LOOMIC_CREDIT_POOLS` is on.
import { createMemberPauseReadRepository } from "./db/member-pause-read-repository.js";
import { withGenerationPause } from "./features/credits/generation-pause.js";
import { DATABASE_URL_ENV_KEY, getTransactionPool } from "./db/pool.js";
import { createQueueClient } from "./queue/queue-client-factory.js";
import {
  createCreditService,
  type CreditService,
} from "./features/credits/credit-service.js";
import {
  createTierGuard,
  type TierGuard,
} from "./features/credits/tier-guard.js";
import {
  createPriceQuoter,
  type PriceQuoter,
} from "./features/pricing/price-quoter.js";
import {
  createJobService,
  type JobService,
} from "./features/jobs/job-service.js";
// GN-32 / workorder 36E-v2: the cancel refund. The read that says HOW MUCH, to
// which workspace and to whom is the same repository the worker already uses;
// the decision (and its "never throws" contract) is `createRefundJob`.
import { createJobRefundBasisRepository } from "./db/job-refund-basis-repository.js";
import { createRefundCompensationRepository } from "./db/refund-compensation-repository.js";
// GN-35 / workorder 36K: the credits of one job, read by its OWNER, behind
// `GET /api/jobs/:jobId/credits`. Built lazily against the same pool as its
// neighbours, so `buildApp` still never connects and never needs
// `DATABASE_URL`; with no pool the route fails closed as `job_query_failed`.
import { createJobCreditsReadRepository } from "./db/job-credits-read-repository.js";
import {
  CANCEL_REFUND_DESCRIPTION,
  createRefundJob,
} from "./features/jobs/refund-job.js";
import type { PaymentService } from "./features/payments/payment-service.js";
import { registerRetiredPaymentRoutes } from "./http/payments-retired.js";
import { registerSecurityHeaders } from "./http/security-headers.js";
import { registerCreditRoutes } from "./http/credits.js";
import { registerPricingRoutes } from "./http/pricing.js";
import { registerFontsRoutes } from "./http/fonts.js";
import { registerJobRoutes } from "./http/jobs.js";
import { createObjectStore } from "./features/storage/object-store-factory.js";
import { objectUrlSecretFrom } from "./features/storage/object-url-signature.js";
import type { SupabaseStorageLike } from "./features/storage/supabase-object-store.js";
import { registerAdminTeamRoutes } from "./http/admin-team.js";
import { registerObjectRoutes } from "./http/object-routes.js";
import { registerBrandKitRoutes } from "./http/brand-kits.js";
import { registerCanvasRoutes } from "./http/canvases.js";
import { registerChatRoutes } from "./http/chat.js";
import { registerGenerateRoutes } from "./http/generate.js";
import { registerHealthRoutes } from "./http/health.js";
import { registerDevClientErrorRoutes } from "./http/dev-client-errors.js";
import { registerImageProxyRoute } from "./http/image-proxy.js";
import { registerModelRoutes } from "./http/models.js";
import { registerImageModelRoutes } from "./http/image-models.js";
import { registerVideoModelRoutes } from "./http/video-models.js";
import { registerProjectRoutes } from "./http/projects.js";
import { registerRunRoutes } from "./http/runs.js";
import { registerSettingsRoutes } from "./http/settings.js";
import { registerTeamGate } from "./http/team-gate.js";
import { registerToolRoutes } from "./http/tools.js";
import { registerAuthRoutes } from "./http/auth.js";
import { registerAuthPasswordRoutes } from "./http/auth-password.js";
import { registerUploadRoutes } from "./http/uploads.js";
import { registerSkillRoutes } from "./http/skills.js";
import { registerMarketplaceRoutes } from "./http/skills-marketplace.js";
import { registerViewerRoutes } from "./http/viewer.js";
import { CanvasEventBuffer } from "./ws/event-buffer.js";
import { ConnectionManager } from "./ws/connection-manager.js";
import { registerWsRoute } from "./ws/handler.js";
// S-A3 (ADR-0001): the two authenticators behind the HAHART_AUTH_PROVIDER switch.
import { createSelfRequestAuthenticator } from "./auth/self-authenticator.js";
import { selectRequestAuthenticator } from "./auth/select-authenticator.js";
import {
  DEFAULT_ACCESS_TTL_SECONDS,
  accessTokenSecretFrom,
} from "./auth/tokens.js";
import { findUserById, isSessionActive } from "./db/auth-repository.js";
import { createAdminSupabaseClient } from "./supabase/admin.js";
import {
  createSupabaseRequestAuthenticator,
  createUserSupabaseClientFactory,
  type RequestAuthenticator,
  type UserSupabaseClient,
} from "./supabase/user.js";

export type BuildAppOptions = {
  agentFactory?: LoomicAgentFactory;
  agentModel?: BaseLanguageModel | string;
  agentPersistenceService?: AgentPersistenceService;
  agentRunMetadataService?: AgentRunMetadataService;
  /**
   * ADR-0001 / workorder 21G: the only writer of `agent_runs` metadata, the
   * accepted insert and the run update. Injectable for the same reason the other
   * repositories are — a test can hand the app its own double and observe which
   * run was written (and that nothing reaches PostgREST).
   */
  agentRunWriteRepository?: AgentRunWriteRepository;
  auth?: RequestAuthenticator;
  assetReadRepository?: AssetReadRepository;
  brandKitService?: BrandKitService;
  canvasReadRepository?: CanvasReadRepository;
  canvasService?: CanvasService;
  chatReadRepository?: ChatReadRepository;
  chatSessionWriteRepository?: ChatSessionWriteRepository;
  chatWriteRepository?: ChatWriteRepository;
  chatService?: ChatService;
  connectionManager?: ConnectionManager;
  creditService?: CreditService;
  /**
   * ADR-0001 / workorder 21D: the user-scoped Supabase client factory is
   * injectable so a test can hand the app a factory that RECORDS its calls (and
   * throws), which is how "the profile write no longer goes through PostgREST"
   * is observed instead of asserted in prose. Production passes nothing here and
   * gets the real factory built from the environment.
   */
  createUserClient?: (accessToken: string) => UserSupabaseClient;
  env?: Partial<ServerEnv>;
  identityReadRepository?: IdentityReadRepository;
  jobService?: JobService;
  paymentService?: PaymentService;
  profileWriteRepository?: ProfileWriteRepository;
  tierGuard?: TierGuard;
  /**
   * ADR-0001 / workorder 31B: the runtime price of a generation. Injectable for
   * the same reason `tierGuard` is — a test can hand the app its own quoter and
   * observe what a route asks the price table for. Production passes nothing here
   * and gets the real quoter over `pricing_rules`.
   */
  priceQuoter?: PriceQuoter;
  uploadService?: UploadService;
  mockEventDelayMs?: number;
  projectReadRepository?: ProjectReadRepository;
  projectService?: ProjectService;
  settingsService?: SettingsService;
  /**
   * ADR-0001 / workorder 21AE: the only path to the `skills`, `skill_files` and
   * `workspace_skills` tables. Injectable for the same reason the other
   * repositories are — the route tests hand the app a double and observe which
   * actor, workspace and values each route passes down (and that nothing reaches
   * PostgREST). Production passes nothing here and gets the real repository.
   */
  skillRepository?: SkillRepository;
  teamAdminReadRepository?: TeamAdminReadRepository;
  teamAdminService?: TeamAdminService;
  teamMembershipService?: TeamMembershipService;
  /**
   * ADR-0001 / workorder 37V: the only writer of an admin's top-up adjustment
   * and of a member's monthly personal cap. Injectable for the same reason the
   * other repositories are — a route test hands the app its own double and
   * observes which workspace, member, operator, delta and reason went down (and
   * that nothing reaches PostgREST).
   */
  adminCreditWriteRepository?: AdminCreditWriteRepository;
  /**
   * AD-01 / workorder 37Z: the per-member credit read behind
   * `GET /api/admin/team/members/credits`. Injectable for the same reason the
   * other repositories are — a route test hands the app its own double and
   * observes which workspace the route read for (and that nothing reaches
   * PostgREST).
   */
  memberCreditReadRepository?: MemberCreditReadRepository;
  threadService?: ThreadService;
  viewerService?: ViewerService;
  /**
   * ADR-0001 / workorder 21E1: the only writer of
   * `workspace_settings.default_model`. Injectable for the same reason the other
   * repositories are — a test can hand the app its own double and observe which
   * actor and which workspace the route passed down.
   */
  workspaceSettingsWriteRepository?: WorkspaceSettingsWriteRepository;
  /**
   * ADR-0001 / workorder 21F: the worker's atomic attempt counter. Injectable
   * for the same reason the other repositories are — a test can hand the app its
   * own double and observe that the count is read from it (and that nothing
   * reaches PostgREST).
   */
  jobAttemptRepository?: JobAttemptRepository;
  /**
   * ADR-0001 / workorder 21H2: the job's credits link and the two compensation
   * steps that own an unlinked charge. Injectable for the same reason the other
   * repositories are — a test can hand the app its own double and observe that
   * the charge is recorded through it (and that nothing reaches PostgREST).
   */
  jobCreditsLinkRepository?: JobCreditsLinkRepository;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const env = loadServerEnv(options.env);

  // Register generation providers (shared with worker.ts)
  registerAllProviders(env);

  const app = Fastify({
    logger: { level: "info" },
  });
  // AS-02: the transport has to admit the largest per-type limit; which type may
  // be how big is decided per upload in the route (UPLOAD_CONSTRAINTS).
  void app.register(multipart, {
    limits: { fileSize: UPLOAD_MAX_BYTES },
  });
  void app.register(async (instance) => {
    await instance.register(websocket);
    await registerWsRoute(instance, {
      agentRuns,
      agentRunMetadataService,
      auth,
      chatService,
      connectionManager,
      eventBuffer,
      settingsService,
      teamMembership: teamMembershipService,
      threadService,
      viewerService,
    });
  });
  const createUserClient =
    options.createUserClient ?? createUserSupabaseClientFactory(env);
  let adminClient:
    | ReturnType<typeof createAdminSupabaseClient>
    | undefined;
  const getAdminClient = () => {
    adminClient ??= createAdminSupabaseClient(env);
    return adminClient;
  };
  // ADR-0001 / workorder 20: identity reads go through the pure `pg`
  // repository. It is built — not called — here, and it resolves its pool
  // lazily on the first read, so `buildApp` never connects and never fails
  // because `DATABASE_URL` is absent.
  const databaseEnv: NodeJS.ProcessEnv = env.databaseUrl
    ? { [DATABASE_URL_ENV_KEY]: env.databaseUrl }
    : {};
  // S-A3 (ADR-0001): HAHART_AUTH_PROVIDER picks the access-token verifier.
  // Unset (or "supabase") keeps the pre-42 behaviour; "self" builds the
  // self-hosted verifier against the same lazily resolved pool, so `buildApp`
  // still never connects. Both factories are thunks, so only the selected one
  // is ever constructed.
  // A function, not a value: the secret check throws on a short secret, which
  // must only happen when the self provider is actually selected.
  const buildSelfTokenConfig = () => ({
    secret: accessTokenSecretFrom(env.authJwtSecret ?? ""),
    issuer: env.authJwtIssuer ?? "hahart",
    audience: env.authJwtAudience ?? "hahart-api",
    ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
  });
  const auth =
    options.auth ??
    selectRequestAuthenticator(env, {
      supabase: () => createSupabaseRequestAuthenticator(env),
      self: () =>
        createSelfRequestAuthenticator({
          token: buildSelfTokenConfig(),
          findUserById: (id) => findUserById(getTransactionPool(databaseEnv), id),
          isSessionActive: (sid, at) =>
            isSessionActive(getTransactionPool(databaseEnv), sid, at),
        }),
    });
  const identityReadRepository =
    options.identityReadRepository ??
    createIdentityReadRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 20B: the project read repository is built the same way
  // — lazily and against the same transaction pool — so `buildApp` still never
  // connects and never requires `DATABASE_URL`.
  const projectReadRepository =
    options.projectReadRepository ??
    createProjectReadRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 20C: canvas reads inherit the project ACL, so the canvas
  // read repository is built the same lazy way and handed to the two features
  // that perform them — the canvas service (asset identities, recovery) and the
  // Agent runtime (automatic canvas summary).
  const canvasReadRepository =
    options.canvasReadRepository ??
    createCanvasReadRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 20D: chat and session reads inherit the project ACL, so
  // the chat read repository is built the same lazy way and handed to the two
  // features that perform them — the chat service (sessions, messages, asset
  // identities) and the thread service (the session's thread binding).
  const chatReadRepository =
    options.chatReadRepository ??
    createChatReadRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 21B: the chat write path (message insert, the
  // lost-response confirmation, the session touch) goes through its own narrow
  // repository, built lazily against the same pool. It is built here and handed
  // to the chat service below, so the runtime has no PostgREST fallback to fall
  // back TO: with no pool the write fails closed as a `ChatWriteError`.
  const chatWriteRepository =
    options.chatWriteRepository ??
    createChatWriteRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 21C: the session CRUD (open, rename, delete a
  // conversation) goes through its own narrow repository, built lazily against
  // the same pool and handed to the chat service below. Like 21B's write path it
  // has no PostgREST fallback to fall back TO: with no pool the call fails closed
  // as a `ChatSessionWriteError`.
  const chatSessionWriteRepository =
    options.chatSessionWriteRepository ??
    createChatSessionWriteRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 21D: the display-name write behind
  // `PATCH /api/viewer/profile` goes through its own narrow repository, built
  // lazily against the same pool and handed to the viewer routes below. Like the
  // 21B/21C write paths it has no PostgREST fallback to fall back TO: with no
  // pool, or with a missing profile row, the call fails closed as a
  // `ProfileWriteError` and the route keeps its existing 500 projection.
  const profileWriteRepository =
    options.profileWriteRepository ??
    createProfileWriteRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 21E1: the single-key `workspace_settings.default_model`
  // upsert behind `PUT /api/workspace/settings` goes through its own narrow
  // repository, built lazily against the same pool and handed to the settings
  // service below. Like the 21B/21C/21D write paths it has no PostgREST fallback
  // to fall back TO: with no pool, with no repository, or with a caller that is
  // not an owner/admin member of the target workspace, the write fails closed as
  // a `WorkspaceSettingsWriteError` and the route keeps its existing 500
  // `settings_update_failed` projection. The READ path
  // (`getWorkspaceSettings`) followed it off the user-scoped client in workorder
  // 21L: it is wired at the settings service below, and the service no longer
  // receives a user client at all.
  const workspaceSettingsWriteRepository =
    options.workspaceSettingsWriteRepository ??
    createWorkspaceSettingsWriteRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 21F: the atomic attempt counter the worker runs before
  // it starts a job. It is built here, lazily, exactly like the other
  // repositories, and handed to the job service below. The worker process builds
  // its own instance from the same getter (`worker.ts`); the app needs one only
  // because `buildApp` is also the entry point tests drive the job service
  // through. With no pool the call fails closed as a `JobAttemptWriteError` and
  // the service reports its existing `job_query_failed` — the old
  // `increment_job_attempt` RPC is no longer reachable from either entry point.
  const jobAttemptRepository =
    options.jobAttemptRepository ??
    createJobAttemptRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 21H2: the write that records WHICH transaction paid for
  // a job — and the two statements that compensate a charge which was taken but
  // never linked. Built lazily against the same pool, exactly like the
  // repositories above, and handed to the job service below. Like them it has no
  // PostgREST fallback to fall back TO: with no pool, or with no repository, the
  // call fails closed as a `JobCreditsLinkError` and the service reports its
  // existing `job_query_failed` 500 — which is what turns an unattributed charge
  // into a request that fails loudly instead of one that silently keeps the
  // money.
  const jobCreditsLinkRepository =
    options.jobCreditsLinkRepository ??
    createJobCreditsLinkRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 21G: the two server-only `agent_runs` writes — the
  // accepted insert and the run metadata update — go through their own narrow
  // repository, built lazily against the same pool and handed to the agent run
  // metadata service below. Like the 21B/21C/21D/21E1/21F write paths it has no
  // PostgREST fallback to fall back TO: with no pool, or with no repository, the
  // write fails closed as an `AgentRunWriteError` and the service keeps its
  // existing `AgentRunPersistenceError` projection.
  const agentRunWriteRepository =
    options.agentRunWriteRepository ??
    createAgentRunWriteRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 20E: the read-only lookups the WRITE flows perform (the
  // project existence/ownership check before an upload or an archive, and the
  // asset row the upload reads back) go through the same lazily-built pool. The
  // repositories are built here and handed to the two services that write; no
  // statement of their own is a write.
  const assetReadRepository =
    options.assetReadRepository ??
    createAssetReadRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  // ADR-0001 / workorder 20F-A: the member list behind
  // `GET /api/admin/team/members` is the PostgreSQL repository's read, built
  // lazily against the same pool as the other repositories. The service is
  // handed the repository here, so production never runs the read without one.
  const teamAdminReadRepository =
    options.teamAdminReadRepository ??
    createTeamAdminReadRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  const teamMembershipService =
    options.teamMembershipService ??
    createTeamMembershipService({ identityReadRepository });
  const teamAdminService =
    options.teamAdminService ??
    createTeamAdminService({
      getAdminClient,
      teamMembership: teamMembershipService,
      teamAdminReadRepository,
    });
  // BL-12 / BL-01 / workorder 37V: the admin credit writes sit beside the member
  // administration they serve. The factory takes the pool GETTER, not a pool, so
  // this line is the whole lazy wiring: no connection at startup, and a missing
  // DATABASE_URL fails the write (500) instead of the process.
  const adminCreditWriteRepository =
    options.adminCreditWriteRepository ??
    createAdminCreditWriteRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  const viewerService =
    options.viewerService ??
    createViewerService({
      getAdminClient,
      identityReadRepository,
      teamMembership: teamMembershipService,
    });
  const assetRecordRepository = createAssetRecordRepository({
    getTransactionPool: () => getTransactionPool(databaseEnv),
  });
  const projectService =
    options.projectService ??
    createProjectService({
      createUserClient,
      viewerService,
      assetRecordRepository,
      projectReadRepository,
      // ADR-0001 / workorder 21AA: the three project writes — archive, the
      // thumbnail reference and the name / brand-kit patch — are the write
      // repository's now, built lazily against the same pool as the read
      // repository beside it. Like the other write paths it has no PostgREST
      // fallback: `createUserClient` stays wired for Storage and the
      // `create_project_with_canvas` RPC, and for nothing else in this service.
      projectWriteRepository: createProjectWriteRepository({
        getTransactionPool: () => getTransactionPool(databaseEnv),
      }),
    });
  // ADR-0001 / workorder 21Y: `listKits` reads the caller's own brand kits and
  // the asset rows of those kits through the PostgreSQL repository, built lazily
  // against the same pool as the other repositories and handed to the service
  // here. `brand_kits` and `brand_kit_assets` are owner-only, so the repository
  // keys on the actor alone.
  //
  // ADR-0001 / workorder 21Z: the remaining reads and EVERY write of the service
  // now have the same two homes — `brand-kit-read-repository.ts` for the detail,
  // its assets, its file paths, the next `sort_order` and a single asset row, and
  // `brand-kit-write-repository.ts` for the eight write statements. Both are lazy
  // (a pool getter, never a resolved pool), and `createUserClient` stays wired for
  // Storage only: the upload, copy, remove and signing calls are workorder 22A and
  // did not move.
  // ADR-0001 / workorder 21AC: the brand kit read repository is built ONCE and
  // shared. It backs `GET /api/brand-kits` and the detail path through the
  // service, and (since this workorder) the Agent's `get_brand_kit` tool, which
  // used to read the two tables on the caller's PostgREST client. Two instances
  // would be two owners of the same ACL translation, so there is exactly one.
  const brandKitReadRepository: BrandKitReadRepository =
    createBrandKitReadRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  const brandKitService =
    options.brandKitService ??
    createBrandKitService({
      createUserClient,
      brandKitReadRepository,
      brandKitWriteRepository: createBrandKitWriteRepository({
        getTransactionPool: () => getTransactionPool(databaseEnv),
      }),
    });
  const canvasService =
    options.canvasService ??
    createCanvasService({
      createUserClient,
      assetRecordRepository,
      canvasReadRepository,
    });
  const threadService =
    options.threadService ?? createThreadService({ chatReadRepository });
  const chatService =
    options.chatService ??
    createChatService({
      createUserClient,
      chatReadRepository,
      chatWriteRepository,
      chatSessionWriteRepository,
      threadService,
    });
  const agentRunMetadataService =
    options.agentRunMetadataService ??
    createAgentRunMetadataService({ agentRunWriteRepository });
  const agentPersistenceService =
    options.agentPersistenceService ?? createAgentPersistenceService(env);
  const settingsService =
    options.settingsService ??
      createSettingsService({
        defaultModel: resolveDefaultAgentModel(env),
        workspaceSettingsWriteRepository,
        // ADR-0001 / workorder 21L: the READ of the same table moved off the
        // user-scoped PostgREST client and onto its own narrow repository, built
        // lazily against the same pool as the repositories above. It is built
        // inline here on purpose: it has exactly one caller. With no pool, or
        // with a caller who is not a member of that workspace, the read fails
        // closed or answers the default model — never PostgREST.
        workspaceSettingsReadRepository: createWorkspaceSettingsReadRepository({
          getTransactionPool: () => getTransactionPool(databaseEnv),
        }),
      });
  // ADR-0001 / workorder 21AA: the asset row delete behind
  // `DELETE /api/assets/:assetId` is the write repository's now, built the same
  // lazy way as the read repository above. `assetReadRepository` stays exactly
  // as it was — it is still the row read `uploadFile`, `deleteAsset` and (since
  // this workorder) `getAssetUrl` all use. Storage and the
  // `record_project_asset` RPC keep `createUserClient` / `getAdminClient`.
  //
  // Workorder 21AC: the SAME instance is handed to the Agent runtime, because the
  // compensation that removes the metadata row of a failed signing is that same
  // delete with that same policy. Storage and the RPC still keep the clients.
  const assetWriteRepository = createAssetWriteRepository({
    getTransactionPool: () => getTransactionPool(databaseEnv),
  });
  // GN-11: provenance goes onto the asset row an upload just created, so the
  // upload service records it — lazily against the same pool as its neighbours.
  const assetProvenanceRepository = createAssetProvenanceRepository({
    getTransactionPool: () => getTransactionPool(databaseEnv),
  });
  const uploadService =
    options.uploadService ??
    createUploadService({
      createUserClient,
      assetRecordRepository,
      projectReadRepository,
      assetReadRepository,
      assetWriteRepository,
      assetProvenanceRepository,
    });
  const pgmq = createQueueClient(env);
  const jobService =
    options.jobService ??
    (pgmq
      ? createJobService({
          createUserClient,
          getAdminClient,
          pgmq,
          jobAttemptRepository,
          jobCreditsLinkRepository,
          // Workorder 39F (GN-33): the one-transaction create-and-charge
          // entry. Built lazily against the same pool; nothing calls it yet.
          chargedJobWriteRepository: createChargedJobWriteRepository({
            getTransactionPool: () => getTransactionPool(databaseEnv),
          }),
          // ADR-0001 / workorder 21I: the admin single-row read behind
          // `getJobAdmin` — the job watcher's poll and the agent runtime's
          // re-read. Built lazily against the same pool as the repositories
          // above, and with the same consequence: no repository means the read
          // fails closed as the service's existing `job_query_failed` 500,
          // because the admin client it used to read through is no longer
          // reachable from that method.
          jobAdminReadRepository: createJobAdminReadRepository({
            getTransactionPool: () => getTransactionPool(databaseEnv),
          }),
          // ADR-0001 / workorder 21T: the caller's OWN job reads behind `getJob`
          // and `listJobs` — `GET /api/jobs/:jobId` and `GET /api/jobs`. Built
          // lazily against the same pool as the repositories above, and with the
          // same consequence: no repository means both reads fail closed as the
          // service's existing `job_query_failed` 500, because the user client
          // they used to read through is no longer reachable from those methods.
          jobOwnerReadRepository: createJobOwnerReadRepository({
            getTransactionPool: () => getTransactionPool(databaseEnv),
          }),
          // ADR-0001 / workorder 21U: the caller cancelling their OWN job behind
          // `cancelJob` — `POST /api/jobs/:jobId/cancel`, and the reaction
          // `withBilling` runs when a charge fails. Built lazily against the same
          // pool as the repositories above, and with the same consequence: no
          // repository means the cancel fails closed as the service's existing
          // `job_cancel_failed` 500, because the user client it used to write
          // through is no longer reachable from that method. `createUserClient`
          // stays wired for `createJob`, which still reads and writes through it.
          jobOwnerWriteRepository: createJobOwnerWriteRepository({
            getTransactionPool: () => getTransactionPool(databaseEnv),
          }),
          // ADR-0001 / workorder 21M: the four guarded status transitions
          // (`markRunning`/`markRetrying`/`markSucceeded`/`markFailed`). Built
          // lazily against the same pool as the repositories above, exactly like
          // the admin read beside it. With no pool each transition fails closed
          // as the service's existing `job_query_failed` 500, because the
          // caller-chosen `from` list and patch object this replaces are no
          // longer reachable from those methods.
          jobTransitionRepository: createJobTransitionRepository({
            getTransactionPool: () => getTransactionPool(databaseEnv),
          }),
          // ADR-0001 / workorder 21V: the two authorization reads behind
          // `createJob` — "which project is this canvas's?" and "may this caller
          // use this project?" — now go through the repositories that already
          // answer those two questions elsewhere: `canvasReadRepository` is the
          // instance the canvas service and the Agent runtime use, and
          // `projectReadRepository` the one the project and upload flows use.
          // Both are reused as-is rather than rebuilt, so there is one statement
          // per question in the process. With neither of them the reads fail
          // closed as the service's existing `job_create_failed` 500, because the
          // caller's client is no longer reachable from those two branches.
          canvasReadRepository,
          projectReadRepository,
        })
      : undefined);
  // ADR-0001 / workorder 21K: the transaction list and the subscription row go
  // through the pure `pg` repository, built lazily against the same pool as the
  // repositories above. The admin client stays: every other method of this
  // service still uses it. With no repository wired those two reads fail closed
  // as their existing `credit_query_failed` 500 rather than falling back.
  const baseCreditService =
    options.creditService ??
    createCreditService({
      getAdminClient,
      creditReadRepository: createCreditReadRepository({
        getTransactionPool: () => getTransactionPool(databaseEnv),
      }),
    });
  // ADR-0001 / workorder 21J: the plan's concurrency count goes through the
  // pure `pg` repository, built lazily against the same pool as the repositories
  // above. `createTierGuard` no longer receives a Supabase client at all: with no
  // pool the count fails, and `checkConcurrency` keeps its existing fail-open
  // behaviour (log a fixed line, allow the request) instead of falling back.
  const tierGuard =
    options.tierGuard ??
    createTierGuard({
      jobConcurrencyRepository: createJobConcurrencyRepository({
        getTransactionPool: () => getTransactionPool(databaseEnv),
      }),
    });
  // 工单31B: the charge stops being a constant compiled into `@loomic/shared` and
  // becomes a QUOTE against `pricing_rules` (BL-14 第 3 条 / GN-07). Both halves
  // are built lazily against the same pool as everything above:
  //
  //   pricingRuleRepository  — read the candidate rules and "is this model known"
  //   creditLedgerWriteRepository — INSERT the 0-amount consume row a PENDING
  //                                 price leaves behind (metadata.price_pending)
  //
  // `withBilling` throws when billing is on and `priceQuoter` is missing, so the
  // wiring below is the single line that keeps the whole app from being free.
  const pricingRuleRepository = createPricingRuleRepository({
    getTransactionPool: () => getTransactionPool(databaseEnv),
  });

  const priceQuoter =
    options.priceQuoter ?? createPriceQuoter({ pricingRuleRepository });
  const creditLedgerWriteRepository = createCreditLedgerWriteRepository({
    getTransactionPool: () => getTransactionPool(databaseEnv),
  });

  // BL-45 / workorder 37Q: `GET /api/credits` also carries the three pools and
  // the ONE available-credit figure. `createPoolBalanceReadRepository` wants an
  // already-created pool, so this wrapper builds it per read against the same
  // pool as every other repository above: no connection at startup, and a
  // missing DATABASE_URL fails the request (500 `credit_query_failed`) instead
  // of the process.
  const poolBalanceReadRepository: PoolBalanceReadRepository = {
    readPoolBalances: (input) =>
      createPoolBalanceReadRepository({
        pool: getTransactionPool(databaseEnv),
      }).readPoolBalances(input),
  };

  const memberCreditReadRepository: MemberCreditReadRepository =
    options.memberCreditReadRepository ??
    createMemberCreditReadRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });

  // BL-45 / workorder 37R: today's daily grant, placed by the same balance read
  // before it reads the pools. `createPoolGrantWriteRepository` takes the pool
  // GETTER rather than a pool, so this one line is the whole lazy wiring: no
  // connection at startup, and a missing DATABASE_URL fails the grant (which the
  // route logs and skips) instead of the process.
  const poolGrantWriteRepository = createPoolGrantWriteRepository({
    getTransactionPool: () => getTransactionPool(databaseEnv),
  });

  // BL-06 / workorder 38U: `GET /api/credits/transactions` reads this member's
  // lines out of the TEAM workspace while the switch below is on. Same lazy
  // wrapper as `poolBalanceReadRepository` above: the pool is resolved per read,
  // so no connection is made at startup and a missing DATABASE_URL fails the
  // request (the existing `credit_query_failed` 500) instead of the process.
  const poolTransactionReadRepository: PoolTransactionReadRepository = {
    listMemberPoolTransactions: (input) =>
      createPoolTransactionReadRepository({
        pool: getTransactionPool(databaseEnv),
      }).listMemberPoolTransactions(input),
  };

  // Workorder 37T: `LOOMIC_CREDIT_POOLS=on` moves the charge, the refund and the
  // balance pre-check onto the three pools. Anything else leaves the credit
  // service exactly as built above.
  //
  // Workorder 38I: the same one value decides the WHOLE wiring of this app, not
  // just the credit service. With the switch off the routes below are handed no
  // pool read and no pool grant either, so a switched-off server answers exactly
  // the payload it answered before the pools existed and writes no pool row —
  // otherwise the old single balance and a second "available" figure would be
  // served side by side and the sender could not tell which one was charged.
  const creditPools = creditPoolsEnabled();
  const pooledCreditService: CreditService = creditPools
    ? withCreditPools(baseCreditService, {
        ...createCreditPoolWriteRepository({
          getTransactionPool: () => getTransactionPool(databaseEnv),
        }),
        readPoolBalances: (input) =>
          poolBalanceReadRepository.readPoolBalances(input),
      })
    : baseCreditService;

  // AD-01 / BL-21 / workorder 39P: the administrator's generation pause, applied
  // to the FINAL service — AFTER the pools wrapper and OUTSIDE its branch, because
  // a suspended member must be refused with the pools on AND off. Putting it
  // inside either branch would make the refusal depend on a switch that has
  // nothing to do with whether somebody was paused.
  //
  // An INJECTED `options.creditService` is left exactly as the caller handed it
  // over: it is a complete implementation, and the routes' own tests inject
  // doubles that predate 39P and do not carry `isGenerationPaused`. Wrapping one
  // of those with a real database read would make every route test perform a
  // pause query it never asked for (and fail closed on the missing pool), which is
  // exactly the "an old substitute keeps the old flow" rule of 39P (E-020).
  // Production never injects the service, so the gate is always present there.
  const creditService: CreditService =
    options.creditService !== undefined && options.creditService !== null
      ? pooledCreditService
      : withGenerationPause(
          pooledCreditService,
          createMemberPauseReadRepository({
            getTransactionPool: () => getTransactionPool(databaseEnv),
          }),
        );

  // BL-40 / D-27: the Lemon Squeezy subscription link is retired, so no payment
  // service is constructed and no `LEMON_SQUEEZY_*` value is read here at all.
  // The retired routes are registered unconditionally below, whatever the env.

  const connectionManager = options.connectionManager ?? new ConnectionManager();
  const eventBuffer = new CanvasEventBuffer();
  setInterval(() => eventBuffer.cleanup(), 5 * 60 * 1000);
  // ADR-0001 / workorder 21AC: the Agent run's two skill reads — the enabled
  // skills of its workspace and their bundled files — are PostgreSQL reads now, so
  // this repository is built exactly like the others above: lazily, against the
  // same pool, with no fallback. The read fails closed as "no workspace skills"
  // (the Agent's existing degradation) rather than reaching PostgREST.
  const workspaceSkillReadRepository = createWorkspaceSkillReadRepository({
    getTransactionPool: () => getTransactionPool(databaseEnv),
  });
  // ADR-0001 / workorder 21AE: the nineteen skill table calls of the two HTTP
  // files — the skills registry, its files and the per-workspace installs — are
  // PostgreSQL now, so this repository is built exactly like the others above:
  // lazily, against the same pool, with no fallback. A missing pool is a failure
  // on the call, never a silent return to PostgREST.
  const skillRepository =
    options.skillRepository ??
    createSkillRepository({
      getTransactionPool: () => getTransactionPool(databaseEnv),
    });
  const agentRuns = createAgentRunService({
    agentPersistenceService,
    ...(options.agentFactory ? { agentFactory: options.agentFactory } : {}),
    agentRunMetadataService,
    // Workorder 21AC: the row delete of a failed signing, and the three reads the
    // Agent side performs — the canvas → project link, the brand kit and the
    // workspace skills. All four are the SAME instances the HTTP flows use; none
    // of them is constructed twice.
    assetWriteRepository,
    // Workorder 44E: threaded to the Agent side, same instance; unused until 44F.
    assetRecordRepository,
    brandKitReadRepository,
    workspaceSkillReadRepository,
    // Workorder 21S: the Agent runtime reads the row behind an attachment's
    // `assetId` through the same repository the upload/project flows use.
    assetReadRepository,
    canvasReadRepository,
    connectionManager,
    createUserClient,
    ...(options.agentModel ? { model: options.agentModel } : {}),
    ...(options.mockEventDelayMs === undefined
      ? {}
      : { eventDelayMs: options.mockEventDelayMs }),
    env,
    ...(jobService ? { jobService } : {}),
    creditService,
    tierGuard,
    // 工单31B: the two dependencies of the price quote, on the same path the
    // tier guard already takes into the Agent runtime.
    priceQuoter,
    creditLedgerWriteRepository,
    viewerService,
  });

  // 工单40Y / OP-17：安全响应头挂在 onSend 上，CORS 拒绝、错误响应也一并覆盖。
  registerSecurityHeaders(app);

  app.addHook("onRequest", async (request, reply) => {
    const corsResult = evaluateCors(request, env.webOrigin);

    if (!corsResult.allowed) {
      return reply.code(403).send({
        message: "Origin not allowed",
      });
    }

    if (corsResult.allowOrigin) {
      reply.header("access-control-allow-origin", corsResult.allowOrigin);
      reply.header("vary", "Origin");
    }

    if (corsResult.isBrowserRequest) {
      reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      reply.header(
        "access-control-allow-headers",
        resolveAllowedHeaders(
          request.headers["access-control-request-headers"],
        ),
      );
    }

    if (corsResult.isPreflight) {
      return reply.code(204).send();
    }
  });

  // AD-08 / PJ-11 member gate. Registered after CORS so preflight is answered
  // first, and before the routes so it covers every /api/ handler below.
  registerTeamGate(app, {
    auth,
    teamMembership: teamMembershipService,
  });

  // Workorder 42D: self-hosted sign-up / sign-in / refresh / sign-out. Not
  // registered under the default (Supabase) provider.
  if (env.authProvider === "self") {
    void registerAuthRoutes(app, {
      pool: () => getTransactionPool(databaseEnv),
      token: buildSelfTokenConfig(),
    });
    // Workorder 42E: administrator password reset (temporary password) and the
    // member's own password change, same self-provider condition.
    void registerAuthPasswordRoutes(app, {
      auth,
      teamMembership: teamMembershipService,
      pool: () => getTransactionPool(databaseEnv),
    });
  }

  // Workorder 43E: the read route of the private file volume. The signed link is
  // the credential (an `<img>` / `<video>` cannot send an Authorization header),
  // so the route is registered only when the volume is the chosen backend.
  if (env.storageProvider === "fs") {
    void registerObjectRoutes(app, {
      store: createObjectStore(env, {
        supabaseClient: () => getAdminClient() as unknown as SupabaseStorageLike,
      }),
      secret: objectUrlSecretFrom(env.objectUrlSecret!),
    });
  }

  void registerHealthRoutes(app, env);
  // Dev-only: no-ops itself in production. See dev-client-errors.ts.
  void registerDevClientErrorRoutes(app);
  void registerFontsRoutes(app, { env });
  void registerImageProxyRoute(app);
  void registerRunRoutes(app, agentRuns, {
    agentRunMetadataService,
    auth,
    settingsService,
    threadService,
    viewerService,
  });
  void registerViewerRoutes(app, {
    auth,
    creditService,
    profileWriteRepository,
    viewerService,
  });
  void registerBrandKitRoutes(app, {
    auth,
    brandKitService,
  });
  // ED-00k / workorder 21AB: the per-image tool definition table. It is static
  // configuration, so the registration needs nothing but the authenticator.
  void registerToolRoutes(app, {
    auth,
    // ED-00m: `POST /api/tools/:toolId/run` bills through the same price table
    // and tier guard as the generate routes.
    creditService,
    viewerService,
    ...(jobService ? { jobService } : {}),
    ...(tierGuard ? { tierGuard } : {}),
    priceQuoter,
    creditLedgerWriteRepository,
    ...(connectionManager ? { connectionManager } : {}),
  });
  void registerAdminTeamRoutes(app, {
    auth,
    teamAdminService,
    teamMembership: teamMembershipService,
  });
  // BL-12 / BL-01 / AD-01 / workorder 37V: the two credit writes of the same
  // admin surface, registered right after it and behind the same admin gate.
  void registerAdminTeamCreditRoutes(app, {
    auth,
    teamMembership: teamMembershipService,
    adminCreditWriteRepository,
    memberCreditReadRepository,
  });
  void registerProjectRoutes(app, {
    auth,
    projectService,
    teamAdminService,
  });
  void registerCanvasRoutes(app, {
    auth,
    canvasService,
    teamAdminService,
  });
  void registerSettingsRoutes(app, {
    auth,
    settingsService,
    viewerService,
  });
  void registerModelRoutes(app, env);
  void registerImageModelRoutes(app, { auth, creditService, viewerService });
  void registerVideoModelRoutes(app, { auth, creditService, viewerService });
  void registerChatRoutes(app, {
    auth,
    chatService,
    teamAdminService,
  });
  void registerUploadRoutes(app, {
    auth,
    teamAdminService,
    uploadService,
    viewerService,
  });
  void registerGenerateRoutes(app, {
    auth,
    creditService,
    uploadService,
    viewerService,
    ...(jobService ? { jobService } : {}),
    ...(tierGuard ? { tierGuard } : {}),
    // 工单31B: the price table + the pending ledger row, on the same path the
    // tier guard takes into these routes.
    priceQuoter,
    creditLedgerWriteRepository,
    // Lets the video route push job.progress instead of holding the request open.
    ...(connectionManager ? { connectionManager } : {}),
  });
  void registerCreditRoutes(app, {
    auth,
    creditService,
    viewerService,
    // BL-45 / workorder 37Q: the three pools ride along on the balance.
    // BL-45 / workorder 37R: and today's daily grant is placed before the read.
    // BL-06 / workorder 38U: and the transaction list is read out of the team
    // workspace, where the pools write their charges and refunds.
    // Workorder 38I: all three only while `LOOMIC_CREDIT_POOLS=on`; with it off
    // the route is registered with the pre-pools arguments (no `pools` key in the
    // payload, no daily grant written, and the old personal ledger listed).
    ...(creditPools
      ? {
          poolBalanceReadRepository,
          poolGrantWriteRepository,
          poolTransactionReadRepository,
        }
      : {}),
  });
  // GN-01 / workorder 31D: the quote endpoint sits next to the balance it
  // returns. It is handed no ledger, no job service and no deduction dependency
  // (ruling 8), so "a quote cannot touch the balance or the ledger" is a
  // property of its wiring rather than a promise in a comment.
  void registerPricingRoutes(app, {
    auth,
    creditService,
    priceQuoter,
    viewerService,
    // BL-45 / workorder 39D: the balance a quote carries includes the same three
    // pools `GET /api/credits` reports, from the same repository. Workorder 38I:
    // only while `LOOMIC_CREDIT_POOLS=on`; with it off the quote is registered
    // with the pre-pools arguments and its balance has no `pools` key at all.
    ...(creditPools ? { poolBalanceReadRepository } : {}),
  });
  if (jobService) {
    // GN-32 / workorder 36E-v2: refunding a cancel that happened BEFORE the job
    // started. Built from the same two pieces the worker refunds with — the
    // narrow `pg` read and the credits service — and told its own description so
    // the ledger line says "canceled before start" rather than "failed". The
    // route decides WHEN (the cancelled row has no `started_at`); this decides
    // HOW MUCH, and it never throws, so a cancel cannot be failed by its refund.
    const cancelRefund = createRefundJob({
      readRefundBasis: (refundInput) =>
        createJobRefundBasisRepository({
          getTransactionPool: () => getTransactionPool(databaseEnv),
        }).readRefundBasis(refundInput),
      creditService,
      description: CANCEL_REFUND_DESCRIPTION,
      // BL-41 / workorder 39K: a cancel refund that fails is recorded for the
      // compensation queue instead of vanishing with its log line. Same lazy
      // `getTransactionPool(databaseEnv)` wrapper as the reader above, and the
      // same `markLinkRefunded: false` as the worker (a cancel refunds a job that
      // has its `credits_cost`; the link mark belongs to with-billing).
      recordCompensation: async (compensationInput) => {
        await createRefundCompensationRepository({
          getTransactionPool: () => getTransactionPool(databaseEnv),
        }).record({ ...compensationInput, markLinkRefunded: false });
      },
    });
    void registerJobRoutes(app, {
      auth,
      creditService,
      jobService,
      tierGuard,
      priceQuoter,
      creditLedgerWriteRepository,
      viewerService,
      // GN-35 / workorder 36K: what one job cost, what came back, and which
      // ledger row paid for it. The statement itself is owner-scoped
      // (`created_by` is the acting user), so the route needs no extra rule.
      jobCreditsReadRepository: createJobCreditsReadRepository({
        getTransactionPool: () => getTransactionPool(databaseEnv),
      }),
      // GN-03 / workorder 38D: the job status poll also carries the three pools
      // and the one available figure, so the top bar and the account centre do
      // not need a second call. Same lazy wrapper as `GET /api/credits`: no
      // connection at startup, and a missing DATABASE_URL fails the pool read
      // (which the route logs and answers as `balance: null`) rather than the
      // status itself. Workorder 38I: only while `LOOMIC_CREDIT_POOLS=on`; with
      // it off the status carries no `balance` key at all.
      ...(creditPools ? { poolBalanceReadRepository } : {}),
      // The tag is the call site's, exactly as the worker passes its own: both
      // log lines of a cancel refund are attributable to this route.
      refundCanceledJob: (canceledJobId: string) =>
        cancelRefund(canceledJobId, "[cancel]"),
    });
  }
  void registerSkillRoutes(app, { auth, skillRepository, viewerService });
  void registerMarketplaceRoutes(app, { auth, skillRepository, viewerService });

  // BL-40 / D-27: the payment routes answer 410 for every caller. They are
  // registered with no condition at all, so a configured `LEMON_SQUEEZY_*` env
  // cannot bring the payment service (or a credit grant) back.
  void registerRetiredPaymentRoutes(app);

  return app;
}

type CorsResult = {
  allowed: boolean;
  allowOrigin: string | null;
  isBrowserRequest: boolean;
  isPreflight: boolean;
};

function evaluateCors(request: FastifyRequest, webOrigin: string): CorsResult {
  const origin = request.headers.origin;
  const isPreflight =
    request.method === "OPTIONS" &&
    typeof request.headers["access-control-request-method"] === "string";

  if (!origin) {
    return {
      allowed: true,
      allowOrigin: null,
      isBrowserRequest: false,
      isPreflight,
    };
  }

  if (origin === webOrigin) {
    return {
      allowed: true,
      allowOrigin: origin,
      isBrowserRequest: true,
      isPreflight,
    };
  }

  if (origin === "null" && isLoopbackHost(request.headers.host)) {
    return {
      allowed: true,
      allowOrigin: origin,
      isBrowserRequest: true,
      isPreflight,
    };
  }

  return {
    allowed: false,
    allowOrigin: null,
    isBrowserRequest: true,
    isPreflight,
  };
}

function resolveAllowedHeaders(requestHeaders: string | undefined) {
  return requestHeaders?.trim() || "Content-Type";
}

function isLoopbackHost(host: string | undefined) {
  if (!host) {
    return false;
  }

  if (host.startsWith("[")) {
    return host.startsWith("[::1]");
  }

  const [hostname] = host.split(":");
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  );
}
