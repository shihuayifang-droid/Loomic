// X-52 prep (T4): the backfill may only fill in ownership it can PROVE.
//
// Every case below is a way the tool could otherwise do damage: inventing a
// project from an object path, picking a winner when two sources disagree,
// overwriting a row that already names a project, or writing a plan that a
// concurrent worker has already made stale. The dry run must also be genuinely
// read-only, because that is the mode the release gate tells a human to trust.
import { describe, expect, it } from "vitest";

import type { AdminSupabaseClient } from "../supabase/admin.js";
import {
  parseBackfillArgs,
  runProjectAssetBackfill,
} from "./hahart-project-asset-backfill.js";

const TEAM = "ws-team";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const CANVAS_A = "canvas-a";
const USER = "user-1";

const JOB_OBJECT = "ws-team/generated/1-job-1.png";
const CANVAS_FILE = "ws-team/canvas-files/canvas-a/file-1.png";
const CANVAS_VIDEO = "ws-team/canvas-files/canvas-a/file-2.mp4";
const THUMBNAIL = "ws-team/project-a/thumbnail.png";

type Row = Record<string, unknown>;

function makeAdmin(options: {
  canvases?: Row[];
  jobs?: Row[];
  projects?: Row[];
  assets?: Row[];
  /** Storage keys that actually exist. */
  objects?: string[];
  rpcError?: { message: string } | null;
  /** Rows the guard read returns, keyed by object path (defaults to the input). */
  guardRows?: Record<string, Row | null>;
}) {
  const rpcs: Array<{ name: string; params: Record<string, unknown> }> = [];
  const writes: Row[] = [];

  const tables: Record<string, Row[]> = {
    projects: options.projects ?? [
      { id: PROJECT_A, workspace_id: TEAM, thumbnail_path: null, created_by: USER },
    ],
    canvases: options.canvases ?? [],
    background_jobs: options.jobs ?? [],
    // Every asset row in this file lives in the project-assets bucket; the query
    // filters on it, so the fixture supplies it.
    asset_objects: (options.assets ?? []).map((row) => ({
      bucket: "project-assets",
      ...row,
    })),
  };

  const objects = new Set(options.objects ?? []);

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let columns = "";

    const rows = () => {
      let result = (tables[table] ?? []).filter((row) =>
        filters.every(([column, value]) => row[column] === value),
      );
      if (columns.includes("thumbnail_path")) {
        // projects is read twice with different projections; keep both shapes.
        result = result.map((row) => ({ ...row }));
      }
      return result;
    };

    const chain = {
      select: (list: string) => {
        columns = list;
        return chain;
      },
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return chain;
      },
      range: async (from: number, to: number) => ({
        data: rows().slice(from, to + 1),
        error: null,
      }),
      maybeSingle: async () => {
        const found = rows()[0] ?? null;
        const path = String(filters.find(([column]) => column === "object_path")?.[1] ?? "");
        if (options.guardRows && path in options.guardRows) {
          return { data: options.guardRows[path] ?? null, error: null };
        }
        return { data: found, error: null };
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
      update: (patch: Row) => {
        writes.push(patch);
        return chain;
      },
    };

    return chain;
  }

  const client = {
    from: (table: string) => builder(table),
    storage: {
      from: () => ({
        list: async (prefix: string) => {
          const entries = [...objects]
            .filter((key) => {
              const slash = key.lastIndexOf("/");
              const folder = slash < 0 ? "" : key.slice(0, slash);
              return folder === prefix;
            })
            .map((key) => ({ name: key.slice(key.lastIndexOf("/") + 1), id: key }));
          return { data: entries, error: null };
        },
      }),
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcs.push({ name, params });
      if (options.rpcError) return { data: null, error: options.rpcError };
      return { data: { asset_id: `asset-${rpcs.length}` }, error: null };
    },
  };

  return { client: client as unknown as AdminSupabaseClient, rpcs, writes };
}

/** A job whose own project_id predates the column; the canvas supplies it. */
function job(objectPath: string, overrides: Row = {}): Row {
  return {
    status: "succeeded",
    project_id: null,
    canvas_id: CANVAS_A,
    created_by: USER,
    result: { object_path: objectPath, mime_type: "image/png" },
    ...overrides,
  };
}

describe("project asset backfill", () => {
  it("case 1: a dry run reports the plan and writes nothing at all", async () => {
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      objects: [JOB_OBJECT],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: false });

    expect(admin.rpcs).toHaveLength(0);
    expect(admin.writes).toHaveLength(0);
    expect(report).toMatchObject({
      discovered: 1,
      recorded: 1,
      alreadyCorrect: 0,
      conflicts: [],
      unmatched: [],
      apply: false,
    });
    expect(JSON.stringify(report)).not.toContain("http");
  });

  it("case 2: apply records the job's object under its canvas's project", async () => {
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      objects: [JOB_OBJECT],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true });

    expect(report.recorded).toBe(1);
    expect(admin.rpcs).toHaveLength(1);
    expect(admin.rpcs[0]?.name).toBe("record_project_asset");
    expect(admin.rpcs[0]?.params).toMatchObject({
      p_bucket: "project-assets",
      p_object_path: JOB_OBJECT,
      p_project_id: PROJECT_A,
      p_canvas_id: CANVAS_A,
      p_created_by: USER,
      p_fallback_workspace_id: TEAM,
    });
  });

  it("case 3: canvas files and videos are discovered from the stored document", async () => {
    const admin = makeAdmin({
      canvases: [
        {
          id: CANVAS_A,
          project_id: PROJECT_A,
          created_by: USER,
          content: {
            files: {
              "file-1": { id: "file-1", dataURL: `oss://project-assets/${CANVAS_FILE}` },
              // A base64 payload is not a stored object and must be ignored.
              "file-9": { id: "file-9", dataURL: "data:image/png;base64,AAAA" },
            },
            elements: [{ type: "embeddable", link: `oss://project-assets/${CANVAS_VIDEO}` }],
          },
        },
      ],
      objects: [CANVAS_FILE, CANVAS_VIDEO],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: false });

    expect(report.discovered).toBe(2);
    expect(report.recorded).toBe(2);
    expect(report.unmatched).toEqual([]);
  });

  it("case 4: project thumbnails are discovered as project assets", async () => {
    const admin = makeAdmin({
      projects: [
        { id: PROJECT_A, workspace_id: TEAM, thumbnail_path: THUMBNAIL, created_by: USER },
      ],
      objects: [THUMBNAIL],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true });

    expect(admin.rpcs).toHaveLength(1);
    expect(admin.rpcs[0]?.params).toMatchObject({
      p_object_path: THUMBNAIL,
      p_project_id: PROJECT_A,
    });
    expect(report.recorded).toBe(1);
  });

  it("case 5: two sources disagreeing about an object is a conflict, not a pick", async () => {
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT, { project_id: PROJECT_A })],
      canvases: [
        {
          id: CANVAS_A,
          project_id: PROJECT_B,
          created_by: USER,
          content: {
            files: { "f": { dataURL: `oss://project-assets/${JOB_OBJECT}` } },
          },
        },
      ],
      projects: [
        { id: PROJECT_A, workspace_id: TEAM, thumbnail_path: null, created_by: USER },
        { id: PROJECT_B, workspace_id: TEAM, thumbnail_path: null, created_by: USER },
      ],
      objects: [JOB_OBJECT],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true });

    expect(report.conflicts).toEqual([JOB_OBJECT]);
    expect(report.recorded).toBe(0);
    expect(admin.rpcs).toHaveLength(0);
  });

  it("case 6: an object that is not in storage is unmatched, never recorded", async () => {
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      objects: [],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true });

    expect(report.unmatched).toEqual([JOB_OBJECT]);
    expect(admin.rpcs).toHaveLength(0);
  });

  it("case 7: a row that already names another project is left alone", async () => {
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      assets: [
        { object_path: JOB_OBJECT, project_id: PROJECT_B, workspace_id: TEAM, created_by: USER },
      ],
      objects: [JOB_OBJECT],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true });

    expect(report.conflicts).toEqual([JOB_OBJECT]);
    expect(report.recorded).toBe(0);
    expect(admin.rpcs).toHaveLength(0);
  });

  it("case 8: a row that is already correct is counted, not rewritten", async () => {
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      assets: [
        { object_path: JOB_OBJECT, project_id: PROJECT_A, workspace_id: TEAM, created_by: USER },
      ],
      objects: [JOB_OBJECT],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true });

    expect(report).toMatchObject({ recorded: 0, alreadyCorrect: 1, conflicts: [] });
    expect(admin.rpcs).toHaveLength(0);
  });

  it("case 9: a row with no project is adopted exactly once", async () => {
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      assets: [
        { object_path: JOB_OBJECT, project_id: null, workspace_id: TEAM, created_by: USER },
      ],
      objects: [JOB_OBJECT],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true });

    expect(report.recorded).toBe(1);
    expect(admin.rpcs).toHaveLength(1);
    expect(admin.rpcs[0]?.params.p_project_id).toBe(PROJECT_A);
  });

  it("case 10: a plan made stale by a concurrent write is dropped, not forced", async () => {
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      assets: [
        { object_path: JOB_OBJECT, project_id: null, workspace_id: TEAM, created_by: USER },
      ],
      objects: [JOB_OBJECT],
      // Between planning and writing, a worker claimed the object for B.
      guardRows: { [JOB_OBJECT]: { project_id: PROJECT_B, workspace_id: TEAM } },
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true });

    expect(admin.rpcs).toHaveLength(0);
    expect(report.recorded).toBe(0);
    expect(report.conflicts).toEqual([JOB_OBJECT]);
  });

  it("case 10b: a workspace-only change since planning is dropped too", async () => {
    // The object had no project at plan time, so the plan was to adopt it into
    // PROJECT_A. In between, somebody moved the SAME row to another workspace
    // while leaving project_id null. Comparing only the project would see
    // null === null and call the plan safe — and the RPC would then write the
    // planned workspace over the newer one. The whole ownership state is the
    // guard, not just the project.
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      assets: [
        { object_path: JOB_OBJECT, project_id: null, workspace_id: TEAM, created_by: USER },
      ],
      objects: [JOB_OBJECT],
      guardRows: { [JOB_OBJECT]: { project_id: null, workspace_id: "ws-other" } },
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true });

    expect(admin.rpcs).toHaveLength(0);
    expect(report.recorded).toBe(0);
    expect(report.conflicts).toEqual([JOB_OBJECT]);
  });

  it("case 11: an object nothing points at is left unmatched", async () => {
    const admin = makeAdmin({
      assets: [
        { object_path: "ws-team/orphan.png", project_id: null, workspace_id: TEAM, created_by: USER },
      ],
      objects: ["ws-team/orphan.png"],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true });

    expect(report.unmatched).toEqual(["ws-team/orphan.png"]);
    expect(admin.rpcs).toHaveLength(0);
  });

  it("case 12: defaults to a dry run", () => {
    expect(parseBackfillArgs([])).toEqual({ apply: false });
    expect(parseBackfillArgs(["--apply"])).toEqual({ apply: true });
  });
});
