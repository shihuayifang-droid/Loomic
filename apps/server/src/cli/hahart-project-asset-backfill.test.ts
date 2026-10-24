// X-52 prep (T4): the backfill may only fill in ownership it can PROVE.
//
// Every case below is a way the tool could otherwise do damage: inventing a
// project from an object path, picking a winner when two sources disagree,
// overwriting a row that already names a project, or writing a plan that a
// concurrent worker has already made stale. The dry run must also be genuinely
// read-only, because that is the mode the release gate tells a human to trust.
//
// T-20: the stale-plan check is no longer a client-side pre-read. Apply sends the
// whole plan-time snapshot to `record_project_asset_if_matches` and the database
// decides, under a row lock. So the cases below assert two things at once: that
// the complete snapshot is handed over, and that a `conflict` verdict is reported
// rather than retried.
import { describe, expect, it } from "vitest";

import type { AdminSupabaseClient } from "../supabase/admin.js";
import {
  parseBackfillArgs,
  runProjectAssetBackfill,
  type SqlExecutor,
} from "./hahart-project-asset-backfill.js";

/** Positional parameter order of `record_project_asset_if_matches`. */
const RECORD_PARAM_NAMES = [
  "p_bucket",
  "p_object_path",
  "p_created_by",
  "p_fallback_workspace_id",
  "p_project_id",
  "p_canvas_id",
  "p_mime_type",
  "p_byte_size",
  "p_expected_asset_id",
  "p_expected_workspace_id",
  "p_expected_project_id",
  "p_expected_created_by",
  "p_expected_mime_type",
  "p_expected_byte_size",
];

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
  /** Verdicts the compare-and-write RPC returns, keyed by object path. */
  rpcResults?: Record<string, Row>;
}) {
  const rpcs: Array<{ name: string; params: Record<string, unknown> }> = [];
  const writes: Row[] = [];
  // Apply must not pre-read the row any more: the whole point of T-20 is that
  // "still unchanged?" and "write it" happen inside one locked call.
  const reads = { maybeSingle: 0 };

  const tables: Record<string, Row[]> = {
    projects: options.projects ?? [
      { id: PROJECT_A, workspace_id: TEAM, thumbnail_path: null, created_by: USER },
    ],
    canvases: options.canvases ?? [],
    background_jobs: options.jobs ?? [],
    // Every asset row in this file lives in the project-assets bucket, and every
    // row has a primary key — the production projection selects both, so the
    // fixture supplies both.
    asset_objects: (options.assets ?? []).map((row, index) => ({
      bucket: "project-assets",
      id: `asset-${index + 1}`,
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
        reads.maybeSingle += 1;
        return { data: rows()[0] ?? null, error: null };
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
  };

  // The compare-and-write function now runs through `pg`: record the statement,
  // map its positional params back onto the function's parameter names, and answer
  // with the same verdicts the old stub produced.
  const sql: SqlExecutor = {
    query: async (text: string, values: unknown[] = []) => {
      const name = /select public\.(\w+)\(/.exec(text)?.[1] ?? "";
      const params = Object.fromEntries(
        RECORD_PARAM_NAMES.map((key, index) => [key, values[index]]),
      );
      rpcs.push({ name, params });
      if (options.rpcError) throw new Error(options.rpcError.message);

      const path = String(params.p_object_path ?? "");
      const verdict = options.rpcResults?.[path];
      if (verdict) return { rows: [{ result: verdict }] };

      // The happy path: the snapshot still matched, so the row was written.
      return {
        rows: [
          {
            result: {
              status: "applied",
              asset_id: `asset-${rpcs.length}`,
              workspace_id: TEAM,
              project_id: params.p_project_id ?? null,
            },
          },
        ],
      };
    },
  };

  return { client: client as unknown as AdminSupabaseClient, rpcs, writes, reads, sql };
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

    const report = await runProjectAssetBackfill(admin.client, { apply: false }, admin.sql);

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

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

    expect(report.recorded).toBe(1);
    expect(admin.rpcs).toHaveLength(1);
    expect(admin.rpcs[0]?.name).toBe("record_project_asset_if_matches");
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

    const report = await runProjectAssetBackfill(admin.client, { apply: false }, admin.sql);

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

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

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

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

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

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

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

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

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

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

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

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

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
      // Between planning and writing, a worker claimed the object for B. The
      // database is the one that notices — the tool no longer pre-reads the row,
      // so the verdict comes back from the locked compare-and-write call.
      rpcResults: {
        [JOB_OBJECT]: { status: "conflict", reason: "state_changed" },
      },
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

    expect(admin.rpcs).toHaveLength(1);
    expect(admin.rpcs[0]?.name).toBe("record_project_asset_if_matches");
    expect(report.recorded).toBe(0);
    expect(report.conflicts).toEqual([JOB_OBJECT]);
  });

  it("case 10b: a workspace-only change since planning is dropped too", async () => {
    // The object had no project at plan time, so the plan was to adopt it into
    // PROJECT_A. In between, somebody moved the SAME row to another workspace
    // while leaving project_id null. Comparing only the project would see
    // null === null and call the plan safe — and the write would then land the
    // planned workspace on top of the newer one. The whole ownership state is the
    // guard, not just the project, and it is compared under the row lock.
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      assets: [
        { object_path: JOB_OBJECT, project_id: null, workspace_id: TEAM, created_by: USER },
      ],
      objects: [JOB_OBJECT],
      rpcResults: {
        [JOB_OBJECT]: { status: "conflict", reason: "state_changed" },
      },
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

    expect(admin.rpcs).toHaveLength(1);
    expect(report.recorded).toBe(0);
    expect(report.conflicts).toEqual([JOB_OBJECT]);
  });

  it("case 10c: apply never pre-reads the row it is about to write", async () => {
    // The old guard was a `.maybeSingle()` read followed by a separate write. That
    // gap is the TOCTOU window T-20 exists to remove, so the read must be gone
    // even on the happy path.
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      objects: [JOB_OBJECT],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

    expect(admin.reads.maybeSingle).toBe(0);
    expect(admin.rpcs).toHaveLength(1);
    expect(report.recorded).toBe(1);
  });

  it("case 10d: the whole plan-time snapshot is sent, not just the project", async () => {
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      assets: [
        {
          id: "asset-existing",
          object_path: JOB_OBJECT,
          project_id: null,
          workspace_id: TEAM,
          created_by: USER,
          mime_type: "image/png",
          byte_size: 4096,
        },
      ],
      objects: [JOB_OBJECT],
    });

    await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

    expect(admin.rpcs).toHaveLength(1);
    expect(admin.rpcs[0]?.params).toMatchObject({
      p_expected_asset_id: "asset-existing",
      p_expected_workspace_id: TEAM,
      p_expected_project_id: null,
      p_expected_created_by: USER,
      p_expected_mime_type: "image/png",
      p_expected_byte_size: 4096,
    });
  });

  it("case 10e: a plan-time-missing row expects no asset id at all", async () => {
    // `null` asset id is how the RPC is told "I planned against nothing"; it is
    // what stops an object that appeared since from being adopted.
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      objects: [JOB_OBJECT],
    });

    await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

    expect(admin.rpcs[0]?.params).toMatchObject({
      p_expected_asset_id: null,
      p_expected_workspace_id: null,
      p_expected_project_id: null,
      p_expected_created_by: null,
      p_expected_mime_type: null,
      p_expected_byte_size: null,
    });
  });

  it("case 10f: a row that appeared since planning is a conflict, not an adoption", async () => {
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      objects: [JOB_OBJECT],
      rpcResults: {
        [JOB_OBJECT]: { status: "conflict", reason: "row_appeared" },
      },
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

    expect(report.recorded).toBe(0);
    expect(report.conflicts).toEqual([JOB_OBJECT]);
    expect(admin.rpcs).toHaveLength(1);
  });

  it("case 10g: an unknown RPC verdict is an error, not a silent success", async () => {
    const admin = makeAdmin({
      jobs: [job(JOB_OBJECT)],
      canvases: [{ id: CANVAS_A, project_id: PROJECT_A, content: {}, created_by: USER }],
      objects: [JOB_OBJECT],
      rpcResults: { [JOB_OBJECT]: { unexpected: true } },
    });

    await expect(runProjectAssetBackfill(admin.client, { apply: true }, admin.sql)).rejects.toThrow(
      /unexpected response/,
    );
  });

  it("case 11: an object nothing points at is left unmatched", async () => {
    const admin = makeAdmin({
      assets: [
        { object_path: "ws-team/orphan.png", project_id: null, workspace_id: TEAM, created_by: USER },
      ],
      objects: ["ws-team/orphan.png"],
    });

    const report = await runProjectAssetBackfill(admin.client, { apply: true }, admin.sql);

    expect(report.unmatched).toEqual(["ws-team/orphan.png"]);
    expect(admin.rpcs).toHaveLength(0);
  });

  it("case 12: defaults to a dry run", () => {
    expect(parseBackfillArgs([])).toEqual({ apply: false });
    expect(parseBackfillArgs(["--apply"])).toEqual({ apply: true });
  });
});
