// GN-19: a generation slot whose job FAILED must stay on the canvas, marked
// failed — it must not be deleted like a canceled slot.
//
// THE FAILURE THIS PREVENTS
// The agent image path used to remove the reserved slot on every non-success
// exit, so a job that failed left the canvas exactly as it was before: no
// element, no reason, nothing to retry from. The user had no way to tell "this
// failed" apart from "this never started" (CV-02).
//
// Pinned here:
//   1. the slot keeps its place and size and is marked failed with reason+jobId;
//   2. a slot that is already gone is not written at all;
//   3. a slot that already holds a real image is not turned into a failure;
//   4. the helper never throws, even when the canvas cannot be written;
//   5. the marked slot is a NEW element version (so a client can merge it).
import { describe, expect, it } from "vitest";

import type { UserSupabaseClient } from "../../supabase/user.js";
import {
  insertImagePlaceholder,
  markGenerationSlotFailed,
} from "./canvas-element-writer.js";

const CANVAS_ID = "canvas-1";

type CanvasContentLike = {
  elements: Array<Record<string, any>>;
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

/**
 * Canvas client that honours the optimistic version lock, same shape as the
 * fixture in canvas-media-storage.test.ts: a write whose expected version is
 * stale matches no row.
 *
 * `failWrites` makes every write answer with an error instead of a row, which
 * is how a real RLS denial or timeout reaches the writer.
 */
function createFakeCanvasClient(
  initial: CanvasContentLike | null,
  opts: { failWrites?: boolean } = {},
) {
  const state = {
    content: initial as CanvasContentLike | null,
    version: initial ? 3 : 0,
  };
  const writes: Array<{ content: CanvasContentLike; version: number }> = [];

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
          if (state.content === null) return { data: null, error: null };

          if (mode === "select") {
            return {
              data: {
                id: CANVAS_ID,
                name: "Board",
                project_id: "project-1",
                content: state.content,
                version: state.version,
              },
              error: null,
            };
          }

          if (opts.failWrites) {
            return { data: null, error: { message: "permission denied" } };
          }

          const expected = filters.find(([column]) => column === "version");
          if (expected && expected[1] !== state.version) {
            return { data: null, error: null };
          }

          state.content = patch.content ?? state.content;
          state.version = patch.version ?? state.version;
          writes.push({
            content: state.content as CanvasContentLike,
            version: state.version,
          });
          return { data: { version: state.version }, error: null };
        },
      };

      return chain;
    },
  };

  return {
    client: client as unknown as UserSupabaseClient,
    writes,
    state,
  };
}

function emptyCanvas(): CanvasContentLike {
  return { elements: [], appState: {}, files: {} };
}

function canvasWith(elements: Array<Record<string, any>>): CanvasContentLike {
  return { elements, appState: {}, files: {} };
}

function slotElement(id: string, customData: Record<string, unknown>): Record<string, any> {
  return {
    type: "embeddable",
    id,
    x: 5,
    y: 6,
    width: 300,
    height: 200,
    angle: 0,
    version: 1,
    versionNonce: 111,
    isDeleted: false,
    updated: 1,
    link: "loomic://generating",
    locked: false,
    customData,
  };
}

function findElement(
  fake: ReturnType<typeof createFakeCanvasClient>,
  elementId: string,
): Record<string, any> | undefined {
  return fake.state.content?.elements.find((el) => el.id === elementId);
}

describe("GN-19 failed generation slots", () => {
  it("GN-19: a failed slot keeps its place and size and is marked failed with the reason and job id", async () => {
    const fake = createFakeCanvasClient(emptyCanvas());
    const placement = { x: 10, y: 20, width: 512, height: 512 };

    const { elementId } = await insertImagePlaceholder(
      fake.client,
      { canvasId: CANVAS_ID, width: 512, height: 512, kind: "image" },
      placement,
    );

    const before = findElement(fake, elementId);
    expect(before).toBeDefined();

    await markGenerationSlotFailed(fake.client, CANVAS_ID, elementId, {
      message: "图片生成失败，请重试",
      jobId: "job-1",
    });

    const after = findElement(fake, elementId);
    expect(after).toBeDefined();
    expect(after?.x).toBe(before?.x);
    expect(after?.y).toBe(before?.y);
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
    expect(after?.customData.generating).toBe(false);
    expect(after?.customData.failed).toBe(true);
    expect(after?.customData.failureMessage).toBe("图片生成失败，请重试");
    expect(after?.customData.jobId).toBe("job-1");
    expect(after?.customData.kind).toBe("image");
  });

  it("GN-19: marking a slot that is already gone writes nothing", async () => {
    const fake = createFakeCanvasClient(emptyCanvas());

    await markGenerationSlotFailed(fake.client, CANVAS_ID, "slot-does-not-exist", {
      message: "图片生成失败，请重试",
      jobId: "job-2",
    });

    expect(fake.writes.length).toBe(0);
  });

  it("GN-19: a slot that already holds an image is not turned into a failure", async () => {
    const fake = createFakeCanvasClient(
      canvasWith([slotElement("slot-1", { generating: false, source: "generated" })]),
    );

    await markGenerationSlotFailed(fake.client, CANVAS_ID, "slot-1", {
      message: "图片生成失败，请重试",
      jobId: "job-3",
    });

    expect(fake.writes.length).toBe(0);
  });

  it("GN-19: marking never throws when the canvas cannot be written", async () => {
    const fake = createFakeCanvasClient(
      canvasWith([slotElement("slot-1", { generating: true, kind: "image" })]),
      { failWrites: true },
    );

    await expect(
      markGenerationSlotFailed(fake.client, CANVAS_ID, "slot-1", {
        message: "生成超时，请重试",
        jobId: "job-4",
      }),
    ).resolves.toBeUndefined();
  });

  it("GN-19: the failed slot is a new element version", async () => {
    const fake = createFakeCanvasClient(
      canvasWith([slotElement("slot-1", { generating: true, kind: "image" })]),
    );
    const versionBefore = findElement(fake, "slot-1")?.version;

    await markGenerationSlotFailed(fake.client, CANVAS_ID, "slot-1", {
      message: "图片生成失败，请重试",
      jobId: "job-5",
    });

    const versionAfter = findElement(fake, "slot-1")?.version;
    expect(versionBefore).toBe(1);
    expect(versionAfter).toBe(2);
  });
});
