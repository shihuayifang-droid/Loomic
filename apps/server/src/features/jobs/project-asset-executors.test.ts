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

import type { BackgroundJob } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
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

      const chain = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({
          // A paid plan keeps the watermark path out of the way; it is not what
          // this file is about.
          data: table === "subscriptions" ? { plan: "pro" } : null,
          error: null,
        }),
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

/** The context plus the job ids its service substitute was asked for. */
type TestExecutorContext = ExecutorContext & { jobReads: string[] };

/**
 * The executor's ONLY source of a job row. Workorder 21N moved that read onto
 * `JobService.getJobAdmin`, so the substitute carries exactly that one method and
 * the case hands it the row it wants the executor to see. Everything else on
 * `BackgroundJob` gets a legal placeholder: no case asserts on those columns.
 */
function makeContext(
  client: AdminSupabaseClient,
  job: ExecutorJobFixture,
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
