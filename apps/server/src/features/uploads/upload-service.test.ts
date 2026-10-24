// X-52 prep (T3): a normal upload's project ownership is decided by the SERVER.
//
// `projectId` arrives from the client as an optional multipart field, and both the
// object path and the asset row are built from it. Without verification a client
// could file an object under a project (or workspace) it has nothing to do with,
// and nobody would notice until the bucket is private and the real project cannot
// read its own media.
//
// Every metadata write in this file goes through the asset record repository, so
// the stub asserts on the repository call rather than on an insert.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import { createProjectService } from "../projects/project-service.js";
import type { AssetReadRepository } from "../../db/asset-read-repository.js";
import type { AssetProvenanceRepository } from "../../db/asset-provenance-repository.js";
import type { AssetRecordRepository } from "../../db/asset-record-repository.js";
import {
  DELETE_OWN_ASSET,
  AssetWriteError,
  type AssetWriteRepository,
} from "../../db/asset-write-repository.js";
import type { ProjectReadRepository } from "../../db/project-read-repository.js";
import type { ProjectWriteRepository } from "../../db/project-write-repository.js";
import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";
import type { ObjectStore } from "../storage/object-store.js";
import { createSupabaseObjectStore } from "../storage/supabase-object-store.js";
import type { SupabaseStorageLike } from "../storage/supabase-object-store.js";
import { ObjectStoreError } from "../storage/object-store.js";
import { createUploadService, UploadServiceError } from "./upload-service.js";

const USER = { id: "user-1", accessToken: "token", email: "a@t", userMetadata: {} } as AuthenticatedUser;

const TEAM_WORKSPACE = "ws-team";
const OTHER_WORKSPACE = "ws-other";
const PROJECT = "project-1";

type RecordCall = Record<string, unknown>;

/** ED-05: what the signing SDK was told about a download, kept beside `signedCalls`. */
type SignedOptions = { transform?: unknown; download?: unknown } | undefined;

/**
 * 45AI / T-133 (3rd slice): object storage is injected as a FACTORY keyed on the
 * user client, so these doubles hand the service a fake STORE instead of a fake
 * SDK underneath a real adapter. Every `put` records the bucket, the key and the
 * byte count; every `delete` records the key — the same observation points the
 * SDK double used to offer, one layer in. The two failures the upload path has to
 * survive are switchable, and every method the service does NOT use throws, so a
 * regression is loud rather than silent.
 */
function createFakeStore(record: {
  uploads?: Array<{ bucket: string; path: string; bytes: number }> | undefined;
  removals?: string[] | undefined;
  events?: string[] | undefined;
  /** `put` fails before anything is written; the message is the backend detail. */
  failPut?: { message: string } | null | undefined;
  /** `delete` fails AFTER recording, so "the removal was attempted" stays visible. */
  failDelete?: { message: string } | null | undefined;
}): ObjectStore {
  const uploads = record.uploads ?? [];
  const removals = record.removals ?? [];
  const events = record.events ?? [];

  return {
    async put(ref, body) {
      if (record.failPut) {
        throw new ObjectStoreError(
          "backend_failed",
          "the object could not be written",
          record.failPut.message,
        );
      }
      uploads.push({ bucket: ref.bucket, path: ref.key, bytes: body.length });
      events.push(`upload:${ref.key}`);
    },
    async delete(refs) {
      for (const ref of refs) {
        removals.push(ref.key);
        events.push(`remove:${ref.key}`);
      }
      if (record.failDelete) {
        throw new ObjectStoreError(
          "backend_failed",
          "the object could not be removed",
          record.failDelete.message,
        );
      }
    },
    async get() {
      throw new Error("the upload service must not read an object");
    },
    async head() {
      throw new Error("the upload service must not head an object");
    },
    async copy() {
      throw new Error("the upload service must not copy an object");
    },
    async signedReadUrl() {
      throw new Error("signing stays on the user client, not the store");
    },
    async signedReadUrls() {
      throw new Error("signing stays on the user client, not the store");
    },
  };
}

/**
 * T-133 (9th slice): the service signs through the injected store instead of the
 * user client, so the fake store forwards signing to the same stub client the
 * cases already observe — through the adapter the assembly point builds it with.
 * `signedCalls` / `signedOptions` / `events` therefore keep recording exactly what
 * they recorded before the call sites changed hands.
 */
function withClientSigning(
  store: ObjectStore,
  client: UserSupabaseClient,
): ObjectStore {
  const signing = createSupabaseObjectStore(
    client as unknown as SupabaseStorageLike,
  );

  return {
    ...store,
    signedReadUrl: (ref, options) => signing.signedReadUrl(ref, options),
    // The batch contract is the helper's: a key that cannot be signed is simply
    // absent from the map, so it is signed one by one against the same stub.
    async signedReadUrls(bucket, keys, options) {
      const signed = new Map<string, string>();
      for (const key of [...new Set(keys)]) {
        try {
          signed.set(key, await signing.signedReadUrl({ bucket, key }, options));
        } catch {
          // absent is the answer, exactly as `signProjectAssetUrls` documents
        }
      }
      return signed;
    },
  };
}

function makeStubs(options: {
  project?: { workspace_id: string } | null;
  projectError?: { code?: string; message: string } | null;
  rpcError?: { message: string } | null;
  /** 44C: build the service without the asset record repository (fail closed). */
  omitRecordRepository?: boolean;
  uploadError?: { message: string } | null;
  /** 45AI: a removal the (fake) store refuses; `removeQuietly` must swallow it. */
  deleteError?: { message: string } | null;
  assetRow?: Record<string, unknown> | null;
  assetReadError?: { message: string } | null;
  assetDeleteError?: { message: string } | null;
  provenance?: { failWith?: Error };
  /** ED-05: a display-name write that fails, and the name a read answers. */
  displayNameError?: Error;
  storedDisplayName?: string | null;
  /**
   * AS-06: the project upload list the read repository answers, and a failure it
   * throws. Passing NEITHER leaves the double without the method at all, which is
   * the "not wired" case, not an empty list.
   */
  uploadList?: Array<Record<string, unknown>>;
  uploadListError?: { message: string } | null;
}) {
  const recordCalls: RecordCall[] = [];
  const uploads: Array<{ bucket: string; path: string; bytes: number }> = [];
  const removals: string[] = [];
  const signedCalls: Array<{ bucket: string; path: string; expiresIn: number }> = [];
  /** ED-05: the third argument of every signing call, in order. */
  const signedOptions: SignedOptions[] = [];
  /** GN-11: what `uploadFile` asked the provenance repository to record. */
  const provenanceCalls: Array<{
    actorId: string | null;
    assetId: string;
    provenance: Record<string, unknown>;
  }> = [];
  /** Ordered side effects, so "remove before delete" is provable. */
  const events: string[] = [];

  // 工单20E: both read-only lookups belong to the repositories now, so the fixture
  // answers them there.
  //
  // ADR-0001 / workorder 21AA: so does the asset row delete, and the `getAssetUrl`
  // read that used to be the last PostgREST call here. The user client below
  // therefore carries ONLY Storage; its table
  // accessor throws, so any regression back to PostgREST explodes here instead of
  // passing quietly.
  const projectLookups: Array<{ actorId: string; projectId: string }> = [];
  const assetLookups: Array<{ actorId: string; assetId: string }> = [];
  const assetDeletes: Array<{ actorId: string; assetId: string }> = [];
  /** AS-06: what `listProjectUploads` asked the repository, in order. */
  const uploadListCalls: Array<Record<string, unknown>> = [];

  const projectRepository = {
    async findReadableProjectWorkspaceForMutation(input: {
      actorId: string;
      projectId: string;
    }) {
      projectLookups.push(input);
      if (options.projectError) throw options.projectError;
      return options.project ?? null;
    },
  };

  const defaultAssetRow = {
    id: "asset-1",
    bucket: "project-assets",
    object_path: "unused",
    mime_type: "image/png",
    byte_size: 3,
    workspace_id: TEAM_WORKSPACE,
    project_id: PROJECT,
    created_at: "2026-10-02T00:00:00.000Z",
  };

  const assetRepository = {
    async findReadableAsset(input: { actorId: string; assetId: string }) {
      assetLookups.push(input);
      if (options.assetReadError) throw options.assetReadError;
      if (options.assetRow === null) return null;
      return options.assetRow ?? defaultAssetRow;
    },
    // AS-06: appended only when a case asks for the list, so the doubles of the
    // 25 cases above stay exactly the single-method fakes they were.
    ...(options.uploadList !== undefined || options.uploadListError
      ? {
          async listReadableProjectUploads(input: Record<string, unknown>) {
            uploadListCalls.push(input);
            if (options.uploadListError) throw options.uploadListError;
            return options.uploadList ?? [];
          },
        }
      : {}),
  };

  const assetWriteRepository = {
    async deleteOwnAsset(input: { actorId: string; assetId: string }) {
      assetDeletes.push(input);
      // Recorded in the SAME ordered log as the storage calls, so "the object goes
      // first, the row second" stays provable.
      events.push(`delete-row:${input.assetId}`);
      if (options.assetDeleteError) throw options.assetDeleteError;
      return { deleted: 1 };
    },
  };

  // GN-11: the provenance write the upload service performs once the row exists.
  // ED-05 adds the two display-name methods to the same repository.
  const displayNameCalls: Array<{
    actorId: string | null;
    assetId: string;
    displayName: string;
  }> = [];
  const displayNameReads: Array<{ assetId: string }> = [];

  const provenanceRepository = {
    async recordProvenance(input: {
      actorId: string | null;
      assetId: string;
      provenance: Record<string, unknown>;
    }) {
      provenanceCalls.push(input);
      if (options.provenance?.failWith) throw options.provenance.failWith;
      return { updated: 1 };
    },
    async recordDisplayName(input: {
      actorId: string | null;
      assetId: string;
      displayName: string;
    }) {
      displayNameCalls.push(input);
      if (options.displayNameError) throw options.displayNameError;
      return { updated: 1 };
    },
    async readDisplayName(input: { assetId: string }) {
      displayNameReads.push(input);
      return options.storedDisplayName ?? null;
    },
  };

  const userClient = {
    get from(): never {
      throw new Error("the upload write flows must not touch a table");
    },
    // 45AI: only signing is left on the user client. `upload` / `remove` moved to
    // the fake store below, so a regression back to the raw SDK has nothing to
    // call here.
    storage: {
      from(bucket: string) {
        return {
          // X-52: asset URLs are signed through this call. `getPublicUrl` is kept
          // only so the stub would visibly explode if production code used it.
          createSignedUrl: async (
            path: string,
            expiresIn: number,
            callOptions?: SignedOptions,
          ) => {
            signedCalls.push({ bucket, path, expiresIn });
            // ED-05: recorded separately so the 25 cases above keep asserting on
            // `signedCalls` exactly as they did.
            signedOptions.push(callOptions);
            events.push(`sign:${path}`);
            return {
              data: {
                signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig`,
              },
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

  // 45AI: the store the injected factory answers with, and the clients the factory
  // was handed (so "the same user client, never the admin's" is provable).
  const objectStore = withClientSigning(
    createFakeStore({
      uploads,
      removals,
      events,
      failPut: options.uploadError,
      failDelete: options.deleteError,
    }),
    userClient as unknown as UserSupabaseClient,
  );
  const storeClients: UserSupabaseClient[] = [];

  // Workorder 44C: the asset record is the repository's now; the fake records the
  // camelCase input and can be made to throw. `omitRecordRepository` leaves it out.
  const assetRecordRepository = {
    async recordProjectAsset(input: Record<string, unknown>) {
      recordCalls.push(input);
      events.push("record");
      if (options.rpcError) throw options.rpcError;
      return { assetId: "asset-1", workspaceId: TEAM_WORKSPACE, projectId: PROJECT };
    },
  };

  const service = createUploadService({
    createUserClient: () => userClient as unknown as UserSupabaseClient,
    // 45AI: the factory, handed the user-scoped client exactly as the service
    // would have wrapped it itself before this ticket.
    createObjectStore: (client) => {
      storeClients.push(client);
      return objectStore;
    },
    ...(options.omitRecordRepository
      ? {}
      : {
          assetRecordRepository:
            assetRecordRepository as unknown as AssetRecordRepository,
        }),
    projectReadRepository: projectRepository as unknown as ProjectReadRepository,
    assetReadRepository: assetRepository as unknown as AssetReadRepository,
    assetWriteRepository:
      assetWriteRepository as unknown as AssetWriteRepository,
    // GN-11: injected only when the case asks for it, so the 21 cases above keep
    // running against exactly the wiring they had.
    ...(options.provenance
      ? {
          assetProvenanceRepository:
            provenanceRepository as unknown as Pick<
              AssetProvenanceRepository,
              "recordProvenance" | "recordDisplayName" | "readDisplayName"
            >,
        }
      : {}),
  });

  return {
    service,
    recordCalls,
    uploads,
    removals,
    signedCalls,
    signedOptions,
    events,
    projectLookups,
    assetLookups,
    assetDeletes,
    uploadListCalls,
    provenanceCalls,
    displayNameCalls,
    displayNameReads,
    userClient,
    objectStore,
    storeClients,
  };
}

const FILE = {
  bucket: "project-assets" as const,
  fileName: "photo.png",
  fileBuffer: Buffer.from("abc"),
  mimeType: "image/png",
};

describe("uploadFile records project ownership", () => {
  it("case 1: a project upload records the project and its workspace", async () => {
    const stub = makeStubs({ project: { workspace_id: TEAM_WORKSPACE } });

    await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
    });

    expect(stub.recordCalls).toHaveLength(1);
    expect(stub.recordCalls[0]?.bucket).toBe("project-assets");
    expect(stub.recordCalls[0]).toMatchObject({
      bucket: "project-assets",
      createdBy: "user-1",
      projectId: PROJECT,
      canvasId: null,
      fallbackWorkspaceId: TEAM_WORKSPACE,
    });
    expect(stub.recordCalls[0]?.objectPath).toBe(stub.uploads[0]?.path);
  });

  it("case 2: a workspace that is not the project's is refused before anything is written", async () => {
    const stub = makeStubs({ project: { workspace_id: TEAM_WORKSPACE } });

    const error = await stub.service
      .uploadFile(USER, {
        ...FILE,
        workspaceId: OTHER_WORKSPACE,
        projectId: PROJECT,
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error?.statusCode).toBe(403);
    expect(error?.message).toContain("different workspace");
    expect(stub.uploads).toHaveLength(0);
    expect(stub.recordCalls).toHaveLength(0);
  });

  it("case 3: an unreadable project is refused", async () => {
    const stub = makeStubs({ project: null });

    const error = await stub.service
      .uploadFile(USER, { ...FILE, workspaceId: TEAM_WORKSPACE, projectId: PROJECT })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error?.statusCode).toBe(403);
    expect(stub.uploads).toHaveLength(0);
  });

  it("case 4: a plain upload keeps projectId null and uses the given workspace", async () => {
    const stub = makeStubs({});

    await stub.service.uploadFile(USER, { ...FILE, workspaceId: TEAM_WORKSPACE });

    expect(stub.recordCalls[0]).toMatchObject({
      projectId: null,
      canvasId: null,
      fallbackWorkspaceId: TEAM_WORKSPACE,
      createdBy: "user-1",
    });
  });

  it("case 5: a failed metadata write removes the object instead of silently succeeding", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      rpcError: { message: "rpc exploded" },
    });

    const error = await stub.service
      .uploadFile(USER, { ...FILE, workspaceId: TEAM_WORKSPACE, projectId: PROJECT })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error?.statusCode).toBe(500);
    expect(stub.uploads).toHaveLength(1);
    expect(stub.removals).toEqual([stub.uploads[0]?.path]);
  });

  it("44C: without an asset record repository the upload fails closed and the object is removed", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      omitRecordRepository: true,
    });

    const error = await stub.service
      .uploadFile(USER, { ...FILE, workspaceId: TEAM_WORKSPACE, projectId: PROJECT })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.code).toBe("upload_failed");
    expect(error?.statusCode).toBe(500);
    expect(error?.message).toBe("Failed to record asset metadata.");
    expect(stub.uploads).toHaveLength(1);
    expect(stub.removals).toEqual([stub.uploads[0]?.path]);
  });

  it("case 6: the response comes from the row the RPC created, not from the request", async () => {
    const stub = makeStubs({ project: { workspace_id: TEAM_WORKSPACE } });

    const result = await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
    });

    expect(result.asset.id).toBe("asset-1");
    expect(result.asset.createdAt).toBe("2026-10-02T00:00:00.000Z");
    // X-52: a short-lived signature, not a permanent public URL.
    expect(result.url).toContain("token=sig");
    expect(result.url).not.toContain("cdn.test");
    expect(stub.signedCalls).toEqual([
      { bucket: "project-assets", path: stub.uploads[0]?.path, expiresIn: 3600 },
    ]);
  });

  it("case 7: the object path starts with the verified workspace", async () => {
    const stub = makeStubs({ project: { workspace_id: TEAM_WORKSPACE } });

    await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
    });

    expect(stub.uploads[0]?.path.startsWith(`${TEAM_WORKSPACE}/${PROJECT}/`)).toBe(true);
  });
});

// `saveThumbnail` writes the same kind of row through the same RPC, so it is
// covered here rather than in a separate file: the subject is "an upload is
// recorded as a project asset", not which service performed it.
describe("saveThumbnail records the thumbnail as a project asset", () => {
  function makeProjectService(options: {
    rpcError?: { message: string } | null;
    omitRecordRepository?: boolean;
  }) {
    const recordCalls: RecordCall[] = [];
    const referenceWrites: Array<Record<string, unknown>> = [];

    // ADR-0001 / workorder 21AA: the reference write is the project write
    // repository's now, so the user client here carries ONLY Storage.
    const userClient = {
      get from(): never {
        throw new Error("saveThumbnail must not touch a table");
      },
      storage: {
        from(bucket: string) {
          return {
            upload: async (path: string) => ({ data: { path }, error: null }),
            // X-52: `saveThumbnail` answers with a signed URL too.
            createSignedUrl: async (path: string) => ({
              data: {
                signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig`,
              },
              error: null,
            }),
            getPublicUrl: (path: string) => ({
              data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
            }),
          };
        },
      },
    };

    const projectWriteRepository = {
      async setOwnProjectThumbnail(input: Record<string, unknown>) {
        referenceWrites.push(input);
        return { updated: 1 };
      },
    };

    // 45AK / T-133 (5th slice): the thumbnail store is injected as a per-user
    // FACTORY, so the double is a fake STORE instead of a fake SDK underneath a
    // real adapter. `put` records the same bucket / key / byte count the SDK
    // double used to see; signing still goes through `userClient` above.
    const uploads: Array<{ bucket: string; path: string; bytes: number }> = [];

    const service = createProjectService({
      createUserClient: () => userClient as unknown as UserSupabaseClient,
      createObjectStore: () =>
        withClientSigning(
          createFakeStore({ uploads }),
          userClient as unknown as UserSupabaseClient,
        ),
      viewerService: {} as ViewerService,
      // 工单20E: the workspace lookup is the repository's now.
      projectReadRepository: {
        async findReadableProjectWorkspaceForMutation() {
          return { workspace_id: TEAM_WORKSPACE };
        },
      } as unknown as ProjectReadRepository,
      projectWriteRepository:
        projectWriteRepository as unknown as ProjectWriteRepository,
      ...(options.omitRecordRepository
        ? {}
        : {
            assetRecordRepository: {
              async recordProjectAsset(input: Record<string, unknown>) {
                recordCalls.push(input);
                if (options.rpcError) throw options.rpcError;
                return {
                  assetId: "asset-thumb",
                  workspaceId: TEAM_WORKSPACE,
                  projectId: PROJECT,
                };
              },
            },
          }),
    });

    return { service, recordCalls, referenceWrites };
  }

  it("case 8: the thumbnail is recorded against its project", async () => {
    const stub = makeProjectService({});

    await stub.service.saveThumbnail(USER, PROJECT, Buffer.from("thumb"), "image/png");

    expect(stub.recordCalls).toHaveLength(1);
    expect(stub.recordCalls[0]).toMatchObject({
      bucket: "project-assets",
      projectId: PROJECT,
      createdBy: "user-1",
      fallbackWorkspaceId: TEAM_WORKSPACE,
    });
    expect(stub.recordCalls[0]?.objectPath).toBe(
      `${TEAM_WORKSPACE}/${PROJECT}/thumbnail.png`,
    );
    expect(stub.referenceWrites).toEqual([
      {
        actorId: "user-1",
        projectId: PROJECT,
        thumbnailPath: `${TEAM_WORKSPACE}/${PROJECT}/thumbnail.png`,
      },
    ]);
  });

  it("44C: without an asset record repository the thumbnail fails closed and the reference is not saved", async () => {
    const stub = makeProjectService({ omitRecordRepository: true });

    await expect(
      stub.service.saveThumbnail(USER, PROJECT, Buffer.from("thumb"), "image/png"),
    ).rejects.toThrow(/thumbnail metadata/i);

    expect(stub.referenceWrites).toHaveLength(0);
  });

  it("case 9: a metadata failure is reported and the reference is not saved", async () => {
    const stub = makeProjectService({ rpcError: { message: "rpc exploded" } });

    await expect(
      stub.service.saveThumbnail(USER, PROJECT, Buffer.from("thumb"), "image/png"),
    ).rejects.toThrow(/thumbnail metadata/i);

    expect(stub.referenceWrites).toHaveLength(0);
  });
});

// X-52 stage 1C (工单18 T2): `getAssetUrl` is the read path for a historical object
// whose metadata row says `bucket = 'canvases'`. It must sign in that bucket — the
// bucket comes from the row, never from a hardcoded default — and it must not degrade
// to a public URL when the caller happens to be unable to read the object.
describe("getAssetUrl signs the bucket the metadata row names (工单18)", () => {
  it("case 10: a canvases asset is signed in canvases with no public fallback", async () => {
    const stub = makeStubs({
      assetRow: {
        id: "asset-canvas-1",
        bucket: "canvases",
        object_path: "canvases/team-project/legacy.png",
        mime_type: "image/png",
        byte_size: 3,
        workspace_id: TEAM_WORKSPACE,
        project_id: PROJECT,
        created_at: "2026-10-13T00:00:00.000Z",
      },
    });

    const url = await stub.service.getAssetUrl(USER, "asset-canvas-1");

    expect(stub.signedCalls).toEqual([
      {
        bucket: "canvases",
        path: "canvases/team-project/legacy.png",
        expiresIn: 3600,
      },
    ]);
    expect(url).toContain("token=sig");
    // The public-URL branch exists on the stub precisely so a fallback would be visible.
    expect(url).not.toContain("cdn.test");
  });
});

// 工单20E: the write flows' read-only lookups are the repositories' now — the
// project ownership check before an upload, the row read back after the RPC, and
// the row `deleteAsset` locates. What must NOT move is any write, the object
// path, the RPC, the signing, or the order of the delete's two steps.
describe("the migrated lookups of the upload write flows", () => {
  const CANVAS_ASSET_ROW = {
    id: "asset-1",
    bucket: "canvases",
    object_path: "canvases/legacy.png",
    mime_type: "image/png",
    byte_size: 3,
    workspace_id: TEAM_WORKSPACE,
    project_id: null,
    created_at: "2026-10-13T00:00:00.000Z",
  };

  it("case 11: a project lookup failure is the existing 500 with zero side effects", async () => {
    const stub = makeStubs({
      projectError: { code: "57P01", message: "connection reset by peer" },
    });

    const error = await stub.service
      .uploadFile(USER, {
        ...FILE,
        workspaceId: TEAM_WORKSPACE,
        projectId: PROJECT,
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.message).toBe("Failed to verify the upload project.");
    // The question was asked of the repository, with the caller as the actor.
    expect(stub.projectLookups).toEqual([
      { actorId: "user-1", projectId: PROJECT },
    ]);
    expect(stub.uploads).toEqual([]);
    expect(stub.recordCalls).toEqual([]);
    expect(stub.assetLookups).toEqual([]);
    expect(stub.events).toEqual([]);
  });

  it("case 12: an upload without a project never asks the project repository", async () => {
    const stub = makeStubs({});

    await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
    });

    expect(stub.projectLookups).toEqual([]);
    expect(stub.uploads).toHaveLength(1);
    expect(stub.recordCalls).toHaveLength(1);
  });

  it("case 13: the DTO comes from the row the asset repository answers, asked with the actor and the RPC's id", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      assetRow: {
        id: "asset-9",
        bucket: "project-assets",
        object_path: "stored/other-path.webp",
        mime_type: "image/webp",
        byte_size: 8192,
        workspace_id: TEAM_WORKSPACE,
        project_id: PROJECT,
        created_at: "2026-10-13T11:22:33.444Z",
      },
    });

    const result = await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
    });

    expect(stub.assetLookups).toEqual([
      { actorId: "user-1", assetId: "asset-1" },
    ]);
    expect(result.asset).toEqual({
      id: "asset-9",
      bucket: "project-assets",
      objectPath: "stored/other-path.webp",
      mimeType: "image/webp",
      byteSize: 8192,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
      createdAt: "2026-10-13T11:22:33.444Z",
    });
    // The signature still names the object that was uploaded, not the row's path.
    expect(stub.signedCalls).toEqual([
      { bucket: "project-assets", path: stub.uploads[0]?.path, expiresIn: 3600 },
    ]);
    expect(stub.removals).toEqual([]);
  });

  it("case 14: an unreadable row after the RPC removes the object once and keeps the fixed 500", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      assetReadError: { message: "asset read failed (findReadableAsset)" },
    });

    const error = await stub.service
      .uploadFile(USER, {
        ...FILE,
        workspaceId: TEAM_WORKSPACE,
        projectId: PROJECT,
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.message).toBe("Failed to record asset metadata.");
    expect(error?.message).not.toContain("findReadableAsset");
    expect(stub.uploads).toHaveLength(1);
    // Exactly one cleanup, and it is the same one as before the migration.
    expect(stub.removals).toEqual([stub.uploads[0]?.path]);
    expect(stub.recordCalls).toHaveLength(1);
    expect(stub.signedCalls).toEqual([]);
  });

  it("case 15: a missing row after the RPC behaves identically", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      assetRow: null,
    });

    const error = await stub.service
      .uploadFile(USER, {
        ...FILE,
        workspaceId: TEAM_WORKSPACE,
        projectId: PROJECT,
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error?.statusCode).toBe(500);
    expect(error?.message).toBe("Failed to record asset metadata.");
    expect(stub.assetLookups).toEqual([
      { actorId: "user-1", assetId: "asset-1" },
    ]);
    expect(stub.uploads).toHaveLength(1);
    expect(stub.removals).toEqual([stub.uploads[0]?.path]);
    expect(stub.signedCalls).toEqual([]);
  });

  it("case 16: deleteAsset locates through the repository and still removes the object before deleting the row", async () => {
    const stub = makeStubs({ assetRow: CANVAS_ASSET_ROW });

    await stub.service.deleteAsset(USER, "asset-1");

    expect(stub.assetLookups).toEqual([
      { actorId: "user-1", assetId: "asset-1" },
    ]);
    // The bucket and the path come from the row the repository answered, and the
    // order is the existing contract: object first, row second. The row delete is
    // the write repository's now, and it lands in the same ordered log.
    expect(stub.events).toEqual([
      "remove:canvases/legacy.png",
      "delete-row:asset-1",
    ]);
    expect(stub.removals).toEqual(["canvases/legacy.png"]);
    expect(stub.assetDeletes).toEqual([{ actorId: "user-1", assetId: "asset-1" }]);
  });

  it("case 16b: a failed row delete is the existing 500 upload_failed", async () => {
    const stub = makeStubs({
      assetRow: CANVAS_ASSET_ROW,
      assetDeleteError: new AssetWriteError(
        DELETE_OWN_ASSET,
        new Error("boom"),
      ),
    });

    const error = await stub.service
      .deleteAsset(USER, "asset-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("upload_failed");
    expect(error?.message).toBe("Failed to delete asset record.");
    // The repository's own text is not what the client is shown.
    expect(error?.message).not.toContain("deleteOwnAsset");
    // The object was already gone when the row delete failed — the existing order.
    expect(stub.removals).toEqual(["canvases/legacy.png"]);
  });

  it("case 17: an unreadable asset is the existing 404 and removes nothing", async () => {
    const stub = makeStubs({
      assetReadError: { message: "asset read failed (findReadableAsset)" },
    });

    const error = await stub.service
      .deleteAsset(USER, "asset-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(404);
    expect(error?.code).toBe("asset_not_found");
    expect(error?.message).toBe("Asset not found.");
    expect(stub.events).toEqual([]);
  });

  it("case 18: a missing asset row is the same 404, with no remove and no delete", async () => {
    const stub = makeStubs({ assetRow: null });

    const error = await stub.service
      .deleteAsset(USER, "asset-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error?.statusCode).toBe(404);
    expect(error?.code).toBe("asset_not_found");
    expect(stub.assetLookups).toEqual([
      { actorId: "user-1", assetId: "asset-1" },
    ]);
    expect(stub.events).toEqual([]);
  });

  // Workorder 21AA: this is the ONE deliberate contract change of the ticket. Case 19
  // used to assert that `getAssetUrl` was excluded from the migration and kept its
  // own table read. It is now the repository's read instead — the same
  // `findReadableAsset` `deleteAsset` already used — because the ticket's
  // "do not build a second read method" rule (an existing one answers exactly this
  // question) and the "no table access left" rule point at the same conclusion.
  it("case 19: getAssetUrl asks the repository and reads no table", async () => {
    const stub = makeStubs({ assetRow: CANVAS_ASSET_ROW });

    const url = await stub.service.getAssetUrl(USER, "asset-1");

    expect(stub.assetLookups).toEqual([
      { actorId: "user-1", assetId: "asset-1" },
    ]);
    expect(stub.signedCalls).toEqual([
      { bucket: "canvases", path: "canvases/legacy.png", expiresIn: 3600 },
    ]);
    expect(url).toContain("token=sig");
    // Nothing was deleted and nothing was written: this is a read path.
    expect(stub.events).toEqual(["sign:canvases/legacy.png"]);
    expect(stub.assetDeletes).toEqual([]);
  });

  it("case 19b: a repository failure and a missing row are both the existing 404", async () => {
    const failed = makeStubs({
      assetReadError: new Error("asset read failed (findReadableAsset)"),
    });
    const missing = makeStubs({ assetRow: null });

    for (const stub of [failed, missing]) {
      const error = await stub.service
        .getAssetUrl(USER, "asset-1")
        .then(() => null)
        .catch((thrown: unknown) => thrown as UploadServiceError);

      expect(error).toBeInstanceOf(UploadServiceError);
      expect(error?.statusCode).toBe(404);
      expect(error?.code).toBe("asset_not_found");
      expect(error?.message).toBe("Asset not found.");
      // Nothing was signed, and the client was never even built for a missing row.
      expect(stub.signedCalls).toEqual([]);
    }
  });
});

// 45AI / T-133 (3rd slice): storage is observed on the fake store the injected
// factory answers with — the SDK double no longer carries upload/remove at all.
describe("45AI: object storage arrives through the injected factory", () => {
  it("45AI: the factory is handed the caller's own user client, never an admin one", async () => {
    const stub = makeStubs({ project: { workspace_id: TEAM_WORKSPACE } });

    await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
    });

    expect(stub.storeClients).toHaveLength(1);
    expect(stub.storeClients[0]).toBe(stub.userClient);
  });

  it("45AI: the store sees the bucket, the object key and the bytes", async () => {
    const stub = makeStubs({ project: { workspace_id: TEAM_WORKSPACE } });

    await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
    });

    expect(stub.uploads).toHaveLength(1);
    expect(stub.uploads[0]).toEqual({
      bucket: "project-assets",
      path: stub.recordCalls[0]?.objectPath,
      bytes: FILE.fileBuffer.length,
    });
    expect(stub.events).toEqual([
      `upload:${stub.uploads[0]?.path}`,
      "record",
      `sign:${stub.uploads[0]?.path}`,
    ]);
  });

  it("45AI: a store write failure keeps the fixed 500 and its backend detail", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      uploadError: { message: "backend said no" },
    });

    const error = await stub.service
      .uploadFile(USER, { ...FILE, workspaceId: TEAM_WORKSPACE, projectId: PROJECT })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("upload_failed");
    expect(error?.message).toBe("Storage upload failed: backend said no");
    expect(stub.uploads).toEqual([]);
    expect(stub.recordCalls).toEqual([]);
  });

  it("45AI: a removal the store refuses is ignored and the row delete still runs", async () => {
    const stub = makeStubs({
      assetRow: {
        id: "asset-1",
        bucket: "canvases",
        object_path: "canvases/legacy.png",
        mime_type: "image/png",
        byte_size: 12,
        workspace_id: TEAM_WORKSPACE,
        project_id: PROJECT,
        created_at: "2026-10-02T00:00:00.000Z",
      },
      deleteError: { message: "the backend said no" },
    });

    await stub.service.deleteAsset(USER, "asset-1");

    expect(stub.removals).toEqual(["canvases/legacy.png"]);
    expect(stub.events).toEqual([
      "remove:canvases/legacy.png",
      "delete-row:asset-1",
    ]);
    expect(stub.assetDeletes).toEqual([{ actorId: "user-1", assetId: "asset-1" }]);
  });
});

// GN-11 / X-P7: an upload records where its artifact came from. A plain upload is
// a `user_upload`; a caller that relays an artifact it produced itself (the
// generate route does) names the real source, so relaying does not change it.
describe("uploadFile records provenance (GN-11)", () => {
  const PLAIN_PROVENANCE = {
    source: "user_upload",
    operation: null,
    modelId: null,
    prompt: null,
    creditsCharged: null,
    actionId: null,
    sourceJobId: null,
    parentArtifactId: null,
  };

  it("GN-11: a plain upload is recorded as user_upload", async () => {
    const stub = makeStubs({ provenance: {} });

    const result = await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
    });

    expect(stub.provenanceCalls).toHaveLength(1);
    expect(stub.provenanceCalls[0]).toEqual({
      actorId: "user-1",
      assetId: "asset-1",
      provenance: PLAIN_PROVENANCE,
    });
    expect(result.asset.id).toBe("asset-1");
  });

  it("GN-11: a relayed artifact keeps the source its caller names", async () => {
    const stub = makeStubs({ provenance: {} });

    await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
      provenance: {
        source: "generator",
        operation: "image_generation",
        modelId: "m-1",
        prompt: "p",
      },
    });

    expect(stub.provenanceCalls).toHaveLength(1);
    expect(stub.provenanceCalls[0]?.provenance).toEqual({
      source: "generator",
      operation: "image_generation",
      modelId: "m-1",
      prompt: "p",
      creditsCharged: null,
      actionId: null,
      sourceJobId: null,
      parentArtifactId: null,
    });
  });

  it("GN-11: a provenance failure warns once and the upload still succeeds", async () => {
    const stub = makeStubs({ provenance: { failWith: new Error("db down") } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await stub.service.uploadFile(USER, {
        ...FILE,
        workspaceId: TEAM_WORKSPACE,
      });

      expect(result.asset.id).toBe("asset-1");
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain("provenance was not recorded");
      expect(message).not.toContain("db down");
    } finally {
      warn.mockRestore();
    }
  });

  it("GN-11: a failed metadata write records no provenance", async () => {
    const stub = makeStubs({
      rpcError: { message: "rpc exploded" },
      provenance: {},
    });

    const error = await stub.service
      .uploadFile(USER, { ...FILE, workspaceId: TEAM_WORKSPACE })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error?.statusCode).toBe(500);
    expect(stub.provenanceCalls).toEqual([]);
  });
});

// ED-05: the object key is ASCII-mangled, so the name the user gave the file has to
// be stored beside it and handed back to the signing SDK on download. Both halves
// are best effort in one direction only: the upload never fails because the name
// could not be kept, and a download without a stored name still works.
describe("ED-05: the original file name is kept and used for downloads", () => {
  const NAMED_FILE = { ...FILE, fileName: "角色-小橘.png" };

  const NAMED_ASSET_ROW = {
    id: "asset-1",
    bucket: "project-assets",
    object_path: "ws/123-photo.png",
    mime_type: "image/png",
    byte_size: 3,
    workspace_id: TEAM_WORKSPACE,
    project_id: PROJECT,
    created_at: "2026-10-13T00:00:00.000Z",
  };

  it("ED-05: an upload records the original file name", async () => {
    const stub = makeStubs({ provenance: {} });

    await stub.service.uploadFile(USER, {
      ...NAMED_FILE,
      workspaceId: TEAM_WORKSPACE,
    });

    expect(stub.displayNameCalls).toEqual([
      { actorId: "user-1", assetId: "asset-1", displayName: "角色-小橘.png" },
    ]);
  });

  it("ED-05: a failing display-name write does not fail the upload", async () => {
    const stub = makeStubs({
      provenance: {},
      displayNameError: new Error("db down"),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await stub.service.uploadFile(USER, {
        ...NAMED_FILE,
        workspaceId: TEAM_WORKSPACE,
      });

      expect(result.asset.id).toBe("asset-1");
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain("display name was not recorded");
    } finally {
      warn.mockRestore();
    }
  });

  it("ED-05: a download URL is signed with the stored display name", async () => {
    const stub = makeStubs({
      provenance: {},
      storedDisplayName: "角色-小橘.png",
      assetRow: NAMED_ASSET_ROW,
    });

    const url = await stub.service.getAssetUrl(USER, "asset-1", {
      download: true,
    });

    expect(stub.displayNameReads).toEqual([{ assetId: "asset-1" }]);
    expect(stub.signedOptions[stub.signedOptions.length - 1]).toEqual({
      download: "角色-小橘.png",
    });
    expect(url).toContain("token=sig");
  });

  it("ED-05: without a stored name the download falls back to the object key's last segment", async () => {
    const stub = makeStubs({
      provenance: {},
      storedDisplayName: null,
      assetRow: NAMED_ASSET_ROW,
    });

    await stub.service.getAssetUrl(USER, "asset-1", { download: true });

    expect(stub.signedOptions[0]).toEqual({ download: "123-photo.png" });

    // A plain view is still signed with no options at all.
    await stub.service.getAssetUrl(USER, "asset-1");

    expect(stub.signedOptions[1]).toBeUndefined();
  });
});

/**
 * ED-05: the zip download. These cases build their own small fixture instead of
 * widening `makeStubs`: every asset id needs its own row and its own bytes.
 */
function makeZipStubs(options: {
  rows: Record<string, { object_path: string; byte_size: number | null } | null>;
  names?: Record<string, string>;
}) {
  const fetched: string[] = [];
  const fetchStub = vi.fn(async (url: string | URL | Request) => {
    const text = String(url);
    fetched.push(text);
    return new Response(Buffer.from(`bytes-of-${text}`));
  });
  vi.stubGlobal("fetch", fetchStub);

  const userClient = {
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (path: string) => ({
            data: { signedUrl: `https://storage.test/${bucket}/${path}?token=t` },
            error: null,
          }),
        };
      },
    },
  };

  const service = createUploadService({
    createUserClient: () => userClient as unknown as UserSupabaseClient,
    // 45AI: the zip path signs and fetches over HTTP; the store seam is wired so
    // the service can be built, and nothing in these cases may need it.
    createObjectStore: () =>
      withClientSigning(
        createFakeStore({}),
        userClient as unknown as UserSupabaseClient,
      ),
    assetReadRepository: {
      async findReadableAsset(input: { actorId: string; assetId: string }) {
        const row = options.rows[input.assetId];
        if (!row) return null;
        return {
          id: input.assetId,
          bucket: "project-assets",
          object_path: row.object_path,
          mime_type: "image/png",
          byte_size: row.byte_size,
          workspace_id: TEAM_WORKSPACE,
          project_id: PROJECT,
          created_at: "2026-10-02T00:00:00.000Z",
        };
      },
    } as unknown as AssetReadRepository,
    assetWriteRepository: {} as unknown as AssetWriteRepository,
    assetProvenanceRepository: {
      async recordProvenance() {
        return { updated: 1 };
      },
      async recordDisplayName() {
        return { updated: 1 };
      },
      async readDisplayName(input: { assetId: string }) {
        return options.names?.[input.assetId] ?? null;
      },
    } as unknown as Pick<
      AssetProvenanceRepository,
      "recordProvenance" | "recordDisplayName" | "readDisplayName"
    >,
  });

  return { service, fetched, fetchStub };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

describe("prepareZipDownload (ED-05)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ED-05: three readable assets become a zip with three entries named after their display names", async () => {
    const stub = makeZipStubs({
      rows: {
        a1: { object_path: "ws/1-a.png", byte_size: 10 },
        a2: { object_path: "ws/2-b.png", byte_size: 10 },
        a3: { object_path: "ws/3-c.png", byte_size: 10 },
      },
      names: { a1: "one.png", a2: "two.png", a3: "three.png" },
    });

    const result = await stub.service.prepareZipDownload(USER, {
      assetIds: ["a1", "a2", "a3"],
      projectName: "角色设定",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bytes = await readAll(result.stream);

    expect(bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(bytes.includes(Buffer.from("one.png"))).toBe(true);
    expect(bytes.includes(Buffer.from("two.png"))).toBe(true);
    expect(bytes.includes(Buffer.from("three.png"))).toBe(true);
    expect(stub.fetchStub).toHaveBeenCalledTimes(3);
  });

  it("ED-05: an unreadable asset is skipped and counted", async () => {
    const stub = makeZipStubs({
      rows: {
        a1: { object_path: "ws/1-a.png", byte_size: 10 },
        a2: null,
        a3: { object_path: "ws/3-c.png", byte_size: 10 },
      },
      names: { a1: "one.png", a3: "three.png" },
    });

    const result = await stub.service.prepareZipDownload(USER, {
      assetIds: ["a1", "a2", "a3"],
      projectName: "角色设定",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.skipped).toBe(1);

    const bytes = await readAll(result.stream);

    expect(bytes.includes(Buffer.from("one.png"))).toBe(true);
    expect(bytes.includes(Buffer.from("three.png"))).toBe(true);
    expect(stub.fetchStub).toHaveBeenCalledTimes(2);
  });

  it("ED-05: 51 readable assets are refused before any download", async () => {
    const rows: Record<string, { object_path: string; byte_size: number | null }> = {};
    const assetIds: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      rows[`a${index}`] = { object_path: `ws/${index}-x.png`, byte_size: 1 };
      assetIds.push(`a${index}`);
    }
    const stub = makeZipStubs({ rows });

    const result = await stub.service.prepareZipDownload(USER, {
      assetIds,
      projectName: "角色设定",
    });

    expect(result).toEqual({ ok: false, message: "选中过多，请分批下载" });
    expect(stub.fetchStub).toHaveBeenCalledTimes(0);
  });

  it("ED-05: the zip is named after the project in Shanghai time", async () => {
    const stub = makeZipStubs({
      rows: { a1: { object_path: "ws/1-a.png", byte_size: 10 } },
    });

    const result = await stub.service.prepareZipDownload(USER, {
      assetIds: ["a1"],
      projectName: "角色设定",
      now: new Date("2026-10-20T16:05:00Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.fileName).toBe("角色设定_20261021-0005.zip");
    await readAll(result.stream);
  });
});

// AS-06: the reference tab's list. Three answers must stay apart — a repository
// that does not carry the list (a wiring gap, 503), one that refused (500) and an
// empty project (200 with no rows) — and the name and the URL come from the row and
// the one signing helper, never from the object key alone.
describe("AS-06: listProjectUploads", () => {
  const LIST_ROWS = [
    {
      id: "asset-1",
      bucket: "project-assets",
      object_path: "ws/p/123-b.png",
      mime_type: "image/png",
      byte_size: 3,
      workspace_id: TEAM_WORKSPACE,
      project_id: PROJECT,
      created_at: "2026-10-13T00:00:00.000Z",
      display_name: "角色-小橘.png",
    },
    {
      id: "asset-2",
      bucket: "project-assets",
      object_path: "ws/p/123-a.png",
      mime_type: "image/png",
      byte_size: 4,
      workspace_id: TEAM_WORKSPACE,
      project_id: PROJECT,
      created_at: "2026-10-12T00:00:00.000Z",
      display_name: null,
    },
  ];

  it("AS-06: uploads are listed with their display names and signed urls", async () => {
    const stub = makeStubs({ uploadList: LIST_ROWS });

    const uploads = await stub.service.listProjectUploads(USER, {
      projectId: PROJECT,
    });

    // ED-05: the stored name wins, the object key's last segment is the fallback.
    expect(uploads.map((upload) => upload.name)).toEqual([
      "角色-小橘.png",
      "123-a.png",
    ]);
    expect(uploads.map((upload) => upload.id)).toEqual(["asset-1", "asset-2"]);
    for (const upload of uploads) expect(upload.url).toContain("token=sig");
    // Each row is signed in the bucket that row names.
    expect(stub.signedCalls).toEqual([
      { bucket: "project-assets", path: "ws/p/123-b.png", expiresIn: 3600 },
      { bucket: "project-assets", path: "ws/p/123-a.png", expiresIn: 3600 },
    ]);
  });

  it("AS-06: the default order is newest and the limit is 200", async () => {
    const stub = makeStubs({ uploadList: [] });

    await stub.service.listProjectUploads(USER, { projectId: PROJECT });

    // No media filter is sent at all when the caller did not name one: "absent" and
    // "undefined" must not look different to the repository.
    expect(stub.uploadListCalls).toEqual([
      { actorId: "user-1", projectId: PROJECT, order: "newest", limit: 200 },
    ]);
  });

  it("AS-06: a repository failure is a 500 upload_failed", async () => {
    const stub = makeStubs({
      uploadListError: {
        message: "asset read failed (listReadableProjectUploads)",
      },
    });

    const error = await stub.service
      .listProjectUploads(USER, { projectId: PROJECT })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("upload_failed");
    expect(error?.message).toBe("Failed to list uploads.");
    // The repository's own text never becomes the client's answer.
    expect(error?.message).not.toContain("listReadableProjectUploads");
    expect(stub.signedCalls).toEqual([]);
  });

  it("AS-06: without the list method the service answers 503", async () => {
    const stub = makeStubs({});

    const error = await stub.service
      .listProjectUploads(USER, { projectId: PROJECT })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(503);
    expect(error?.code).toBe("upload_failed");
    expect(error?.message).toBe("Listing uploads is not available.");
    expect(stub.uploadListCalls).toEqual([]);
    expect(stub.signedCalls).toEqual([]);
  });
});

// ED-00i: a tool output the browser rendered itself is uploaded by the front end.
// Its source is a whitelisted `tool:*` value and its parent is recorded, so a
// relayed tool artifact can never be filed as a plain `user_upload`.
describe("ED-00i: uploadToolOutput records a tool source", () => {
  const TOOL_OUTPUT = {
    parentArtifactId: "parent-1",
    source: "tool:adjust" as const,
    fileName: "adjusted.png",
    fileBuffer: Buffer.from("abc"),
    mimeType: "image/png",
    workspaceId: TEAM_WORKSPACE,
  };

  it("ED-00i: a tool output is recorded as tool:adjust with its parent and zero credits", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      provenance: {},
    });

    const result = await stub.service.uploadToolOutput(USER, TOOL_OUTPUT);

    expect(stub.assetLookups[0]).toEqual({
      actorId: "user-1",
      assetId: "parent-1",
    });
    expect(stub.provenanceCalls).toHaveLength(1);
    expect(stub.provenanceCalls[0]?.provenance).toMatchObject({
      source: "tool:adjust",
      operation: "adjust",
      creditsCharged: 0,
      parentArtifactId: "parent-1",
    });
    expect(stub.provenanceCalls[0]?.provenance.source).not.toBe("user_upload");
    expect(result.asset.id).toBe("asset-1");
  });

  it("ED-00i: the output joins the parent's project", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      provenance: {},
      assetRow: {
        id: "parent-1",
        bucket: "project-assets",
        object_path: "ws/project-9/123-source.png",
        mime_type: "image/png",
        byte_size: 3,
        workspace_id: TEAM_WORKSPACE,
        project_id: "project-9",
        created_at: "2026-10-20T00:00:00.000Z",
      },
    });

    await stub.service.uploadToolOutput(USER, TOOL_OUTPUT);

    expect(stub.recordCalls).toHaveLength(1);
    expect(stub.recordCalls[0]?.projectId).toBe("project-9");
    // The object is filed under the parent's project too.
    expect(stub.uploads[0]?.path).toContain("project-9");
  });

  it("ED-00i: an unreadable parent is a 404 and nothing is uploaded", async () => {
    const stub = makeStubs({ assetRow: null, provenance: {} });

    const error = await stub.service
      .uploadToolOutput(USER, TOOL_OUTPUT)
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(404);
    expect(error?.code).toBe("upload_failed");
    expect(stub.uploads).toEqual([]);
    expect(stub.recordCalls).toEqual([]);
    expect(stub.provenanceCalls).toEqual([]);
  });

  it("ED-00i: a failing parent lookup is a 500", async () => {
    const stub = makeStubs({
      assetReadError: { message: "asset read failed (findReadableAsset)" },
      provenance: {},
    });

    const error = await stub.service
      .uploadToolOutput(USER, TOOL_OUTPUT)
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("upload_failed");
    expect(error?.message).toBe("Failed to verify the source artifact.");
    expect(stub.uploads).toEqual([]);
  });
});
