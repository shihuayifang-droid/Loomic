import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

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
import {
  createJobCreditsLinkRepository,
  type JobCreditsLinkRepository,
} from "./db/job-credits-link-repository.js";
import {
  createAgentRunWriteRepository,
  type AgentRunWriteRepository,
} from "./db/agent-run-write-repository.js";
import { DATABASE_URL_ENV_KEY, getTransactionPool } from "./db/pool.js";
import { createPgmqClient } from "./queue/pgmq-client.js";
import {
  createCreditService,
  type CreditService,
} from "./features/credits/credit-service.js";
import {
  createTierGuard,
  type TierGuard,
} from "./features/credits/tier-guard.js";
import {
  createJobService,
  type JobService,
} from "./features/jobs/job-service.js";
import { createLemonSqueezyClient } from "./features/payments/lemon-squeezy-client.js";
import {
  createPaymentService,
  buildVariantMap,
  type PaymentService,
} from "./features/payments/payment-service.js";
import { registerPaymentRoutes } from "./http/payments.js";
import { registerPaymentWebhookRoute } from "./http/payments-webhook.js";
import { registerCreditRoutes } from "./http/credits.js";
import { registerFontsRoutes } from "./http/fonts.js";
import { registerJobRoutes } from "./http/jobs.js";
import { registerAdminTeamRoutes } from "./http/admin-team.js";
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
import { registerUploadRoutes } from "./http/uploads.js";
import { registerSkillRoutes } from "./http/skills.js";
import { registerMarketplaceRoutes } from "./http/skills-marketplace.js";
import { registerViewerRoutes } from "./http/viewer.js";
import { CanvasEventBuffer } from "./ws/event-buffer.js";
import { ConnectionManager } from "./ws/connection-manager.js";
import { registerWsRoute } from "./ws/handler.js";
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
  void app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
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
  const auth = options.auth ?? createSupabaseRequestAuthenticator(env);
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
  const viewerService =
    options.viewerService ??
    createViewerService({
      getAdminClient,
      identityReadRepository,
      teamMembership: teamMembershipService,
    });
  const projectService =
    options.projectService ??
    createProjectService({
      createUserClient,
      viewerService,
      getAdminClient,
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
      getAdminClient,
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
  const uploadService =
    options.uploadService ??
    createUploadService({
      createUserClient,
      getAdminClient,
      projectReadRepository,
      assetReadRepository,
      assetWriteRepository,
    });
  const pgmq = env.supabaseDbUrl
    ? createPgmqClient(env.supabaseDbUrl)
    : undefined;
  const jobService =
    options.jobService ??
    (pgmq
      ? createJobService({
          createUserClient,
          getAdminClient,
          pgmq,
          jobAttemptRepository,
          jobCreditsLinkRepository,
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
  const creditService =
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

  // Payment service — only created when Lemon Squeezy is configured
  let paymentService: PaymentService | undefined = options.paymentService;
  if (!paymentService && env.lemonSqueezyApiKey && env.lemonSqueezyStoreId) {
    const lsClient = createLemonSqueezyClient({
      apiKey: env.lemonSqueezyApiKey,
      storeId: env.lemonSqueezyStoreId,
    });
    paymentService = createPaymentService({
      lemonSqueezy: lsClient,
      getAdminClient,
      variantMap: buildVariantMap(env),
      webOrigin: env.webOrigin,
    });
  }

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
    brandKitReadRepository,
    workspaceSkillReadRepository,
    // Workorder 21S: the Agent runtime reads the row behind an attachment's
    // `assetId` through the same repository the upload/project flows use.
    assetReadRepository,
    canvasReadRepository,
    connectionManager,
    createUserClient,
    // X-52: the Agent-side persistence entry point records asset ownership
    // through the service_role-only `record_project_asset`, so the runtime needs
    // the same admin client every other feature already receives.
    getAdminClient,
    ...(options.agentModel ? { model: options.agentModel } : {}),
    ...(options.mockEventDelayMs === undefined
      ? {}
      : { eventDelayMs: options.mockEventDelayMs }),
    env,
    ...(jobService ? { jobService } : {}),
    creditService,
    tierGuard,
    viewerService,
  });

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
  void registerToolRoutes(app, { auth });
  void registerAdminTeamRoutes(app, {
    auth,
    teamAdminService,
    teamMembership: teamMembershipService,
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
    // Lets the video route push job.progress instead of holding the request open.
    ...(connectionManager ? { connectionManager } : {}),
  });
  void registerCreditRoutes(app, { auth, creditService, viewerService });
  if (jobService) {
    void registerJobRoutes(app, { auth, creditService, jobService, tierGuard, viewerService });
  }
  void registerSkillRoutes(app, { auth, skillRepository, viewerService });
  void registerMarketplaceRoutes(app, { auth, skillRepository, viewerService });

  // Payment routes — only registered when Lemon Squeezy is configured
  if (paymentService) {
    void registerPaymentRoutes(app, { auth, paymentService, viewerService });

    if (env.lemonSqueezyWebhookSecret) {
      // Webhook route is registered in an encapsulated plugin so the custom
      // content-type parser (needed for raw body access) does not leak to
      // other routes.
      void app.register(async (webhookScope) => {
        await registerPaymentWebhookRoute(webhookScope, {
          getAdminClient,
          paymentService: paymentService!,
          webhookSecret: env.lemonSqueezyWebhookSecret!,
        });
      });
    }
  }

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
