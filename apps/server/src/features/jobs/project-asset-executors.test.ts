// X-52 prep (T2): the workers must record WHO OWNS a generated object.
//
// The bug this pins: the executors used to insert `asset_objects` with the JOB's
// workspace — which since Q1 is the personal billing workspace — and no project at
// all. Once the bucket is private, the project that generated an image can no
// longer read it, and nothing in the row says which project it was.
//
// Three properties matter and all three are asserted here:
//   * ownership comes from the job's canvas/project, not from the billing
//     workspace, so the two are passed to the RPC separately;
//   * a metadata failure FAILS the job. An uploaded object with no asset row is
//     the silent success this ticket exists to remove;
//   * the job row is read through `JobService.getJobAdmin` (workorder 21N): the
//     admin client is not a source for it, and asking it for one fails loudly.
//
// Workorder 21W added a fourth property: the decision to watermark reads the
// workspace plan through `ExecutorContext.creditReadRepository`, and EVERY way
// that read can fail — no repository, no row, a thrown error — still produces a
// watermark, because an unreadable plan must never hand a free workspace an
// unwatermarked image. The fake admin answers no subscription row at all now, so
// a case that regresses to the old client-side read fails loudly instead of
// quietly passing.
//
// The provider call and the CDN download are mocked so the file never leaves the
// machine (and never spends money).
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateImage = vi.fn();
const generateVideo = vi.fn();
const applyWatermark = vi.fn();

vi.mock("../../generation/image-generation.js", () => ({
  generateImage: (...args: unknown[]) => generateImage(...args),
}));

vi.mock("../../generation/video-generation.js", () => ({
  generateVideo: (...args: unknown[]) => generateVideo(...args),
}));

vi.mock("../../generation/providers/registry.js", () => ({
  resolveImageProviderName: () => "mock-image-provider",
  resolveVideoProviderName: () => "mock-video-provider",
}));

vi.mock("../credits/watermark.js", () => ({
  applyWatermark: (...args: unknown[]) => applyWatermark(...args),
}));

import type { BackgroundJob, SubscriptionPlan } from "@loomic/shared";
import { jobArtifactSchema } from "@loomic/shared";

import type { AssetRecordRepository, RecordProjectAssetInput } from "../../db/asset-record-repository.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { SubscriptionReadRow } from "../../db/credit-read-repository.js";
import { getExecutor, type ExecutorContext } from "./job-executor.js";
import { createFakeObjectStore, type FakeObjectStore } from "../../test-support/fake-object-store.js";
import type { ObjectStore } from "../storage/object-store.js";
import { ObjectStoreError } from "../storage/object-store.js";

// Importing the executors is what registers them.
import "./executors/image-generation.js";
import "./executors/video-generation.js";

const PERSONAL_WORKSPACE = "ws-personal-billing";
const TEAM_PROJECT = "project-team-1";
const CANVAS = "canvas-1";
const CREATED_BY = "user-1";

/** The fake asset record repository the context hands the executors, keyed by the admin it was made with. */
const recorderByClient = new WeakMap<object, Pick<AssetRecordRepository, "recordProjectAsset">>();

function makeAdmin(options: { recordError?: { message: string } | null } = {}) {
  const records: RecordProjectAssetInput[] = [];
  const uploads: Array<{ bucket: string; path: string; bytes: number }> = [];
  const signCalls: Array<{ bucket: string; path: string; expiresIn: number }> = [];
  const jobRowReads: string[] = [];

  const client = {
    from(table: string) {
      // Workorder 21N: the executors read their job row through
      // `JobService.getJobAdmin`, so the admin client must not be able to serve
      // one. A case that regresses to the old read fails loudly here instead of
      // quietly passing off a client that is no longer the source.
      if (table === "background_jobs") {
        jobRowReads.push(table);
        throw new Error("executor must not read job rows through the admin client");
      }

      // Workorder 21W: the watermark decision no longer asks the admin client
      // for the workspace subscription row — it goes through the credit read
      // repository on the executor context. This branch used to ANSWER with a
      // paid plan, which silently kept the watermark path out of the way; now a
      // case that regresses to the old read fails loudly in this file instead.
      if (table === "subscriptions") {
        throw new Error("executor must not read subscriptions through the admin client");
      }

      const chain = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return chain;
    },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, buffer: { length: number }) => {
            uploads.push({ bucket, path, bytes: buffer.length });
            return { data: { path }, error: null };
          },
          // X-52: the worker signs its result instead of handing out a public URL.
          createSignedUrl: async (path: string, expiresIn: number) => {
            signCalls.push({ bucket, path, expiresIn });
            return {
              data: { signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig` },
              error: null,
            };
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        };
      },
    },
  };

  recorderByClient.set(client, {
    async recordProjectAsset(input) {
      records.push(input);
      if (options.recordError) throw new Error(options.recordError.message);
      return { assetId: "asset-1", workspaceId: input.fallbackWorkspaceId, projectId: input.projectId ?? null };
    },
  });

  return {
    client: client as unknown as AdminSupabaseClient,
    records,
    uploads,
    signCalls,
    jobRowReads,
  };
}

/** The subscription row's nullable columns; no case asserts on these. */
const NULLABLE_SUBSCRIPTION_COLUMNS = {
  billing_period: null,
  stripe_customer_id: null,
  stripe_subscription_id: null,
  current_period_start: null,
  current_period_end: null,
  canceled_at: null,
} satisfies Omit<SubscriptionReadRow, "plan">;

/**
 * Workorder 21W: the substitute for the plan read the image executor's
 * watermark decision goes through, plus every argument it was handed.
 *
 * The default answer is a paid plan, which keeps the watermark path out of the
 * way for the cases that are not about it — that is the job the fake admin's
 * subscription branch used to do, and it is why the cases above still see no
 * watermark.
 */
function makeCreditRead(
  options: { plan?: SubscriptionPlan | null; failWith?: Error } = {},
) {
  const calls: Array<{ workspaceId: string }> = [];
  const repository: NonNullable<ExecutorContext["creditReadRepository"]> = {
    async readSubscription(input) {
      calls.push(input);
      if (options.failWith) throw options.failWith;
      const plan = options.plan === undefined ? "pro" : options.plan;
      if (plan === null) return null;
      return { ...NULLABLE_SUBSCRIPTION_COLUMNS, plan };
    },
  };
  return { repository, calls };
}

/**
 * GN-11: the substitute for the provenance write the executors perform after
 * `record_project_asset`, plus every argument it was handed. Never injected by
 * default, so every case above runs exactly as it did before provenance existed.
 */
type ProvenanceRepository = NonNullable<ExecutorContext["assetProvenanceRepository"]>;
type ProvenanceInput = Parameters<ProvenanceRepository["recordProvenance"]>[0];

function makeProvenance(options: { failWith?: Error } = {}) {
  const calls: ProvenanceInput[] = [];
  const repository: ProvenanceRepository = {
    async recordProvenance(input) {
      calls.push(input);
      if (options.failWith) throw options.failWith;
      return undefined as unknown as Awaited<
        ReturnType<ProvenanceRepository["recordProvenance"]>
      >;
    },
  };
  return { repository, calls };
}

/** The context plus the job ids its service substitute was asked for. */
type TestExecutorContext = ExecutorContext & { jobReads: string[] };

/**
 * T-133 (7th slice): the context also carries the store it was built with, so a
 * case can assert on what was uploaded without reaching into the admin client's
 * storage. `null` is the "worker forgot to wire it" shape.
 */
type TestContext = TestExecutorContext & { store: ObjectStore | null };

/** The single put the executor made, or a loud failure when it made none. */
function onlyPut(store: ObjectStore | null) {
  if (!store) throw new Error("the context carried no objectStore");
  const call = (store as FakeObjectStore).calls.find((entry) => entry.method === "put");
  if (call?.method !== "put") throw new Error("the object store received no put call");
  return call;
}

/**
 * T-133 (9th slice): the single signature the executor asked the store for, or a
 * loud failure when it asked for none. The signature used to travel through the
 * admin client's `storage`, so the cases assert the store received it instead.
 */
function onlySignedReadUrl(store: ObjectStore | null) {
  if (!store) throw new Error("the context carried no objectStore");
  const call = (store as FakeObjectStore).calls.find(
    (entry) => entry.method === "signedReadUrl",
  );
  if (call?.method !== "signedReadUrl") {
    throw new Error("the object store received no signedReadUrl call");
  }
  return call;
}

/**
 * The executor's ONLY source of a job row. Workorder 21N moved that read onto
 * `JobService.getJobAdmin`, so the substitute carries exactly that one method and
 * the case hands it the row it wants the executor to see. Everything else on
 * `BackgroundJob` gets a legal placeholder: no case asserts on those columns.
 *
 * Workorder 21W added the plan substitute on the same pattern: it is injected by
 * default (a paid plan) and a case that wants to drive the watermark path hands
 * in its own. Passing `null` leaves the field off the context entirely, which is
 * the "worker forgot to wire it" shape one of the cases below pins.
 */
function makeContext(
  client: AdminSupabaseClient,
  job: ExecutorJobFixture,
  creditRead: ReturnType<typeof makeCreditRead> | null = makeCreditRead(),
  provenance: ReturnType<typeof makeProvenance> | null = null,
  // Default: the repository the admin was made with. `null` leaves the field off
  // the context entirely (the "worker forgot to wire it" shape).
  recorder: Pick<AssetRecordRepository, "recordProjectAsset"> | null | undefined = undefined,
  // T-133 (7th slice): the ObjectStore the context carries. Omitted → a fresh
  // fake store, because the executors now REQUIRE one. `null` leaves the field
  // off entirely — the "worker forgot to wire it" shape the assembly-error cases
  // below pin.
  objectStore: ObjectStore | null | undefined = undefined,
): TestContext {
  const store = objectStore === undefined ? createFakeObjectStore() : objectStore;
  const assetRecordRepository =
    recorder === undefined ? recorderByClient.get(client) : recorder;
  const jobReads: string[] = [];

  return {
    jobService: {
      getJobAdmin: async (jobId: string): Promise<BackgroundJob> => {
        jobReads.push(jobId);
        return {
          id: jobId,
          thread_id: null,
          queue_name: "image_generation",
          job_type: "image_generation",
          status: "running",
          result: null,
          error_code: null,
          error_message: null,
          attempt_count: 0,
          max_attempts: 3,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          started_at: null,
          completed_at: null,
          failed_at: null,
          canceled_at: null,
          ...job,
        };
      },
    } as unknown as ExecutorContext["jobService"],
    pgmq: {} as ExecutorContext["pgmq"],
    env: {} as ExecutorContext["env"],
    queue: "image_generation",
    msgId: 1,
    renewVt: async () => {},
    // Omitted entirely when the case passed `null`: an optional field that is
    // present-and-undefined is a different shape under
    // `exactOptionalPropertyTypes`, and the executor's check does not care.
    ...(creditRead ? { creditReadRepository: creditRead.repository } : {}),
    // GN-11: same conditional-spread rule; absent unless a case asks for it.
    ...(provenance ? { assetProvenanceRepository: provenance.repository } : {}),
    ...(assetRecordRepository ? { assetRecordRepository } : {}),
    // T-133 (7th slice): same conditional-spread rule; absent only when the case
    // asked for the unwired shape.
    ...(store ? { objectStore: store } : {}),
    jobReads,
    store,
  };
}

/** The six job columns both executors consume, as the service returns them. */
type ExecutorJobFixture = Pick<
  BackgroundJob,
  "created_by" | "workspace_id" | "canvas_id" | "project_id" | "session_id" | "payload"
>;

/** A job whose billing workspace is personal while its project lives in the team. */
function jobRow(overrides: Partial<ExecutorJobFixture> = {}): ExecutorJobFixture {
  return {
    created_by: CREATED_BY,
    workspace_id: PERSONAL_WORKSPACE,
    canvas_id: CANVAS,
    project_id: TEAM_PROJECT,
    session_id: "session-1",
    payload: { prompt: "a cat", model: "test/model" },
    ...overrides,
  };
}

beforeEach(() => {
  generateImage.mockReset();
  generateVideo.mockReset();
  applyWatermark.mockReset();

  generateImage.mockResolvedValue({
    url: "https://provider.test/image.png",
    mimeType: "image/png",
    width: 1024,
    height: 1024,
  });
  // A data URL keeps the video path off the network entirely.
  generateVideo.mockResolvedValue({
    url: "data:video/mp4;base64,AAAA",
    mimeType: "video/mp4",
    width: 1280,
    height: 720,
    durationSeconds: 5,
  });
  applyWatermark.mockImplementation(async (buffer: unknown) => buffer);

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => new ArrayBuffer(32),
    })),
  );
});

describe("generation executors record project asset ownership", () => {
  it("case 1: the image executor passes canvas, project and object path to the asset record repository", async () => {
    const admin = makeAdmin();
    const executor = getExecutor("image_generation");
    expect(executor).toBeDefined();

    const ctx = makeContext(admin.client, jobRow());
    const result = await executor!("job-1", {}, ctx);

    expect(admin.records).toHaveLength(1);
    expect(admin.records[0]).toMatchObject({
      bucket: "project-assets",
      createdBy: CREATED_BY,
      canvasId: CANVAS,
      projectId: TEAM_PROJECT,
      mimeType: "image/png",
    });

    // The object path is what the row is keyed by, so it has to be the uploaded
    // one. T-133 (7th slice): the upload went through the injected store, so the
    // bucket, key and byte count are read off what the store received.
    const put = onlyPut(ctx.store);
    expect(put.ref.bucket).toBe("project-assets");
    expect(put.ref.key).toMatch(
      new RegExp(`^${PERSONAL_WORKSPACE}/generated/[0-9]+-job-1\\.png$`),
    );
    expect(put.options).toEqual({ contentType: "image/png", upsert: false });
    expect(put.size).toBe(32);
    expect(admin.uploads).toHaveLength(0);
    expect(admin.records[0]?.objectPath).toBe(put.ref.key);
    expect(result.asset_id).toBe("asset-1");
    expect(result.object_path).toBe(put.ref.key);
  });

  it("case 1b: the job result carries a SIGNED url, never a public one", async () => {
    const admin = makeAdmin();

    const ctx = makeContext(admin.client, jobRow());
    const result = await getExecutor("image_generation")!("job-1b", {}, ctx);

    // X-52: the worker signs what it just recorded. A permanent public URL here
    // would survive the bucket going private as a dead link. T-133 (9th slice):
    // the signature goes through the injected store, so the key it was handed is
    // what this case asserts on — and the admin client signs nothing.
    const key = onlyPut(ctx.store).ref.key;
    expect(String(result.signed_url)).toContain("?ttl=3600");
    expect(String(result.signed_url)).not.toContain("cdn.test");
    expect(onlySignedReadUrl(ctx.store)).toMatchObject({
      ref: { bucket: "project-assets", key },
      options: { ttlSeconds: 3600 },
    });
    expect(admin.signCalls).toHaveLength(0);
  });

  it("case 2: the video executor does the same for video objects", async () => {
    const admin = makeAdmin();
    const job = jobRow({ payload: { prompt: "a clip", model: "test/video" } });
    const executor = getExecutor("video_generation");
    expect(executor).toBeDefined();

    const ctx = makeContext(admin.client, job);
    const result = await executor!("job-2", {}, ctx);

    expect(admin.records).toHaveLength(1);
    expect(admin.records[0]).toMatchObject({
      bucket: "project-assets",
      createdBy: CREATED_BY,
      canvasId: CANVAS,
      projectId: TEAM_PROJECT,
      mimeType: "video/mp4",
    });
    const put = onlyPut(ctx.store);
    expect(put.ref.bucket).toBe("project-assets");
    expect(put.ref.key).toMatch(
      new RegExp(`^${PERSONAL_WORKSPACE}/generated/[0-9]+-job-2\\.mp4$`),
    );
    expect(put.options).toEqual({ contentType: "video/mp4", upsert: false });
    expect(admin.uploads).toHaveLength(0);
    expect(admin.records[0]?.objectPath).toBe(put.ref.key);

    // X-52: the video's job result is signed too — same rule as the image, and
    // since the 9th slice the same injected store produces the signature.
    const videoKey = put.ref.key;
    expect(String(result.signed_url)).toContain("?ttl=3600");
    expect(String(result.signed_url)).not.toContain("cdn.test");
    expect(onlySignedReadUrl(ctx.store)).toMatchObject({
      ref: { bucket: "project-assets", key: videoKey },
      options: { ttlSeconds: 3600 },
    });
    expect(admin.signCalls).toHaveLength(0);
  });

  it("case 3: billing stays personal while ownership follows the team project", async () => {
    const admin = makeAdmin();

    await getExecutor("image_generation")!("job-3", {}, makeContext(admin.client, jobRow()));

    const params = admin.records[0] ?? ({} as Partial<RecordProjectAssetInput>);
    // The fallback is the ONLY workspace the worker may name, and it is the
    // billing one — the project's workspace is derived by the database, never sent.
    expect(params.fallbackWorkspaceId).toBe(PERSONAL_WORKSPACE);
    expect(params.projectId).toBe(TEAM_PROJECT);
    expect(Object.values(params)).not.toContain("ws-team");
  });

  it("case 4: a job with no project records against the billing workspace only", async () => {
    const admin = makeAdmin();

    await getExecutor("image_generation")!(
      "job-4",
      {},
      makeContext(admin.client, jobRow({ canvas_id: null, project_id: null })),
    );

    expect(admin.records[0]).toMatchObject({
      projectId: null,
      canvasId: null,
      fallbackWorkspaceId: PERSONAL_WORKSPACE,
    });
  });

  it("case 5: a metadata failure fails the job instead of succeeding silently", async () => {
    const admin = makeAdmin({
      recordError: { message: "record_project_asset exploded" },
    });

    const ctx = makeContext(admin.client, jobRow());

    await expect(
      getExecutor("image_generation")!("job-5", {}, ctx),
    ).rejects.toThrow(/record asset ownership/i);

    // The object was uploaded; the point is that the job did NOT report success.
    expect(onlyPut(ctx.store).size).toBe(32);
  });

  it("case 5b: a context without the asset record repository fails the image job", async () => {
    const admin = makeAdmin();

    await expect(
      getExecutor("image_generation")!(
        "job-5b",
        {},
        makeContext(admin.client, jobRow(), makeCreditRead(), null, null),
      ),
    ).rejects.toThrow(/no asset record repository/i);

    expect(admin.records).toHaveLength(0);
  });

  it("case 6: a video metadata failure fails the job too", async () => {
    const admin = makeAdmin({
      recordError: { message: "record_project_asset exploded" },
    });
    const job = jobRow({ payload: { prompt: "a clip", model: "test/video" } });

    await expect(
      getExecutor("video_generation")!("job-6", {}, makeContext(admin.client, job)),
    ).rejects.toThrow(/record asset ownership/i);
  });

  it("case 7: the job row comes from getJobAdmin, never from the admin client", async () => {
    const admin = makeAdmin();
    const ctx = makeContext(admin.client, jobRow());

    await getExecutor("image_generation")!("job-7", {}, ctx);

    // The service read is the ONLY source of a job row, and it is asked for
    // exactly this job.
    expect(ctx.jobReads).toHaveLength(1);
    expect(ctx.jobReads[0]).toBe("job-7");
    // Nothing reached the admin client for a job row. The old read is a loud
    // failure now, so a regression cannot pass this case by staying quiet.
    expect(admin.jobRowReads).toEqual([]);
  });

  // T-133 1b: the upload step now takes an `ObjectStore`. A context that carries
  // one is uploaded through it — nothing reaches the admin client's storage — and
  // the object path, bucket and byte count are the same ones the admin client
  // used to receive. The cases above keep pinning the transition shape (no store
  // on the context) so both paths stay covered.
  it("case 8: a context carrying an objectStore uploads through it", async () => {
    const admin = makeAdmin();
    const store = createFakeObjectStore();

    const result = await getExecutor("image_generation")!(
      "job-8",
      {},
      makeContext(admin.client, jobRow(), makeCreditRead(), null, undefined, store),
    );

    const putCall = store.calls.find((call) => call.method === "put");
    if (putCall?.method !== "put") throw new Error("the object store received no put call");
    expect(putCall.ref.bucket).toBe("project-assets");
    expect(putCall.ref.key).toMatch(
      new RegExp(`^${PERSONAL_WORKSPACE}/generated/[0-9]+-job-8\\.png$`),
    );
    expect(putCall.options).toEqual({ contentType: "image/png", upsert: false });
    expect(putCall.size).toBe(32);

    // The injected store was the one used: the admin client's storage saw nothing.
    expect(admin.uploads).toHaveLength(0);
    expect(store.has(putCall.ref)).toBe(true);
    expect(admin.records[0]?.objectPath).toBe(putCall.ref.key);
    expect(result.object_path).toBe(putCall.ref.key);
  });

  it("case 8b: an objectStore failure fails the job with the upload's own detail", async () => {
    const admin = makeAdmin();
    const store = createFakeObjectStore();
    // The adapter keeps the backend's own text in `detail`; the upload step must
    // keep reporting that text, not this module's composed sentence.
    const failing: ObjectStore = {
      ...store,
      async put() {
        throw new ObjectStoreError("backend_failed", "Object storage said no.", "backend said no");
      },
    };

    await expect(
      getExecutor("image_generation")!(
        "job-8b",
        {},
        makeContext(admin.client, jobRow(), makeCreditRead(), null, undefined, failing),
      ),
    ).rejects.toThrow(/Storage upload failed: backend said no/);

    // Nothing was recorded and the admin client's storage was never touched.
    expect(admin.records).toHaveLength(0);
    expect(admin.uploads).toHaveLength(0);
  });
});

// BL-40 (workorder 38A): generated images are never watermarked, so neither the
// mark nor the plan read that used to decide it runs any more. The two fakes stay
// wired by the shared `beforeEach` above, so a regression that puts either of
// them back fails here instead of quietly marking an image again.
describe("BL-40: generated images are never watermarked", () => {
  it("BL-40: a free plan is not watermarked and the raw buffer is uploaded", async () => {
    const admin = makeAdmin();
    const credit = makeCreditRead({ plan: "free" });
    // 40 bytes in and nothing added: the bucket gets the download's own buffer.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new ArrayBuffer(40),
      })),
    );

    const ctx = makeContext(admin.client, jobRow(), credit);
    const result = await getExecutor("image_generation")!("job-38a-free", {}, ctx);

    expect(applyWatermark).not.toHaveBeenCalled();
    expect(onlyPut(ctx.store).size).toBe(40);
    expect(result.asset_id).toBe("asset-1");
  });

  it("BL-40: no subscription row and no repository are not watermarked", async () => {
    // A missing subscription row: the shape the old decision read as "free".
    const noRowAdmin = makeAdmin();
    const noRowCtx = makeContext(
      noRowAdmin.client,
      jobRow(),
      makeCreditRead({ plan: null }),
    );
    await getExecutor("image_generation")!("job-38a-no-row", {}, noRowCtx);

    // No repository wired at all: the field is absent, not present-and-undefined.
    const noRepoAdmin = makeAdmin();
    const noRepo = makeContext(noRepoAdmin.client, jobRow(), null);
    expect("creditReadRepository" in noRepo).toBe(false);
    await getExecutor("image_generation")!("job-38a-no-repo", {}, noRepo);

    expect(applyWatermark).not.toHaveBeenCalled();
    expect(onlyPut(noRowCtx.store).size).toBe(32);
    expect(onlyPut(noRepo.store).size).toBe(32);
  });

  it("BL-40: the image executor no longer reads the plan", async () => {
    const admin = makeAdmin();
    const credit = makeCreditRead();

    const result = await getExecutor("image_generation")!(
      "job-38a-plan-read",
      {},
      makeContext(admin.client, jobRow(), credit),
    );

    expect(credit.calls).toEqual([]);
    expect(result.asset_id).toBe("asset-1");
  });
});

describe("generation executors record provenance on the asset (GN-11)", () => {
  it("GN-11: the image executor records provenance on the asset it just registered", async () => {
    const admin = makeAdmin();
    const provenance = makeProvenance();

    const result = await getExecutor("image_generation")!(
      "job-1",
      {},
      makeContext(admin.client, jobRow(), makeCreditRead(), provenance),
    );

    expect(provenance.calls).toHaveLength(1);
    expect(provenance.calls[0]?.assetId).toBe(result.asset_id);
    expect(provenance.calls[0]?.actorId).toBe(CREATED_BY);
    expect(provenance.calls[0]?.provenance).toEqual({
      source: "agent",
      operation: "image_generation",
      modelId: "test/model",
      prompt: "a cat",
      creditsCharged: null,
      actionId: null,
      sourceJobId: "job-1",
      parentArtifactId: null,
    });
  });

  it("GN-11: the image executor records the charged amount from the context", async () => {
    const admin = makeAdmin();
    const provenance = makeProvenance();
    const ctx = makeContext(admin.client, jobRow(), makeCreditRead(), provenance);

    await getExecutor("image_generation")!("job-1", {}, { ...ctx, creditsCharged: 7 });

    expect(provenance.calls).toHaveLength(1);
    expect(provenance.calls[0]?.provenance.creditsCharged).toBe(7);
  });

  it("GN-11: a job without a session is recorded as generator", async () => {
    const admin = makeAdmin();
    const provenance = makeProvenance();

    await getExecutor("image_generation")!(
      "job-1",
      {},
      makeContext(admin.client, jobRow({ session_id: null }), makeCreditRead(), provenance),
    );

    expect(provenance.calls).toHaveLength(1);
    expect(provenance.calls[0]?.provenance.source).toBe("generator");
  });

  it("GN-11: the video executor records video_generation provenance", async () => {
    const admin = makeAdmin();
    const provenance = makeProvenance();
    const job = jobRow({ payload: { prompt: "a clip", model: "test/video" } });

    const result = await getExecutor("video_generation")!(
      "job-video-1",
      {},
      makeContext(admin.client, job, makeCreditRead(), provenance),
    );

    expect(provenance.calls).toHaveLength(1);
    expect(provenance.calls[0]?.assetId).toBe(result.asset_id);
    expect(provenance.calls[0]?.provenance.operation).toBe("video_generation");
    expect(provenance.calls[0]?.provenance.sourceJobId).toBe("job-video-1");
  });

  it("GN-11: a provenance failure warns once and the job still succeeds", async () => {
    const admin = makeAdmin();
    const provenance = makeProvenance({ failWith: new Error("db down") });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await getExecutor("image_generation")!(
        "job-1",
        {},
        makeContext(admin.client, jobRow(), makeCreditRead(), provenance),
      );

      expect(result.asset_id).toBe("asset-1");
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain("provenance was not recorded");
      expect(message).not.toContain("db down");
    } finally {
      warn.mockRestore();
    }
  });
});

// GN-02 (5): a finished job result also lists its artifacts, so the client can
// fill its placeholder from what was actually produced instead of from what it
// asked for. The dimensions asserted below are the ones the mocked providers
// report in `beforeEach` (1024x1024 image, 1280x720 video) — never the request's.
describe("GN-02: a finished job result lists its artifacts", () => {
  it("GN-02: an image job result lists its artifact with real dimensions", async () => {
    const admin = makeAdmin();

    const result = await getExecutor("image_generation")!(
      "job-artifact-image",
      {},
      makeContext(admin.client, jobRow()),
    );

    expect(result.artifacts).toEqual([
      { artifact_id: "asset-1", index: 0, format: "image/png", width: 1024, height: 1024 },
    ]);
    expect(() => jobArtifactSchema.array().parse(result.artifacts)).not.toThrow();
  });

  it("GN-02: a video job result lists its artifact", async () => {
    const admin = makeAdmin();
    const job = jobRow({ payload: { prompt: "a clip", model: "test/video" } });

    const result = await getExecutor("video_generation")!(
      "job-artifact-video",
      {},
      makeContext(admin.client, job),
    );

    expect(result.artifacts).toEqual([
      { artifact_id: "asset-1", index: 0, format: "video/mp4", width: 1280, height: 720 },
    ]);
    expect(() => jobArtifactSchema.array().parse(result.artifacts)).not.toThrow();
  });

  it("GN-02: the old result fields are still there", async () => {
    const admin = makeAdmin();

    const ctx = makeContext(admin.client, jobRow());

    const result = await getExecutor("image_generation")!(
      "job-artifact-old-fields",
      {},
      ctx,
    );

    expect(result.asset_id).toBe("asset-1");
    // T-133 (9th slice): a signature is still produced, now through the store.
    expect(String(result.signed_url)).toContain("?ttl=3600");
    expect(result.object_path).toBe(onlyPut(ctx.store).ref.key);
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(result.mime_type).toBe("image/png");
  });
});

// T-133 (7th slice): the behaviour contract this slice adds. The executors no
// longer build a store of their own, so a context without one is an ASSEMBLY
// error — reported as such, and raised before any provider call or upload.
describe("T-133: a context without an objectStore is an assembly error", () => {
  it("the image executor refuses to generate without a store", async () => {
    const admin = makeAdmin();
    // recorder `undefined` keeps the default; the sixth argument is the store,
    // and `null` is the "worker forgot to wire it" shape.
    const ctx = makeContext(admin.client, jobRow(), makeCreditRead(), null, undefined, null);
    expect(ctx.store).toBeNull();

    await expect(
      getExecutor("image_generation")!("job-no-store-image", {}, ctx),
    ).rejects.toThrow(/no objectStore.*assembly error/i);

    // Nothing was generated, uploaded or recorded: the failure is the wiring.
    expect(generateImage).not.toHaveBeenCalled();
    expect(admin.records).toHaveLength(0);
    expect(admin.uploads).toHaveLength(0);
  });

  it("the video executor refuses to generate without a store", async () => {
    const admin = makeAdmin();
    const job = jobRow({ payload: { prompt: "a clip", model: "test/video" } });
    const ctx = makeContext(admin.client, job, makeCreditRead(), null, undefined, null);
    expect(ctx.store).toBeNull();

    await expect(
      getExecutor("video_generation")!("job-no-store-video", {}, ctx),
    ).rejects.toThrow(/no objectStore.*assembly error/i);

    expect(generateVideo).not.toHaveBeenCalled();
    expect(admin.records).toHaveLength(0);
    expect(admin.uploads).toHaveLength(0);
  });
});
