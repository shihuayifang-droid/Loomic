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
import { createFakeObjectStore, type FakeObjectStore } from "../../test-support/fake-object-store.js";
import type { ObjectStore } from "../storage/object-store.js";
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

/** Every call the injected store recorded (empty when the case carried none). */
function storeCalls(store: ObjectStore | null) {
  return store ? (store as FakeObjectStore).calls : [];
}

/** The single put the executor made, or a loud failure when it made none. */
function onlyPut(store: ObjectStore | null) {
  if (!store) throw new Error("the context carried no objectStore");
  const call = (store as FakeObjectStore).calls.find((entry) => entry.method === "put");
  if (call?.method !== "put") throw new Error("the object store received no put call");
  return call;
}

/** The bytes the injected store now holds for the one put the executor made. */
async function storedBytes(store: ObjectStore | null): Promise<Buffer> {
  const put = onlyPut(store);
  if (!store) throw new Error("the context carried no objectStore");
  return (await store.get(put.ref)).body;
}

function makeContext(options: {
  payload: Record<string, unknown>;
  readable?: boolean;
  // T-133 (7th slice): the ObjectStore the context carries. Omitted → a fresh
  // fake store, because the executor now REQUIRES one. `null` leaves the field
  // off — the "worker forgot to wire it" shape the assembly-error case pins.
  objectStore?: ObjectStore | null;
}) {
  const store =
    options.objectStore === undefined ? createFakeObjectStore() : options.objectStore;
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
    ...(store ? { objectStore: store } : {}),
  } as ExecutorContext;

  return { ctx, admin, provenanceCalls, readCalls, store };
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
    const { ctx, admin, provenanceCalls, store } = makeContext({ payload: PAYLOAD });

    const result = await run(ctx);

    // T-133 (7th slice): the product goes through the injected store, so the
    // bucket, key, content type and bytes are read off what the store received.
    const put = onlyPut(store);
    expect(put.ref.bucket).toBe("project-assets");
    expect(put.ref.key.startsWith(`${WORKSPACE}/tool/fake_tool/`)).toBe(true);
    expect(put.ref.key.endsWith(`-${JOB_ID}.png`)).toBe(true);
    expect(put.options).toEqual({ contentType: "image/png", upsert: false });
    expect(admin.uploads).toHaveLength(0);

    expect(admin.records).toHaveLength(1);
    expect(admin.records[0]).toMatchObject({
      bucket: "project-assets",
      objectPath: put.ref.key,
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
    const { ctx, store } = makeContext({ payload: PAYLOAD });

    const result = await run(ctx);

    const meta = await sharp(await storedBytes(store)).metadata();
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
    const { ctx, store } = makeContext({ payload: { ...PAYLOAD, tool_id: "no_such_tool" } });

    const failure = await run(ctx).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ToolRunError);
    expect((failure as ToolRunError).code).toBe("unknown_tool");
    expect(storeCalls(store)).toHaveLength(0);
  });

  it("an unreadable artifact fails the job and stores nothing", async () => {
    const runner = vi.fn(async (input: ToolRunnerInput) => ({
      bytes: input.bytes,
      mimeType: input.mimeType,
    }));
    registerToolRunner("fake_tool", runner);
    const { ctx, store } = makeContext({ payload: PAYLOAD, readable: false });

    const failure = await run(ctx).then(
      () => null,
      (error: unknown) => error,
    );

    expect((failure as { code?: string }).code).toBe("not_found");
    expect((failure as Error).name).toBe("OriginalSourceError");
    expect(storeCalls(store)).toHaveLength(0);
    expect(runner).not.toHaveBeenCalled();
  });

  // T-133 1b: the upload step now takes an `ObjectStore`. A context that carries
  // one is uploaded through it — nothing reaches the admin client's storage — and
  // the bucket, path and bytes are the ones the admin client used to receive.
  it("T-133 1b: a context carrying an objectStore uploads through it", async () => {
    registerToolRunner("fake_tool", async (input) => ({
      bytes: input.bytes,
      mimeType: input.mimeType,
    }));
    const store = createFakeObjectStore();
    const { ctx, admin } = makeContext({ payload: PAYLOAD, objectStore: store });

    const result = await run(ctx);

    const putCall = store.calls.find((call) => call.method === "put");
    if (putCall?.method !== "put") throw new Error("the object store received no put call");
    expect(putCall.ref.bucket).toBe("project-assets");
    expect(putCall.ref.key.startsWith(`${WORKSPACE}/tool/fake_tool/`)).toBe(true);
    expect(putCall.ref.key.endsWith(`-${JOB_ID}.png`)).toBe(true);
    expect(putCall.options).toEqual({ contentType: "image/png", upsert: false });

    // The bytes are the ones the admin client used to be handed: a PNG of the
    // source size.
    const stored = await store.get(putCall.ref);
    const meta = await sharp(stored.body).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(40);
    expect(meta.format).toBe("png");
    expect(stored.size).toBe(putCall.size);

    // The injected store was used, not the admin client's storage.
    expect(admin.uploads).toHaveLength(0);
    expect(admin.records[0]?.objectPath).toBe(putCall.ref.key);
    expect(result.asset_id).toBe("asset-9");
    expect(result.object_path).toBe(putCall.ref.key);
  });

  // T-133 (7th slice): the behaviour contract this slice adds. The executor no
  // longer builds a store of its own, so a context without one is an ASSEMBLY
  // error — reported as such, and raised before any work is done.
  it("T-133 (7th slice): a context without an objectStore is an assembly error", async () => {
    const runner = vi.fn(async (input: ToolRunnerInput) => ({
      bytes: input.bytes,
      mimeType: input.mimeType,
    }));
    registerToolRunner("fake_tool", runner);
    const { ctx, admin, store } = makeContext({ payload: PAYLOAD, objectStore: null });
    expect(store).toBeNull();

    const failure = await run(ctx).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ToolRunError);
    expect((failure as ToolRunError).code).toBe("invalid_input");
    expect((failure as Error).message).toMatch(/no objectStore.*assembly error/i);
    // The failure is the wiring, not the work: nothing ran and nothing landed.
    expect(runner).not.toHaveBeenCalled();
    expect(admin.uploads).toHaveLength(0);
    expect(admin.records).toHaveLength(0);
  });
});
