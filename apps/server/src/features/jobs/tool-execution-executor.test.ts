// 40P: the tool_execution executor (GN-24, ED-00j, ED-07).
//
// The executor knows no concrete tool, so every case here registers a fake
// runner. The storage client, job service, read repository and `fetch` are
// substitutes: nothing leaves the machine.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackgroundJob } from "@loomic/shared";

import type { RecordProjectAssetInput } from "../../db/asset-record-repository.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { getExecutor, type ExecutorContext } from "./job-executor.js";
import {
  clearToolRunnersForTest,
  registerToolRunner,
  ToolRunError,
  type ToolRunnerInput,
} from "../tools/tool-runners.js";

// Importing the executor is what registers it.
import "./executors/tool-execution.js";

const WORKSPACE = "ws-1";
const CREATED_BY = "user-1";
const ARTIFACT = "artifact-1";
const JOB_ID = "job-1234";

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

function makeAdmin() {
  const uploads: Array<{ bucket: string; path: string; bytes: Buffer }> = [];
  const records: RecordProjectAssetInput[] = [];

  const client = {
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, bytes: Buffer) => {
            uploads.push({ bucket, path, bytes });
            return { data: { path }, error: null };
          },
          createSignedUrl: async (path: string) => ({
            data: { signedUrl: `https://proj.test/sign/${bucket}/${path}?token=sig` },
            error: null,
          }),
        };
      },
    },
  };

  return { client: client as unknown as AdminSupabaseClient, uploads, records };
}

type ProvenanceInput = Parameters<
  NonNullable<ExecutorContext["assetProvenanceRepository"]>["recordProvenance"]
>[0];

function makeContext(options: {
  payload: Record<string, unknown>;
  readable?: boolean;
}) {
  const admin = makeAdmin();
  const provenanceCalls: ProvenanceInput[] = [];
  const readCalls: Array<{ actorId: string; assetId: string }> = [];

  const ctx = {
    jobService: {
      getJobAdmin: async (jobId: string): Promise<BackgroundJob> =>
        ({
          id: jobId,
          job_type: "tool_execution",
          status: "running",
          created_by: CREATED_BY,
          workspace_id: WORKSPACE,
          canvas_id: "canvas-1",
          project_id: "project-1",
          session_id: null,
          payload: options.payload,
        }) as unknown as BackgroundJob,
    } as unknown as ExecutorContext["jobService"],
    pgmq: {} as ExecutorContext["pgmq"],
    getAdminClient: () => admin.client,
    env: {} as ExecutorContext["env"],
    queue: "tool_execution_jobs",
    msgId: 1,
    renewVt: async () => {},
    assetRecordRepository: {
      recordProjectAsset: async (input: RecordProjectAssetInput) => {
        admin.records.push(input);
        return { assetId: "asset-9", workspaceId: input.fallbackWorkspaceId, projectId: input.projectId ?? null };
      },
    },
    assetReadRepository: {
      findReadableAsset: async (input: { actorId: string; assetId: string }) => {
        readCalls.push(input);
        if (options.readable === false) return null;
        return {
          id: input.assetId,
          bucket: "project-assets",
          object_path: `${WORKSPACE}/uploads/original.png`,
          mime_type: "image/png",
          byte_size: 100,
          workspace_id: WORKSPACE,
          project_id: "project-1",
          created_at: "2026-01-01T00:00:00.000Z",
        };
      },
    },
    assetProvenanceRepository: {
      recordProvenance: async (input: ProvenanceInput) => {
        provenanceCalls.push(input);
        return undefined as never;
      },
    },
  } as ExecutorContext;

  return { ctx, admin, provenanceCalls, readCalls };
}

function run(ctx: ExecutorContext) {
  const executor = getExecutor("tool_execution");
  if (!executor) throw new Error("tool_execution executor is not registered");
  return executor(JOB_ID, {}, ctx);
}

beforeEach(async () => {
  clearToolRunnersForTest();
  const source = await makePng(64, 40);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () =>
        source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToolRunnersForTest();
});

const PAYLOAD = { tool_id: "fake_tool", artifact_id: ARTIFACT, model: "m-1" };

describe("tool_execution executor", () => {
  it("GN-24: the tool output is stored by the server under tool/ and registered as tool:<id>", async () => {
    registerToolRunner("fake_tool", async (input) => ({
      bytes: input.bytes,
      mimeType: input.mimeType,
    }));
    const { ctx, admin, provenanceCalls } = makeContext({ payload: PAYLOAD });

    const result = await run(ctx);

    expect(admin.uploads).toHaveLength(1);
    const upload = admin.uploads[0]!;
    expect(upload.bucket).toBe("project-assets");
    expect(upload.path.startsWith(`${WORKSPACE}/tool/fake_tool/`)).toBe(true);
    expect(upload.path.endsWith(`-${JOB_ID}.png`)).toBe(true);

    expect(admin.records).toHaveLength(1);
    expect(admin.records[0]).toMatchObject({
      bucket: "project-assets",
      objectPath: upload.path,
      createdBy: CREATED_BY,
      canvasId: "canvas-1",
      projectId: "project-1",
      mimeType: "image/png",
    });

    expect(provenanceCalls).toHaveLength(1);
    const provenance = provenanceCalls[0]!.provenance;
    expect(provenance.source).toBe("tool:fake_tool");
    expect(provenance.parentArtifactId).toBe(ARTIFACT);
    expect(provenance.modelId).toBe("m-1");
    expect(provenance.sourceJobId).toBe(JOB_ID);

    expect(result.file_name).toBe("fake_tool_asset-9.png");
    expect(result.mime_type).toBe("image/png");
    expect(result.asset_id).toBe("asset-9");
  });

  it("ED-07: the output is always the source size", async () => {
    registerToolRunner("fake_tool", async () => ({
      bytes: await makePng(128, 128),
      mimeType: "image/png",
    }));
    const { ctx, admin } = makeContext({ payload: PAYLOAD });

    const result = await run(ctx);

    const meta = await sharp(admin.uploads[0]!.bytes).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(40);
    expect(meta.format).toBe("png");
    expect(result.width).toBe(64);
    expect(result.height).toBe(40);
  });

  it("ED-00j: the input is the original object, read as the job's owner", async () => {
    const seen: ToolRunnerInput[] = [];
    registerToolRunner("fake_tool", async (input) => {
      seen.push(input);
      return { bytes: input.bytes, mimeType: input.mimeType };
    });
    const { ctx, readCalls } = makeContext({ payload: PAYLOAD });

    await run(ctx);

    expect(readCalls).toEqual([{ actorId: CREATED_BY, assetId: ARTIFACT }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.width).toBe(64);
    expect(seen[0]!.height).toBe(40);
    expect(seen[0]!.model).toBe("m-1");
  });

  it("an unknown tool fails the job and stores nothing", async () => {
    const { ctx, admin } = makeContext({ payload: { ...PAYLOAD, tool_id: "no_such_tool" } });

    const failure = await run(ctx).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ToolRunError);
    expect((failure as ToolRunError).code).toBe("unknown_tool");
    expect(admin.uploads).toHaveLength(0);
  });

  it("an unreadable artifact fails the job and stores nothing", async () => {
    const runner = vi.fn(async (input: ToolRunnerInput) => ({
      bytes: input.bytes,
      mimeType: input.mimeType,
    }));
    registerToolRunner("fake_tool", runner);
    const { ctx, admin } = makeContext({ payload: PAYLOAD, readable: false });

    const failure = await run(ctx).then(
      () => null,
      (error: unknown) => error,
    );

    expect((failure as { code?: string }).code).toBe("not_found");
    expect((failure as Error).name).toBe("OriginalSourceError");
    expect(admin.uploads).toHaveLength(0);
    expect(runner).not.toHaveBeenCalled();
  });
});
