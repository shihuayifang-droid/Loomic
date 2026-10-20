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

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { SubscriptionReadRow } from "../../db/credit-read-repository.js";
import { getExecutor, type ExecutorContext } from "./job-executor.js";

// Importing the executors is what registers them.
import "./executors/image-generation.js";
import "./executors/video-generation.js";

const PERSONAL_WORKSPACE = "ws-personal-billing";
const TEAM_PROJECT = "project-team-1";
const CANVAS = "canvas-1";
const CREATED_BY = "user-1";

type RpcCall = { name: string; params: Record<string, unknown> };

function makeAdmin(options: { rpcError?: { message: string } | null } = {}) {
  const rpcs: RpcCall[] = [];
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
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcs.push({ name, params });
      if (options.rpcError) return { data: null, error: options.rpcError };
      return { data: { asset_id: "asset-1" }, error: null };
    },
  };

  return {
    client: client as unknown as AdminSupabaseClient,
    rpcs,
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
): TestExecutorContext {
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
    getAdminClient: () => client,
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
    jobReads,
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
  it("case 1: the image executor passes canvas, project and object path to the RPC", async () => {
    const admin = makeAdmin();
    const executor = getExecutor("image_generation");
    expect(executor).toBeDefined();

    const result = await executor!("job-1", {}, makeContext(admin.client, jobRow()));

    expect(admin.rpcs).toHaveLength(1);
    expect(admin.rpcs[0]?.name).toBe("record_project_asset");
    expect(admin.rpcs[0]?.params).toMatchObject({
      p_bucket: "project-assets",
      p_created_by: CREATED_BY,
      p_canvas_id: CANVAS,
      p_project_id: TEAM_PROJECT,
      p_mime_type: "image/png",
    });

    // The object path is what the row is keyed by, so it has to be the uploaded one.
    expect(admin.uploads).toHaveLength(1);
    expect(admin.rpcs[0]?.params.p_object_path).toBe(admin.uploads[0]?.path);
    expect(result.asset_id).toBe("asset-1");
    expect(result.object_path).toBe(admin.uploads[0]?.path);
  });

  it("case 1b: the job result carries a SIGNED url, never a public one", async () => {
    const admin = makeAdmin();

    const result = await getExecutor("image_generation")!(
      "job-1b",
      {},
      makeContext(admin.client, jobRow()),
    );

    // X-52: the worker signs what it just recorded. A permanent public URL here
    // would survive the bucket going private as a dead link.
    expect(String(result.signed_url)).toContain("token=sig");
    expect(String(result.signed_url)).not.toContain("cdn.test");
    expect(admin.signCalls).toEqual([
      { bucket: "project-assets", path: admin.uploads[0]?.path, expiresIn: 3600 },
    ]);
  });

  it("case 2: the video executor does the same for video objects", async () => {
    const admin = makeAdmin();
    const job = jobRow({ payload: { prompt: "a clip", model: "test/video" } });
    const executor = getExecutor("video_generation");
    expect(executor).toBeDefined();

    const result = await executor!("job-2", {}, makeContext(admin.client, job));

    expect(admin.rpcs).toHaveLength(1);
    expect(admin.rpcs[0]?.params).toMatchObject({
      p_bucket: "project-assets",
      p_created_by: CREATED_BY,
      p_canvas_id: CANVAS,
      p_project_id: TEAM_PROJECT,
      p_mime_type: "video/mp4",
    });
    expect(admin.rpcs[0]?.params.p_object_path).toBe(admin.uploads[0]?.path);

    // X-52: the video's job result is signed too — same rule as the image.
    expect(String(result.signed_url)).toContain("token=sig");
    expect(String(result.signed_url)).not.toContain("cdn.test");
    expect(admin.signCalls).toEqual([
      { bucket: "project-assets", path: admin.uploads[0]?.path, expiresIn: 3600 },
    ]);
  });

  it("case 3: billing stays personal while ownership follows the team project", async () => {
    const admin = makeAdmin();

    await getExecutor("image_generation")!("job-3", {}, makeContext(admin.client, jobRow()));

    const params = admin.rpcs[0]?.params ?? {};
    // The fallback is the ONLY workspace the worker may name, and it is the
    // billing one — the project's workspace is derived by the RPC, never sent.
    expect(params.p_fallback_workspace_id).toBe(PERSONAL_WORKSPACE);
    expect(params.p_project_id).toBe(TEAM_PROJECT);
    expect(Object.values(params)).not.toContain("ws-team");
  });

  it("case 4: a job with no project records against the billing workspace only", async () => {
    const admin = makeAdmin();

    await getExecutor("image_generation")!(
      "job-4",
      {},
      makeContext(admin.client, jobRow({ canvas_id: null, project_id: null })),
    );

    expect(admin.rpcs[0]?.params).toMatchObject({
      p_project_id: null,
      p_canvas_id: null,
      p_fallback_workspace_id: PERSONAL_WORKSPACE,
    });
  });

  it("case 5: a metadata failure fails the job instead of succeeding silently", async () => {
    const admin = makeAdmin({
      rpcError: { message: "record_project_asset exploded" },
    });

    await expect(
      getExecutor("image_generation")!("job-5", {}, makeContext(admin.client, jobRow())),
    ).rejects.toThrow(/record asset ownership/i);

    // The object was uploaded; the point is that the job did NOT report success.
    expect(admin.uploads).toHaveLength(1);
  });

  it("case 6: a video metadata failure fails the job too", async () => {
    const admin = makeAdmin({
      rpcError: { message: "record_project_asset exploded" },
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
});

// Workorder 21W: the watermark decision and the plan read behind it. The two
// failure directions are NOT symmetric and both are pinned here — an unreadable
// plan watermarks (fail-closed for a free workspace), while a watermark that
// itself fails only warns and lets the job finish.
describe("the watermark decision reads the plan through the credit repository", () => {
  it("case 8: a paid plan is never watermarked", async () => {
    const admin = makeAdmin();
    const credit = makeCreditRead({ plan: "pro" });

    const result = await getExecutor("image_generation")!(
      "job-8",
      {},
      makeContext(admin.client, jobRow(), credit),
    );

    expect(credit.calls).toEqual([{ workspaceId: PERSONAL_WORKSPACE }]);
    expect(applyWatermark).not.toHaveBeenCalled();
    expect(result.asset_id).toBe("asset-1");
  });

  it("case 9: a free plan is watermarked once and the MARKED buffer is uploaded", async () => {
    const admin = makeAdmin();
    const credit = makeCreditRead({ plan: "free" });
    // The mark GROWS the buffer (32 -> 64), so the uploaded byte count says
    // WHICH buffer reached the bucket. Case 13 is its mirror image.
    applyWatermark.mockImplementationOnce(async () => Buffer.alloc(64));

    await getExecutor("image_generation")!(
      "job-9",
      {},
      makeContext(admin.client, jobRow(), credit),
    );

    expect(applyWatermark).toHaveBeenCalledTimes(1);
    expect(credit.calls).toEqual([{ workspaceId: PERSONAL_WORKSPACE }]);
    expect(admin.uploads).toHaveLength(1);
    expect(admin.uploads[0]?.bytes).toBe(64);
  });

  it("case 10: a workspace with no subscription row is treated as free", async () => {
    const admin = makeAdmin();
    const credit = makeCreditRead({ plan: null });

    const result = await getExecutor("image_generation")!(
      "job-10",
      {},
      makeContext(admin.client, jobRow(), credit),
    );

    expect(credit.calls).toEqual([{ workspaceId: PERSONAL_WORKSPACE }]);
    expect(applyWatermark).toHaveBeenCalledTimes(1);
    expect(result.asset_id).toBe("asset-1");
  });

  it("case 11: no repository on the context is treated as free", async () => {
    const admin = makeAdmin();
    const ctx = makeContext(admin.client, jobRow(), null);

    // The shape this pins: the worker did not wire the repository, so the field
    // is genuinely absent rather than present and undefined.
    expect("creditReadRepository" in ctx).toBe(false);

    const result = await getExecutor("image_generation")!("job-11", {}, ctx);

    expect(applyWatermark).toHaveBeenCalledTimes(1);
    expect(result.asset_id).toBe("asset-1");
  });

  it("case 12: a FAILED plan read still watermarks and the job still succeeds", async () => {
    const admin = makeAdmin();
    const credit = makeCreditRead({
      failWith: new Error("credit read failed (readSubscription)"),
    });

    const result = await getExecutor("image_generation")!(
      "job-12",
      {},
      makeContext(admin.client, jobRow(), credit),
    );

    // The read was attempted and threw — and a free workspace's image is still
    // watermarked. This is the fail-closed direction: the old code discarded the
    // same error and fell through to the free plan.
    expect(credit.calls).toEqual([{ workspaceId: PERSONAL_WORKSPACE }]);
    expect(applyWatermark).toHaveBeenCalledTimes(1);
    expect(admin.uploads).toHaveLength(1);
    expect(result.asset_id).toBe("asset-1");
  });

  it("case 13: a watermark failure warns once, keeps the job alive and uploads the RAW image", async () => {
    const admin = makeAdmin();
    const credit = makeCreditRead({ plan: "free" });
    // 40 bytes in and nothing added: the bucket must receive the download's own
    // buffer. Case 9 showed a SUCCESSFUL mark reaching it with the size the mark
    // produced, so the pair distinguishes "raw" from "marked".
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new ArrayBuffer(40),
      })),
    );
    applyWatermark.mockRejectedValueOnce(new Error("sharp exploded"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await getExecutor("image_generation")!(
        "job-13",
        {},
        makeContext(admin.client, jobRow(), credit),
      );

      expect(applyWatermark).toHaveBeenCalledTimes(1);
      expect(result.asset_id).toBe("asset-1");

      const watermarkWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes("Watermark failed, continuing without:"),
      );
      expect(watermarkWarnings).toHaveLength(1);
      // The frozen sentence, ending exactly where it always did: only the tag in
      // front of it is allowed to vary.
      expect(String(watermarkWarnings[0]?.[0])).toMatch(
        /^\[image-job:job-13 [^\]]*\] Watermark failed, continuing without:$/,
      );
      expect(String(watermarkWarnings[0]?.[1])).toContain("sharp exploded");

      // The job finished and the object was stored — unwatermarked, at the size
      // it was downloaded with.
      expect(admin.uploads).toHaveLength(1);
      expect(admin.uploads[0]?.bytes).toBe(40);
    } finally {
      warn.mockRestore();
    }
  });

  it("case 14: the plan read is asked for the billing workspace and nothing else", async () => {
    const admin = makeAdmin();
    const credit = makeCreditRead();

    await getExecutor("image_generation")!(
      "job-14",
      {},
      makeContext(admin.client, jobRow(), credit),
    );

    expect(credit.calls).toHaveLength(1);
    expect(credit.calls[0]).toEqual({ workspaceId: PERSONAL_WORKSPACE });
    // "Exactly" means no second key hiding beside it.
    expect(Object.keys(credit.calls[0] ?? {})).toEqual(["workspaceId"]);
  });

  it("case 15: with no billing workspace neither the plan read nor the mark runs", async () => {
    const admin = makeAdmin();
    const credit = makeCreditRead();

    const result = await getExecutor("image_generation")!(
      "job-15",
      {},
      makeContext(admin.client, jobRow({ workspace_id: "" }), credit),
    );

    expect(credit.calls).toEqual([]);
    expect(applyWatermark).not.toHaveBeenCalled();
    // The JOB still ran: this is a skipped watermark, not a skipped job.
    expect(admin.uploads).toHaveLength(1);
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

    const result = await getExecutor("image_generation")!(
      "job-artifact-old-fields",
      {},
      makeContext(admin.client, jobRow()),
    );

    expect(result.asset_id).toBe("asset-1");
    expect(String(result.signed_url)).toContain("token=sig");
    expect(result.object_path).toBe(admin.uploads[0]?.path);
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(result.mime_type).toBe("image/png");
  });
});
