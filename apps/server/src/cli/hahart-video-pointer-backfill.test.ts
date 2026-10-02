// CV-01 backfill: what the tool refuses to do is the part worth testing.
//
// The rewrite itself is one string assignment. Everything that can actually
// destroy history is a REFUSAL, and each one is pinned here:
//
//   - a job from another canvas must not match, even on an identical URL;
//   - one URL mapping to two object paths must not be resolved by guessing;
//   - a canvas that changed since it was read must not be overwritten;
//   - a dry run must not write anything at all;
//   - an element that is already an object marker must be left alone.
//
// "Would have matched" is asserted alongside, because a tool that refuses
// everything is just as broken — the dry run has to show the change it is
// holding back.
//
// No database anywhere in this file: the admin client is a stub, which is also
// what keeps the CLI from being pointed at real data by a test run.
import { describe, expect, it } from "vitest";

import type { AdminSupabaseClient } from "../supabase/admin.js";
import {
  parseBackfillArgs,
  runVideoPointerBackfill,
} from "./hahart-video-pointer-backfill.js";

const MARKER_DONE = "oss://project-assets/gen/already.mp4";

type CanvasRecord = { id: string; content: unknown; version: number };

type StubOptions = {
  jobs: Array<{ canvas_id: string | null; result: unknown }>;
  canvases: CanvasRecord[];
  /** Canvas ids whose update should lose the optimistic lock. */
  conflictOn?: string[];
};

function videoElement(id: string, link: string) {
  return {
    type: "embeddable",
    id,
    link,
    width: 640,
    height: 360,
    customData: { isVideo: true, mimeType: "video/mp4" },
  };
}

/**
 * A Supabase-shaped stub covering exactly the calls the CLI makes: a paged
 * select with eq/not filters, an `in` select, and a conditional update whose
 * `.eq("version", …)` is honoured the way PostgREST does it — zero matching rows
 * and NO error, which is why the write path must inspect the returned rows.
 */
function makeAdminStub(options: StubOptions) {
  const writes: Array<{ id: string; version: number; content: any; matched: boolean }> = [];
  const jobFilters: Array<[string, unknown]> = [];
  const canvases = new Map(options.canvases.map((row) => [row.id, { ...row }]));

  const client = {
    from(table: string) {
      const state = {
        mode: "select" as "select" | "update",
        patch: undefined as any,
        filters: [] as Array<[string, unknown]>,
        inIds: [] as string[],
        range: undefined as [number, number] | undefined,
      };

      const resolve = async () => {
        if (table === "background_jobs") {
          return { data: options.jobs, error: null };
        }
        if (table !== "canvases") {
          throw new Error(`stub: unexpected table ${table}`);
        }

        if (state.mode === "select") {
          const ids = state.inIds.length > 0 ? state.inIds : [...canvases.keys()];
          const rows = ids
            .map((id) => canvases.get(id))
            .filter((row): row is CanvasRecord => row !== undefined)
            .map((row) => ({ id: row.id, content: row.content, version: row.version }));
          // Paging is inclusive on both ends, like PostgREST's `range`.
          const page = state.range
            ? rows.slice(state.range[0], state.range[1] + 1)
            : rows;
          return { data: page, error: null };
        }

        const id = String(state.filters.find(([column]) => column === "id")?.[1] ?? "");
        const expectedVersion = Number(
          state.filters.find(([column]) => column === "version")?.[1],
        );
        const row = canvases.get(id);
        const forced = options.conflictOn?.includes(id) ?? false;
        const matched = !!row && !forced && row.version === expectedVersion;

        writes.push({ id, version: expectedVersion, content: state.patch.content, matched });
        if (!matched) return { data: [], error: null };

        row.content = state.patch.content;
        row.version = expectedVersion + 1;
        return { data: [{ version: row.version }], error: null };
      };

      const chain: any = {
        select: () => chain,
        update: (patch: any) => {
          state.mode = "update";
          state.patch = patch;
          return chain;
        },
        eq: (column: string, value: unknown) => {
          state.filters.push([column, value]);
          if (table === "background_jobs") jobFilters.push([column, value]);
          return chain;
        },
        not: (column: string, operator: string, value: unknown) => {
          state.filters.push([`not:${column}:${operator}`, value]);
          if (table === "background_jobs") {
            jobFilters.push([`not:${column}:${operator}`, value]);
          }
          return chain;
        },
        in: (column: string, value: string[]) => {
          state.inIds = value;
          return chain;
        },
        range: (from: number, to: number) => {
          state.range = [from, to];
          return chain;
        },
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      };

      return chain;
    },
  };

  return {
    client: client as unknown as AdminSupabaseClient,
    writes,
    jobFilters,
    canvases,
  };
}

const MATCHED_URL = "https://cdn.test/signed/a1.mp4";
const LEGACY_URL = "https://cdn.test/signed/no-job.mp4";
const DUP_URL = "https://cdn.test/signed/dup.mp4";

function standardStub(overrides: Partial<StubOptions> = {}) {
  return makeAdminStub({
    jobs: [
      { canvas_id: "canvas-a", result: { signed_url: MATCHED_URL, object_path: "gen/a1.mp4" } },
      // Same URL, same canvas, two different objects -> ambiguous.
      { canvas_id: "canvas-c", result: { signed_url: DUP_URL, object_path: "gen/dup-1.mp4" } },
      { canvas_id: "canvas-c", result: { signed_url: DUP_URL, object_path: "gen/dup-2.mp4" } },
      // A job whose result is missing a half: it can match nothing.
      { canvas_id: "canvas-a", result: { signed_url: LEGACY_URL } },
    ],
    canvases: [
      {
        id: "canvas-a",
        version: 3,
        content: {
          appState: {},
          elements: [
            videoElement("e1", MATCHED_URL),
            videoElement("e2", MARKER_DONE),
            videoElement("e3", LEGACY_URL),
            {
              // Same URL as e1 but not a video: must never be touched.
              type: "embeddable",
              id: "e4",
              link: MATCHED_URL,
              customData: {},
            },
          ],
        },
      },
      {
        id: "canvas-b",
        version: 1,
        content: {
          appState: {},
          elements: [
            // The URL matches a job, but that job belongs to canvas-a.
            videoElement("e5", MATCHED_URL),
          ],
        },
      },
      {
        id: "canvas-c",
        version: 7,
        content: { appState: {}, elements: [videoElement("e6", DUP_URL)] },
      },
    ],
    ...overrides,
  });
}

function elementsOf(stub: ReturnType<typeof makeAdminStub>, canvasId: string) {
  const row = stub.canvases.get(canvasId);
  return (row?.content as { elements: any[] }).elements;
}

describe("CV-01 video pointer backfill", () => {
  it("dry run reports the change and writes nothing", async () => {
    const stub = standardStub();

    const report = await runVideoPointerBackfill(stub.client, { apply: false });

    expect(stub.writes).toHaveLength(0);
    expect(report.canvasesScanned).toBe(3);
    expect(report.canvasesUpdated).toBe(1);
    expect(report.elementsUpdated).toBe(1);
    // The matched element is untouched on disk...
    expect(elementsOf(stub, "canvas-a")[0].link).toBe(MATCHED_URL);
    // ...and nothing that needs attention is hidden.
    expect(report.canvasesConflicted).toEqual([]);
    expect(report.ambiguousJobUrls).toHaveLength(1);
    expect(report.legacyVideosUnmatched.map((entry) => entry.elementId).sort()).toEqual([
      "e3",
      "e5",
    ]);
    // No URL may appear anywhere in the report.
    expect(JSON.stringify(report)).not.toContain("http");
    expect(report.legacyVideosUnmatched[0]?.link).toBe("<redacted>");
  });

  it("apply rewrites the exactly-matched element under the version lock", async () => {
    const stub = standardStub();

    const report = await runVideoPointerBackfill(stub.client, { apply: true });

    expect(report.canvasesUpdated).toBe(1);
    expect(report.elementsUpdated).toBe(1);
    expect(stub.writes).toHaveLength(1);
    expect(stub.writes[0]).toMatchObject({ id: "canvas-a", version: 3, matched: true });

    const elements = elementsOf(stub, "canvas-a");
    expect(elements[0].link).toBe("oss://project-assets/gen/a1.mp4");
    expect(elements[0].customData.isVideo).toBe(true);
    expect(stub.canvases.get("canvas-a")?.version).toBe(4);
  });

  it("only matches inside the same canvas", async () => {
    const stub = standardStub();

    await runVideoPointerBackfill(stub.client, { apply: true });

    // canvas-b holds the very same URL, but its job lives in canvas-a.
    expect(elementsOf(stub, "canvas-b")[0].link).toBe(MATCHED_URL);
    expect(stub.writes.map((write) => write.id)).toEqual(["canvas-a"]);
  });

  it("keeps unmatched legacy URLs and marks them for a human", async () => {
    const stub = standardStub();

    const report = await runVideoPointerBackfill(stub.client, { apply: true });

    expect(elementsOf(stub, "canvas-a")[2].link).toBe(LEGACY_URL);
    expect(report.legacyVideosUnmatched).toEqual([
      { canvasId: "canvas-a", elementId: "e3", link: "<redacted>" },
      { canvasId: "canvas-b", elementId: "e5", link: "<redacted>" },
    ]);
  });

  it("skips an ambiguous URL instead of picking an object", async () => {
    const stub = standardStub();

    const report = await runVideoPointerBackfill(stub.client, { apply: true });

    expect(elementsOf(stub, "canvas-c")[0].link).toBe(DUP_URL);
    expect(stub.writes.map((write) => write.id)).toEqual(["canvas-a"]);
    expect(report.ambiguousJobUrls).toHaveLength(1);
  });

  it("reports a version conflict instead of overwriting", async () => {
    const stub = standardStub({ conflictOn: ["canvas-a"] });

    const report = await runVideoPointerBackfill(stub.client, { apply: true });

    expect(report.canvasesConflicted).toEqual(["canvas-a"]);
    expect(report.canvasesUpdated).toBe(0);
    // The competing write survives: this tool does not overwrite it.
    expect(elementsOf(stub, "canvas-a")[0].link).toBe(MATCHED_URL);
    expect(stub.canvases.get("canvas-a")?.version).toBe(3);
  });

  it("skips elements that already carry a marker", async () => {
    const stub = standardStub();

    const report = await runVideoPointerBackfill(stub.client, { apply: true });

    expect(elementsOf(stub, "canvas-a")[1].link).toBe(MARKER_DONE);
    // e1 only — the marker element is neither rewritten nor reported.
    expect(report.elementsUpdated).toBe(1);
    expect(
      report.legacyVideosUnmatched.some((entry) => entry.elementId === "e2"),
    ).toBe(false);
  });

  it("asks the database for succeeded video jobs only", async () => {
    const stub = standardStub();

    await runVideoPointerBackfill(stub.client, { apply: false });

    expect(stub.jobFilters).toEqual(
      expect.arrayContaining([
        ["job_type", "video_generation"],
        ["status", "succeeded"],
        ["not:canvas_id:is", null],
      ]),
    );
  });

  it("defaults to a dry run", () => {
    expect(parseBackfillArgs([])).toEqual({ apply: false });
    expect(parseBackfillArgs(["--apply"])).toEqual({ apply: true });
  });
});
