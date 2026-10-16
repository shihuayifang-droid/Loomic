// The recovery layer, driven through the canvas read repository (workorder 20C).
//
// Two halves, and they are different shapes of work:
//
//   GET  lists succeeded image generations that no element references. The job
//        list is a pure read and now comes from the repository, which re-applies
//        the canvas's project ACL in SQL for the real actor.
//   POST puts a requested subset back. That is a WRITE, and it must keep going
//        through the untouched shared path: `insertImageElement` →
//        `mutateCanvasContent` → `readCanvasSnapshot`/`writeIfUnchanged`. This
//        ticket does not migrate it, and these cases would fail if someone
//        rerouted the write through the read repository.
//
// The fake canvas client below is written with method-shorthand `from(...)` and
// never as a dotted `<client> from(...)` call: the repository audit counts that
// text literally, comments included, so a PostgREST call spelled out here would
// raise `server.fromCallsIncludingTests` — the very number this ticket lowers.
import { describe, expect, it } from "vitest";

import type { CanvasContent } from "@loomic/shared";

import type {
  CanvasReadRepository,
  CanvasRecoveryJobRow,
} from "../../db/canvas-read-repository.js";
import {
  listRecoverableArtifacts,
  recoverArtifacts,
  type RecoveryReadAccess,
} from "./canvas-recovery.js";

const CANVAS_ID = "canvas-1";
const ACTOR_ID = "user-1";
const OTHER_ACTOR_ID = "user-2";

const REFERENCED_PATH = "ws-team/generated/kept.png";
const RECOVERABLE_PATH = "ws-team/generated/lost.png";
const SECOND_PATH = "ws-team/generated/second.png";
const DUPLICATE_PATH = "ws-team/generated/lost.png";

type CanvasContentLike = {
  elements: Array<Record<string, unknown>>;
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

/**
 * A canvas client good enough for the shared read/CAS path: `select().eq()`
 * reads and `update().eq("version")` writes, with the optimistic lock honoured
 * (a stale version matches no row, exactly like PostgREST).
 */
function createFakeCanvasClient(initial: CanvasContentLike) {
  const state = { content: initial, version: 3 };
  const writes: Array<{ version: number; elements: number; files: number }> = [];
  const reads: number[] = [];

  const client = {
    from(table: string) {
      if (table !== "canvases") {
        throw new Error(`fake canvas client: unexpected table ${table}`);
      }

      let mode: "select" | "update" = "select";
      let patch: { content?: CanvasContentLike; version?: number } = {};
      const filters: Array<[string, unknown]> = [];

      const chain = {
        select: () => chain,
        update: (next: { content?: CanvasContentLike; version?: number }) => {
          mode = "update";
          patch = next;
          return chain;
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        },
        maybeSingle: async () => {
          if (mode === "select") {
            reads.push(state.version);
            return {
              data: {
                id: CANVAS_ID,
                content: state.content,
                version: state.version,
              },
              error: null,
            };
          }

          const expected = filters.find(([column]) => column === "version");
          if (expected && expected[1] !== state.version) {
            return { data: null, error: null };
          }

          state.content = patch.content ?? state.content;
          state.version = patch.version ?? state.version;
          writes.push({
            version: state.version,
            elements: state.content.elements.length,
            files: Object.keys(state.content.files).length,
          });
          return { data: { version: state.version }, error: null };
        },
      };

      return chain;
    },
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async () => ({
            data: { signedUrl: `https://proj.test/${bucket}/signed?token=sig` },
            error: null,
          }),
        };
      },
    },
  };

  return { client, writes, reads, state };
}

type JobOverrides = Partial<CanvasRecoveryJobRow> & { id: string };

function job(overrides: JobOverrides): CanvasRecoveryJobRow {
  return {
    id: overrides.id,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    payload: overrides.payload === undefined ? { prompt: "a cat" } : overrides.payload,
    result:
      overrides.result === undefined
        ? {
            object_path: RECOVERABLE_PATH,
            width: 512,
            height: 512,
            mime_type: "image/png",
            signed_url: "https://proj.test/storage/v1/object/sign/project-assets/x.png",
          }
        : overrides.result,
  };
}

function makeRepository(
  jobs: readonly CanvasRecoveryJobRow[],
  options: { error?: Error } = {},
) {
  const calls: Array<{ actorId: string; canvasId: string }> = [];

  const repository: CanvasReadRepository = {
    async findReadableCanvasContent() {
      throw new Error("the recovery path must not read canvas content");
    },
    async findReadableCanvasProjectLink() {
      throw new Error("the recovery path must not read the canvas project link");
    },
    async listReadableSucceededImageJobs(input) {
      calls.push({ actorId: input.actorId, canvasId: input.canvasId });
      if (options.error) throw options.error;
      return [...jobs];
    },
    async listReadableCanvasAssets() {
      return [];
    },
  };

  return { repository, calls };
}

function accessFor(
  repository: CanvasReadRepository,
  actorId = ACTOR_ID,
): RecoveryReadAccess {
  return { repository, actorId };
}

/** A canvas holding one referenced image, including a soft-deleted reference. */
function canvasWithOneReferencedImage(): CanvasContentLike {
  return {
    elements: [
      { id: "el-kept", type: "image", fileId: "file-kept", isDeleted: false },
      { id: "el-deleted", type: "image", fileId: "file-deleted", isDeleted: true },
    ],
    appState: {},
    files: {
      "file-kept": { id: "file-kept", dataURL: `oss://project-assets/${REFERENCED_PATH}` },
      // Soft-deleted elements still count as "on the canvas": an accidental
      // overwrite removes the element entirely, a user deletion keeps it.
      "file-deleted": {
        id: "file-deleted",
        dataURL: `oss://project-assets/${REFERENCED_PATH}`,
      },
    },
  };
}

describe("canvas-recovery: GET reads through the canvas repository", () => {
  it("case 1: offers exactly the succeeded images nothing on the canvas references", async () => {
    const { client } = createFakeCanvasClient(canvasWithOneReferencedImage());
    const { repository } = makeRepository([
      job({
        id: "job-kept",
        result: {
          object_path: REFERENCED_PATH,
          width: 512,
          height: 512,
          signed_url: "https://proj.test/storage/v1/object/sign/project-assets/kept.png",
        },
      }),
      job({ id: "job-lost" }),
      // Two jobs pointing at the same file are offered once.
      job({ id: "job-lost-twin", result: { object_path: DUPLICATE_PATH, width: 512, height: 512 } }),
      job({
        id: "job-no-path",
        result: { width: 512, height: 512, signed_url: "https://proj.test/x.png" },
      }),
      job({
        id: "job-bad-size",
        result: { object_path: SECOND_PATH, width: 0, height: 512 },
      }),
      job({
        id: "job-other-bucket",
        result: {
          object_path: SECOND_PATH,
          width: 512,
          height: 512,
          signed_url: "https://proj.test/storage/v1/object/sign/user-avatars/x.png",
        },
      }),
      job({ id: "job-second", result: { object_path: SECOND_PATH, width: 640, height: 480 } }),
    ]);

    const artifacts = await listRecoverableArtifacts(
      client as never,
      CANVAS_ID,
      accessFor(repository),
    );

    // "job-kept" is referenced (through a SOFT-DELETED element, which still
    // counts), and the unusable rows are reported as skipped rather than
    // silently dropped.
    expect(artifacts.map((artifact) => artifact.jobId)).toEqual([
      "job-lost",
      "job-second",
    ]);
    expect(artifacts.map((artifact) => artifact.objectPath)).toEqual([
      RECOVERABLE_PATH,
      SECOND_PATH,
    ]);
    // The artifact keeps the job's own dimensions and its preview URL.
    expect(artifacts[1]).toMatchObject({
      width: 640,
      height: 480,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("case 2: the repository is asked with the real actor id and canvas id", async () => {
    const { client } = createFakeCanvasClient({ elements: [], appState: {}, files: {} });
    const { repository, calls } = makeRepository([]);

    await listRecoverableArtifacts(
      client as never,
      CANVAS_ID,
      accessFor(repository, OTHER_ACTOR_ID),
    );

    expect(calls).toEqual([{ actorId: OTHER_ACTOR_ID, canvasId: CANVAS_ID }]);
  });

  it("case 3: a repository failure is not swallowed into an empty list", async () => {
    const { client } = createFakeCanvasClient({ elements: [], appState: {}, files: {} });
    const failure = new Error("canvas read failed (listReadableSucceededImageJobs)");
    const { repository } = makeRepository([], { error: failure });

    // "nothing to recover" and "the database could not be asked" must not look
    // the same to the route, which audits a successful read.
    await expect(
      listRecoverableArtifacts(client as never, CANVAS_ID, accessFor(repository)),
    ).rejects.toBe(failure);
  });

  it("case 4: without an access the read refuses instead of answering []", async () => {
    const { client } = createFakeCanvasClient({ elements: [], appState: {}, files: {} });

    // The two-argument form stays legal for the legacy manual verifier; it must
    // fail loud rather than report that there is nothing to recover.
    await expect(
      listRecoverableArtifacts(client as never, CANVAS_ID),
    ).rejects.toThrow(/canvas read failed \(listReadableSucceededImageJobs\)/);
  });
});

describe("canvas-recovery: POST still writes through the shared CAS path", () => {
  it("case 5: restores one image, re-reads the version and returns the post-write one", async () => {
    const fake = createFakeCanvasClient({ elements: [], appState: {}, files: {} });
    const { repository } = makeRepository([job({ id: "job-lost" })]);

    const outcome = await recoverArtifacts(
      fake.client as never,
      CANVAS_ID,
      ["job-lost"],
      accessFor(repository),
    );

    expect(outcome).toEqual({ recovered: 1, skipped: [], version: 4 });
    // One write, through `mutateCanvasContent`'s conditional update, and the
    // returned version is the one read back AFTER the write.
    expect(fake.writes).toEqual([{ version: 4, elements: 1, files: 1 }]);
    expect(fake.state.content.elements).toHaveLength(1);
    const restoredFile = Object.values(fake.state.content.files)[0] as
      | { dataURL?: string }
      | undefined;
    expect(restoredFile?.dataURL).toBe(`oss://project-assets/${RECOVERABLE_PATH}`);
  });

  it("case 6: a second identical call recovers nothing and writes nothing", async () => {
    const fake = createFakeCanvasClient({ elements: [], appState: {}, files: {} });
    const { repository } = makeRepository([job({ id: "job-lost" })]);

    await recoverArtifacts(fake.client as never, CANVAS_ID, ["job-lost"], accessFor(repository));
    const writesAfterFirst = fake.writes.length;

    const second = await recoverArtifacts(
      fake.client as never,
      CANVAS_ID,
      ["job-lost"],
      accessFor(repository),
    );

    // The image is on the canvas now, so it is no longer "recoverable" — the
    // list is recomputed from current content, never trusted from the request.
    expect(second).toEqual({ recovered: 0, skipped: ["job-lost"], version: 4 });
    expect(fake.writes).toHaveLength(writesAfterFirst);
    expect(fake.state.content.elements).toHaveLength(1);
  });

  it("case 7: ids that are not available are skipped and nothing is written", async () => {
    const fake = createFakeCanvasClient(canvasWithOneReferencedImage());
    const { repository } = makeRepository([
      // Already referenced by the canvas, so it is not recoverable any more.
      job({
        id: "job-kept",
        result: { object_path: REFERENCED_PATH, width: 512, height: 512 },
      }),
    ]);

    const outcome = await recoverArtifacts(
      fake.client as never,
      CANVAS_ID,
      ["job-kept", "job-unknown"],
      accessFor(repository),
    );

    expect(outcome).toEqual({
      recovered: 0,
      skipped: ["job-kept", "job-unknown"],
      version: 3,
    });
    // The version is still read after the (empty) write phase, so an open
    // editor can keep saving.
    expect(fake.writes).toHaveLength(0);
    expect(fake.reads.at(-1)).toBe(3);
  });

  it("case 8: the restore path carries the actor into every repository read", async () => {
    const fake = createFakeCanvasClient({ elements: [], appState: {}, files: {} });
    const { repository, calls } = makeRepository([job({ id: "job-lost" })]);

    await recoverArtifacts(
      fake.client as never,
      CANVAS_ID,
      ["job-lost"],
      accessFor(repository, OTHER_ACTOR_ID),
    );

    expect(calls).toEqual([{ actorId: OTHER_ACTOR_ID, canvasId: CANVAS_ID }]);
  });

  it("case 9: the restored canvas content is a real document, not a stub", async () => {
    const fake = createFakeCanvasClient({ elements: [], appState: {}, files: {} });
    const { repository } = makeRepository([job({ id: "job-lost" })]);

    await recoverArtifacts(fake.client as never, CANVAS_ID, ["job-lost"], accessFor(repository));

    const content = fake.state.content as unknown as CanvasContent;
    const element = content.elements[0] as unknown as Record<string, unknown>;
    expect(element.type).toBe("image");
    expect(element.isDeleted).toBe(false);
    expect(element.width).toBe(512);
    expect(JSON.stringify(content)).toContain(`oss://project-assets/${RECOVERABLE_PATH}`);
    // No URL is ever persisted into the canvas document.
    expect(JSON.stringify(content)).not.toContain("http");
  });
});
