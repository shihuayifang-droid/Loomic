// X-52 (工单14 T1): the single Agent project-asset persistence entry point.
//
// The three producers — direct image persist, `screenshot_canvas`,
// `persist_sandbox_file` — all funnel through here, so this file is where the
// ticket's ordering guarantee is pinned:
//
//   canvas link (repository) → upload (user JWT) → record_project_asset
//   (service role, canvas-derived) → on metadata failure DELETE the object and
//   throw → sign → return stable ref.
//
// Two properties are the whole point:
//   * what comes back is an IDENTITY (assetId + objectPath), not a URL, so a
//     private bucket cannot orphan the record;
//   * a failure NEVER degrades to a public URL, a provider URL or `data:` — a
//     fallback here would quietly undo X-52 from the inside.
//
// 工单21AC moved the entry point's two TABLE calls to their repositories, so the
// harness below injects fakes for them and the caller's client keeps ONLY a
// storage surface: a table read through it throws, and the number of times one
// was attempted is asserted to be zero. That is what turns "the reads are no
// longer issued here" into a measurement instead of a claim.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AssetRecordRepository,
  RecordProjectAssetInput,
} from "../../db/asset-record-repository.js";
import type { AssetWriteRepository } from "../../db/asset-write-repository.js";
import type {
  CanvasProjectLinkRow,
  CanvasReadRepository,
} from "../../db/canvas-read-repository.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import type { ObjectStore } from "./object-store.js";
import {
  AgentProjectAssetError,
  buildAgentObjectPath,
  createAgentProjectAssetService,
  sanitizeAgentFileName,
} from "./agent-project-assets.js";
import { ObjectStoreError } from "./object-store.js";
import { PROJECT_ASSET_URL_TTL_SECONDS } from "./project-asset-urls.js";

const WORKSPACE = "ws-team";
const CANVAS = "canvas-1";
const USER = "user-1";
const TOKEN = "jwt-token";

type UploadCall = { bucket: string; path: string; bytes: number; contentType?: string };
type RemoveCall = { bucket: string; paths: string[] };
type RecordCall = RecordProjectAssetInput;
type CanvasLinkCall = { actorId: string; canvasId: string };
type MetadataDeleteCall = { actorId: string; assetId: string };

function makeHarness(options: {
  /** The asset record repository throws this (a database error or "no asset id"). */
  recordError?: { message: string } | null;
  uploadError?: { message: string } | null;
  signError?: { message: string } | null;
  removeError?: { message: string } | null;
  /** The repository delete issued while cleaning up a failed signing. */
  metadataDeleteError?: { message: string } | null;
  /** Rows the repository delete reports; 0 is the "already gone" answer. */
  metadataDeleteRows?: number;
  /** Canvas link returns nothing, i.e. the ACL hid it. */
  canvasHidden?: boolean;
  canvasError?: { message: string } | null;
  /**
   * 45AN (T-133 6b): supply an `ObjectStore` factory, so the case measures the
   * "factory was given" path. Absent → the transition branch (the adapter).
   */
  withFactory?: boolean;
}) {
  const uploads: UploadCall[] = [];
  const removes: RemoveCall[] = [];
  const records: RecordCall[] = [];
  const canvasLinks: CanvasLinkCall[] = [];
  const metadataDeletes: MetadataDeleteCall[] = [];
  /** Every side effect in the order it happened — the sequence IS the contract. */
  const events: string[] = [];
  let signedPaths: string[] = [];
  let tableReads = 0;
  // 45AN (T-133 6b): what a supplied factory was handed and what the store it
  // returned was asked to do. Kept apart from `uploads`, because the property
  // being measured is WHICH of the two paths served the write.
  const factoryClients: unknown[] = [];
  const factoryPuts: {
    bucket: string;
    key: string;
    bytes: number;
    contentType?: string;
  }[] = [];
  const factoryDeletes: { bucket: string; key: string }[] = [];
  // T-133 slice 9: what the supplied store was asked to SIGN. The observation
  // point of the signing step moved here with the call: the factory's store is
  // now the thing that mints the URL when a factory is supplied.
  const factorySigns: {
    bucket: string;
    key: string;
    ttlSeconds: number;
  }[] = [];
  const factoryStore = {
    async put(
      ref: { bucket: string; key: string },
      body: { length: number },
      putOptions?: { contentType?: string },
    ): Promise<void> {
      if (options.uploadError) throw new Error(options.uploadError.message);
      factoryPuts.push({
        bucket: ref.bucket,
        key: ref.key,
        bytes: body.length,
        ...(putOptions?.contentType
          ? { contentType: putOptions.contentType }
          : {}),
      });
    },
    async get(): Promise<never> {
      throw new Error("ObjectStore.get is not used by this path");
    },
    async head(): Promise<never> {
      throw new Error("ObjectStore.head is not used by this path");
    },
    async delete(refs: readonly { bucket: string; key: string }[]) {
      for (const ref of refs) factoryDeletes.push({ ...ref });
      if (options.removeError) throw new Error(options.removeError.message);
    },
    async copy(): Promise<never> {
      throw new Error("ObjectStore.copy is not used by this path");
    },
    async signedReadUrl(
      ref: { bucket: string; key: string },
      signOptions: { ttlSeconds: number },
    ): Promise<string> {
      // T-133 slice 9: the signature now arrives here when a factory supplied
      // this store, so the case records the ref and TTL it was handed instead of
      // failing as an unreachable method.
      factorySigns.push({
        bucket: ref.bucket,
        key: ref.key,
        ttlSeconds: signOptions.ttlSeconds,
      });
      if (options.signError) {
        throw new ObjectStoreError(
          "backend_failed",
          `Could not sign the stored object (${options.signError.message}).`,
        );
      }
      return `https://proj.test/storage/v1/object/sign/${ref.bucket}/${ref.key}?token=store-sig`;
    },
    async signedReadUrls(): Promise<never> {
      throw new Error("ObjectStore.signedReadUrls is not used by this path");
    },
  } as unknown as ObjectStore;

  const userClient = {
    // The canvas and the metadata row are repositories' business now (工单21AC),
    // so a table read through the caller's client is a regression, not a stub to
    // satisfy: it throws and it is counted.
    from(table: string) {
      tableReads += 1;
      throw new Error(`unexpected table read in agent-project-assets test: ${table}`);
    },
    storage: {
      from(bucket: string) {
        return {
          upload: async (
            path: string,
            buffer: { length: number },
            uploadOptions?: { contentType?: string },
          ) => {
            if (options.uploadError) return { data: null, error: options.uploadError };
            events.push("upload");
            uploads.push({
              bucket,
              path,
              bytes: buffer.length,
              ...(uploadOptions?.contentType
                ? { contentType: uploadOptions.contentType }
                : {}),
            });
            return { data: { path }, error: null };
          },
          remove: async (paths: string[]) => {
            events.push("storage_remove");
            removes.push({ bucket, paths });
            return { data: null, error: options.removeError ?? null };
          },
          createSignedUrl: async (path: string) => {
            if (options.signError) {
              events.push("sign_refused");
              return { data: null, error: options.signError };
            }
            events.push("sign");
            signedPaths.push(path);
            return {
              data: { signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig` },
              error: null,
            };
          },
        };
      },
    },
  };

  const assetRecordRepository: Pick<AssetRecordRepository, "recordProjectAsset"> = {
    async recordProjectAsset(input) {
      events.push("record_asset");
      records.push({ ...input });
      if (options.recordError) throw new Error(options.recordError.message);
      return {
        assetId: `asset-${records.length}`,
        workspaceId: WORKSPACE,
        projectId: "project-1",
      };
    },
  };

  const canvasReadRepository = {
    async findReadableCanvasContent(): Promise<never> {
      throw new Error("findReadableCanvasContent is not used by this path");
    },
    async findReadableCanvasProjectLink(input: {
      actorId: string;
      canvasId: string;
    }): Promise<CanvasProjectLinkRow | null> {
      canvasLinks.push({ ...input });
      if (options.canvasError) throw new Error(options.canvasError.message);
      if (options.canvasHidden) return null;
      return { project_id: "project-1", workspace_id: WORKSPACE, brand_kit_id: null };
    },
    async listReadableSucceededImageJobs(): Promise<never> {
      throw new Error("listReadableSucceededImageJobs is not used by this path");
    },
    async listReadableCanvasAssets(): Promise<never> {
      throw new Error("listReadableCanvasAssets is not used by this path");
    },
  } as unknown as CanvasReadRepository;

  const assetWriteRepository = {
    async deleteOwnAsset(input: {
      actorId: string;
      assetId: string;
    }): Promise<{ deleted: number }> {
      events.push("metadata_delete");
      metadataDeletes.push({ actorId: input.actorId, assetId: input.assetId });
      if (options.metadataDeleteError) {
        throw new Error(options.metadataDeleteError.message);
      }
      return { deleted: options.metadataDeleteRows ?? 1 };
    },
  } as unknown as AssetWriteRepository;

  const service = createAgentProjectAssetService({
    canvasReadRepository,
    assetWriteRepository,
    createUserClient: () => userClient as unknown as UserSupabaseClient,
    assetRecordRepository,
    // 45AN (T-133 6b): only the cases that ask for it inject the factory, so the
    // other cases keep measuring the transition branch (the adapter).
    ...(options.withFactory
      ? {
          createObjectStore: (client: UserSupabaseClient) => {
            factoryClients.push(client);
            return factoryStore;
          },
        }
      : {}),
  });

  return {
    service,
    uploads,
    removes,
    records,
    canvasLinks,
    metadataDeletes,
    events,
    signedPaths: () => signedPaths,
    /** How many table reads the caller's client was asked for — must stay zero. */
    tableReads: () => tableReads,
    /** 45AN (6b): the clients a supplied factory was handed, and its writes. */
    userClient,
    factoryClients,
    factoryPuts,
    factoryDeletes,
    factorySigns,
  };
}

const PNG = Buffer.from("png-bytes", "utf-8");

/**
 * Await a persist that MUST reject, and hand the error back as the value under
 * test. Written this way rather than with `.catch()`, so a persist that
 * unexpectedly SUCCEEDS fails the case instead of quietly returning a reference.
 */
async function refusal(
  promise: Promise<unknown>,
): Promise<AgentProjectAssetError> {
  try {
    await promise;
  } catch (error) {
    return error as AgentProjectAssetError;
  }
  throw new Error("expected persist() to reject, but it resolved");
}

function persist(
  harness: ReturnType<typeof makeHarness>,
  overrides: Partial<Parameters<ReturnType<typeof makeHarness>["service"]["persist"]>[0]> = {},
) {
  return harness.service.persist({
    accessToken: TOKEN,
    canvasId: CANVAS,
    createdBy: USER,
    content: PNG,
    mimeType: "image/png",
    fileName: "canvas-screenshot-full",
    ...overrides,
  });
}

describe("agent project asset persistence (T1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("case 1: returns the stable reference, not a bare URL", async () => {
    const h = makeHarness({});
    const result = await persist(h);

    expect(result.assetId).toBe("asset-1");
    expect(result.objectPath).toBe(h.uploads[0]?.path);
    expect(result.bucket).toBe("project-assets");
    expect(result.mimeType).toBe("image/png");
    expect(result.byteSize).toBe(PNG.length);
    // The URL is this read's projection and is present exactly alongside the
    // identity — never instead of it.
    expect(h.signedPaths()).toEqual([result.objectPath]);
    expect(result.signedUrl).toContain(result.objectPath);
    // 工单21AC: the canvas link is the repository's answer, asked with the ACTOR —
    // and the caller's client was never asked for a table at all.
    expect(h.canvasLinks).toEqual([{ actorId: USER, canvasId: CANVAS }]);
    expect(h.tableReads()).toBe(0);
  });

  it("case 2: ownership is recorded from the canvas, never from the object path", async () => {
    const h = makeHarness({});
    await persist(h);

    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      bucket: "project-assets",
      canvasId: CANVAS,
      createdBy: USER,
      // No project named directly: the repository derives it from the canvas.
      projectId: null,
    });
    // The key starts with the canvas-derived workspace (the Storage RLS
    // requirement) and the recorded path is the uploaded path, verbatim.
    expect(String(h.records[0]?.objectPath).startsWith(`${WORKSPACE}/`)).toBe(true);
    expect(h.records[0]?.objectPath).toBe(h.uploads[0]?.path);
    // The billing/personal workspace is nowhere in the decision.
    expect(JSON.stringify(h.records[0])).not.toContain("personal");
  });

  it("case 3: a metadata failure deletes the just-uploaded object and throws", async () => {
    const h = makeHarness({ recordError: { message: "record exploded" } });

    await expect(persist(h)).rejects.toBeInstanceOf(AgentProjectAssetError);
    expect(h.uploads).toHaveLength(1);
    expect(h.removes).toHaveLength(1);
    expect(h.removes[0]?.paths).toEqual([h.uploads[0]?.path]);
    // Nothing was signed, and no URL of any kind was handed back.
    expect(h.signedPaths()).toHaveLength(0);
  });

  it("case 4: a record that yields no asset id counts as failure, not success", async () => {
    const h = makeHarness({
      recordError: { message: "record_project_asset returned no asset id" },
    });

    await expect(persist(h)).rejects.toMatchObject({ code: "metadata_failed" });
    expect(h.removes[0]?.paths).toEqual([h.uploads[0]?.path]);
  });

  it("case 5: no canvas context is refused before anything is uploaded", async () => {
    const h = makeHarness({});

    await expect(persist(h, { canvasId: "" })).rejects.toMatchObject({
      code: "no_canvas",
    });
    expect(h.uploads).toHaveLength(0);
    expect(h.records).toHaveLength(0);
    // Refused before the repository was even asked.
    expect(h.canvasLinks).toHaveLength(0);
  });

  it("case 6: an unreachable canvas is refused — no object is written at all", async () => {
    const h = makeHarness({ canvasHidden: true });

    await expect(persist(h)).rejects.toMatchObject({ code: "canvas_not_found" });
    expect(h.uploads).toHaveLength(0);
    expect(h.records).toHaveLength(0);
  });

  it("case 7: a signing failure never degrades to a public or data URL", async () => {
    const h = makeHarness({ signError: { message: "permission denied" } });

    const error = await persist(h).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentProjectAssetError);
    expect((error as AgentProjectAssetError).code).toBe("sign_failed");
    expect(String((error as Error).message)).not.toContain("http");
    expect(String((error as Error).message)).not.toContain("data:");

    // 工单14 fixup T3. By this point the object AND its metadata row both exist,
    // so a refusal to sign has to undo BOTH: nothing downstream ever received an
    // assetId, which makes either half left behind an orphan by construction.
    expect(h.uploads).toHaveLength(1);
    expect(h.removes).toHaveLength(1);
    expect(h.removes[0]?.paths).toEqual([h.uploads[0]?.path]);
    // 工单21AC: the row delete is the repository's, asked with the same actor.
    expect(h.metadataDeletes).toEqual([{ actorId: USER, assetId: "asset-1" }]);
    expect(h.tableReads()).toBe(0);
    // And the caller's failure carries no reference and no URL to hold on to.
    expect(error).not.toHaveProperty("assetId");
    expect(error).not.toHaveProperty("signedUrl");
    expect(JSON.stringify({ ...(error as object) })).not.toContain("http");
  });

  it("case 9: a failed signing leaves NOTHING half-created, in metadata-then-object order", async () => {
    const h = makeHarness({ signError: { message: "permission denied" } });

    const error = await refusal(persist(h));

    expect(error.code).toBe("sign_failed");

    // The sequence IS the requirement: the row is deleted before the bytes, so
    // the authoritative record never briefly outlives what it points at.
    expect(h.events).toEqual([
      "upload",
      "record_asset",
      "sign_refused",
      "metadata_delete",
      "storage_remove",
    ]);
    // The metadata row targeted is the one the RPC just minted; the object
    // removed is the one that was uploaded.
    expect(h.metadataDeletes[0]?.assetId).toBe("asset-1");
    expect(h.removes[0]?.paths).toEqual([h.uploads[0]?.path]);
    // No URL was ever produced, so none can be rolled back or returned.
    expect(h.signedPaths()).toHaveLength(0);
  });

  it("case 10: cleanup that itself fails is named on the safe log, and never masks sign_failed", async () => {
    const logged: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });

    const h = makeHarness({
      signError: { message: "permission denied" },
      removeError: { message: "storage said no" },
      metadataDeleteError: { message: "delete denied" },
    });

    const error = await refusal(persist(h));
    spy.mockRestore();

    // The reason the persist failed stays the reason reported.
    expect(error.code).toBe("sign_failed");
    expect(error.message).toContain("permission denied");

    const text = logged.join("\n");
    // What may have survived is named, or T-23's inventory can never find it.
    expect(text).toContain("asset-1");
    expect(text).toContain(h.uploads[0]!.path);
    expect(text).toContain("delete denied");
    expect(text).toContain("storage said no");
    // Safe log: an object key is not a bearer token, a signed URL would be.
    expect(text).not.toContain("token=");
    expect(text).not.toContain("http");
  });

  it("case 11: a repository delete that removes ZERO rows is logged, not thrown, and sign_failed still wins", async () => {
    const logged: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });

    // 工单21AC: `deleted: 0` means the row was already gone, or the row's policy
    // refused it. The compensation is best-effort, so this must NOT become an
    // exception — but it must not pass silently either.
    const h = makeHarness({
      signError: { message: "permission denied" },
      metadataDeleteRows: 0,
    });

    const error = await refusal(persist(h));
    spy.mockRestore();

    expect(error.code).toBe("sign_failed");
    expect(error.message).toContain("permission denied");

    // The object is still removed: one deleted half is not a reason to keep the
    // other.
    expect(h.removes).toHaveLength(1);
    expect(h.metadataDeletes).toHaveLength(1);

    const text = logged.join("\n");
    expect(text).toContain("asset-1");
    expect(text).toContain("(0 rows)");
    // Same safe-log rule as case 10.
    expect(text).not.toContain("token=");
    expect(text).not.toContain("http");
  });

  it("case 12: a failed canvas link is reported with the original message, before any upload", async () => {
    const h = makeHarness({ canvasError: { message: "connect failed" } });

    const error = await refusal(persist(h));

    expect(error.code).toBe("canvas_not_found");
    // The message the caller already produced for a failed lookup.
    expect(error.message).toContain("Canvas lookup failed: connect failed");
    expect(h.uploads).toHaveLength(0);
    expect(h.records).toHaveLength(0);
  });

  it("case 8: the object key is sanitised into the workspace/canvas namespace", async () => {
    const h = makeHarness({});
    const result = await persist(h, { fileName: "../../etc/pass wd.png" });

    expect(result.objectPath.startsWith(`${WORKSPACE}/agent/${CANVAS}/`)).toBe(true);
    expect(result.objectPath).not.toContain("..");
    expect(result.objectPath).not.toContain(" ");
  });

  it("case 13: a supplied factory serves the upload, and is handed the USER client", async () => {
    const h = makeHarness({ withFactory: true });
    const result = await persist(h);

    // 45AN (T-133 6b): the factory is called with the caller's own client, never
    // a second one — the upload must carry the JWT's authority, not more.
    expect(h.factoryClients).toEqual([h.userClient]);
    // The write went through the factory's store, and the record IS the upload:
    // same bucket, same key, same byte count the caller is told about.
    expect(h.factoryPuts).toHaveLength(1);
    expect(h.factoryPuts[0]).toMatchObject({
      bucket: "project-assets",
      key: result.objectPath,
      bytes: PNG.length,
      contentType: "image/png",
    });
    // The adapter path was NOT the one that wrote: the client's own storage
    // surface saw no upload at all.
    expect(h.uploads).toHaveLength(0);
    // Everything after the upload is unchanged — same identity, same read.
    expect(result.bucket).toBe("project-assets");
    expect(result.byteSize).toBe(PNG.length);
    // T-133 slice 9: the SIGNATURE also goes through the factory's store, so the
    // read follows the write across a backend swap. The ref and the TTL it was
    // handed are what the call always asked for; only the receiver changed.
    expect(h.factorySigns).toEqual([
      {
        bucket: "project-assets",
        key: result.objectPath,
        ttlSeconds: PROJECT_ASSET_URL_TTL_SECONDS,
      },
    ]);
    // ...and the URL handed back is still a URL for this very object.
    expect(result.signedUrl).toContain(result.objectPath);
    // The adapter path signed nothing either: the client's own storage surface
    // was never reached for a signature.
    expect(h.signedPaths()).toHaveLength(0);
    expect(h.records).toHaveLength(1);
  });

  it("case 14: no factory supplied keeps the adapter path (transition branch)", async () => {
    const h = makeHarness({});
    const result = await persist(h);

    // The factory was never asked for, so today's adapter served the write.
    expect(h.factoryClients).toHaveLength(0);
    expect(h.factoryPuts).toHaveLength(0);
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0]).toMatchObject({
      bucket: "project-assets",
      path: result.objectPath,
      bytes: PNG.length,
      contentType: "image/png",
    });
  });

  it("case 15: with a factory, the compensation delete goes through the same store", async () => {
    const h = makeHarness({
      recordError: { message: "record exploded" },
      withFactory: true,
    });

    await expect(persist(h)).rejects.toMatchObject({ code: "metadata_failed" });

    expect(h.factoryPuts).toHaveLength(1);
    // The object removed is the one this store wrote — not looked up elsewhere.
    expect(h.factoryDeletes).toEqual([
      { bucket: "project-assets", key: h.factoryPuts[0]?.key },
    ]);
    expect(h.removes).toHaveLength(0);
  });

  it("case 16: with a factory, a refused signature still undoes BOTH halves", async () => {
    const h = makeHarness({
      signError: { message: "permission denied" },
      withFactory: true,
    });

    const error = await refusal(persist(h));

    // T-133 slice 9: the same `sign_failed` contract, now reached through the
    // factory's store rather than through the caller's client.
    expect(error.code).toBe("sign_failed");
    expect(error.message).toContain("permission denied");
    expect(h.factorySigns).toEqual([
      {
        bucket: "project-assets",
        key: h.factoryPuts[0]?.key,
        ttlSeconds: PROJECT_ASSET_URL_TTL_SECONDS,
      },
    ]);
    // No URL was produced, so none can be handed back or rolled back.
    expect(h.signedPaths()).toHaveLength(0);
    // Cleanup semantics unchanged: the row first, then the bytes the same store
    // wrote. Nothing half-created survives a refusal to sign.
    expect(h.metadataDeletes).toEqual([{ actorId: USER, assetId: "asset-1" }]);
    expect(h.factoryDeletes).toEqual([
      { bucket: "project-assets", key: h.factoryPuts[0]?.key },
    ]);
    expect(h.removes).toHaveLength(0);
  });
});

describe("agent object path / name helpers", () => {
  it("keeps an extension that is already present and adds one otherwise", () => {
    const withExt = buildAgentObjectPath({
      workspaceId: "ws",
      canvasId: "c1",
      pathPrefix: "agent",
      fileName: "shot.png",
      mimeType: "image/png",
      now: 1,
      nonce: "abc",
    });
    const withoutExt = buildAgentObjectPath({
      workspaceId: "ws",
      canvasId: "c1",
      pathPrefix: "agent",
      fileName: "shot",
      mimeType: "image/webp",
      now: 1,
      nonce: "abc",
    });

    expect(withExt).toBe("ws/agent/c1/1-abc-shot.png");
    expect(withoutExt).toBe("ws/agent/c1/1-abc-shot.webp");
  });

  it("falls back to a usable name when the display name sanitises away", () => {
    expect(sanitizeAgentFileName("///")).toBe("asset");
    expect(sanitizeAgentFileName("生成图")).toBe("asset");
  });
});
