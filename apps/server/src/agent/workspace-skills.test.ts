import { describe, expect, it, vi } from "vitest";

import type {
  SkillFileRow,
  WorkspaceSkillReadRepository,
  WorkspaceSkillRow,
} from "../db/workspace-skill-read-repository.js";
import { loadWorkspaceSkills } from "./workspace-skills.js";

/**
 * 工单21AC: `loadWorkspaceSkills` reads through `WorkspaceSkillReadRepository`
 * now, with the run's own actor. Both reads used to be PostgREST reads whose
 * errors were swallowed, and the swallowing is part of the contract — a failed
 * skill read must not fail the run, and a failed FILE read must not lose the
 * skills.
 *
 * The cases below therefore pin four behaviours, each of which was true before
 * the migration and must still be true after it:
 *
 *   1. a failed skill read degrades to `[]`;
 *   2. a failed file read keeps every skill and gives it no files;
 *   3. a skill with empty content is skipped and WARNED about;
 *   4. a normal load assembles skills and their files by `skill_id`.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000c1";
const SKILL_ONE = "00000000-0000-0000-0000-0000000000d1";
const SKILL_TWO = "00000000-0000-0000-0000-0000000000d2";
const SKILL_EMPTY = "00000000-0000-0000-0000-0000000000d3";

function skillRow(overrides: Partial<WorkspaceSkillRow>): WorkspaceSkillRow {
  return {
    id: SKILL_ONE,
    slug: "canvas-design",
    name: "Canvas Design",
    description: "Design on the canvas",
    skill_content: "# canvas-design\nDo the thing.",
    metadata: {},
    ...overrides,
  };
}

function fileRow(overrides: Partial<SkillFileRow>): SkillFileRow {
  return {
    skill_id: SKILL_ONE,
    file_path: "scripts/analyze.py",
    content: "print('hi')\n",
    ...overrides,
  };
}

type Harness = {
  repository: WorkspaceSkillReadRepository;
  skillAsks: () => Array<{ actorId: string; workspaceId: string }>;
  fileAsks: () => Array<{ actorId: string; skillIds: readonly string[] }>;
};

function makeHarness(
  options: {
    skills?: WorkspaceSkillRow[];
    files?: SkillFileRow[];
    skillsError?: Error;
    filesError?: Error;
  } = {},
): Harness {
  const skillAsks: Array<{ actorId: string; workspaceId: string }> = [];
  const fileAsks: Array<{ actorId: string; skillIds: readonly string[] }> = [];

  const repository = {
    async listEnabledWorkspaceSkills(input: {
      actorId: string;
      workspaceId: string;
    }): Promise<WorkspaceSkillRow[]> {
      skillAsks.push({ ...input });
      if (options.skillsError) throw options.skillsError;
      return options.skills ?? [];
    },
    async listSkillFiles(input: {
      actorId: string;
      skillIds: readonly string[];
    }): Promise<SkillFileRow[]> {
      fileAsks.push({ ...input, skillIds: [...input.skillIds] });
      if (options.filesError) throw options.filesError;
      return options.files ?? [];
    },
  } as unknown as WorkspaceSkillReadRepository;

  return {
    repository,
    skillAsks: () => skillAsks,
    fileAsks: () => fileAsks,
  };
}

describe("loadWorkspaceSkills: the happy path", () => {
  it("case 1: assembles every enabled skill, its files grouped by skill id, and asks with the run's actor", async () => {
    const harness = makeHarness({
      skills: [
        skillRow({}),
        skillRow({
          id: SKILL_TWO,
          slug: "data-viz",
          name: "Data Viz",
          description: "Charts",
          skill_content: "# data-viz\nPlot it.",
        }),
      ],
      files: [
        fileRow({}),
        fileRow({ skill_id: SKILL_ONE, file_path: "references/guide.md", content: "# guide\n" }),
        fileRow({
          skill_id: SKILL_TWO,
          file_path: "assets/palette.json",
          content: "{}",
        }),
      ],
    });

    const entries = await loadWorkspaceSkills({
      repository: harness.repository,
      actorId: ACTOR,
      workspaceId: WORKSPACE,
    });

    expect(entries).toEqual([
      {
        name: "canvas-design",
        description: "Design on the canvas",
        path: "/workspace-skills/canvas-design/SKILL.md",
        content: "# canvas-design\nDo the thing.",
        files: [
          { path: "scripts/analyze.py", content: "print('hi')\n" },
          { path: "references/guide.md", content: "# guide\n" },
        ],
      },
      {
        name: "data-viz",
        description: "Charts",
        path: "/workspace-skills/data-viz/SKILL.md",
        content: "# data-viz\nPlot it.",
        files: [{ path: "assets/palette.json", content: "{}" }],
      },
    ]);

    // The ACTOR and the workspace are two separate arguments to two separate
    // questions: membership never derives skill ownership.
    expect(harness.skillAsks()).toEqual([
      { actorId: ACTOR, workspaceId: WORKSPACE },
    ]);
    expect(harness.fileAsks()).toEqual([
      { actorId: ACTOR, skillIds: [SKILL_ONE, SKILL_TWO] },
    ]);
  });

  it("case 2: an empty workspace id answers `[]` without asking the repository at all", async () => {
    const harness = makeHarness();

    await expect(
      loadWorkspaceSkills({
        repository: harness.repository,
        actorId: ACTOR,
        workspaceId: "",
      }),
    ).resolves.toEqual([]);

    expect(harness.skillAsks()).toEqual([]);
    expect(harness.fileAsks()).toEqual([]);
  });
});

describe("loadWorkspaceSkills: the swallowed failures", () => {
  it("case 3: a failed skill read answers `[]` — the run continues without workspace skills", async () => {
    const harness = makeHarness({
      skillsError: new Error("workspace skill read failed (listEnabledWorkspaceSkills)"),
    });

    await expect(
      loadWorkspaceSkills({
        repository: harness.repository,
        actorId: ACTOR,
        workspaceId: WORKSPACE,
      }),
    ).resolves.toEqual([]);

    // No file read is attempted for a skill list that never arrived.
    expect(harness.fileAsks()).toEqual([]);
  });

  it("case 4: a failed FILE read keeps every skill and gives each one no files", async () => {
    const harness = makeHarness({
      skills: [skillRow({})],
      filesError: new Error("workspace skill read failed (listSkillFiles)"),
    });

    const entries = await loadWorkspaceSkills({
      repository: harness.repository,
      actorId: ACTOR,
      workspaceId: WORKSPACE,
    });

    expect(entries).toEqual([
      {
        name: "canvas-design",
        description: "Design on the canvas",
        path: "/workspace-skills/canvas-design/SKILL.md",
        content: "# canvas-design\nDo the thing.",
        files: [],
      },
    ]);
  });
});

describe("loadWorkspaceSkills: empty content is skipped, and it says so", () => {
  it("case 5: a skill with empty content is dropped with the original warning, the rest still load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const harness = makeHarness({
      skills: [
        skillRow({}),
        skillRow({
          id: SKILL_EMPTY,
          slug: "empty-skill",
          description: "No content",
          skill_content: null,
        }),
      ],
      files: [fileRow({ skill_id: SKILL_EMPTY, file_path: "scripts/x.py", content: "x" })],
    });

    const entries = await loadWorkspaceSkills({
      repository: harness.repository,
      actorId: ACTOR,
      workspaceId: WORKSPACE,
    });

    // Read the recorded calls BEFORE restoring: `mockRestore` also clears them.
    const warnings = warn.mock.calls.map((args) => args.map(String).join(" "));
    warn.mockRestore();

    // Only the skill WITH content survives.
    expect(entries.map((entry) => entry.name)).toEqual(["canvas-design"]);

    // The warning is the pre-migration text, naming the skill: a silently missing
    // skill is indistinguishable from a broken workspace.
    expect(warnings).toEqual([
      '[workspace-skills] Skill "empty-skill" is enabled but has empty content — skipping',
    ]);
  });

  it("case 6: no skill at all means no file read and no warnings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = makeHarness({ skills: [] });

    await expect(
      loadWorkspaceSkills({
        repository: harness.repository,
        actorId: ACTOR,
        workspaceId: WORKSPACE,
      }),
    ).resolves.toEqual([]);

    const warnings = warn.mock.calls.map((args) => args.map(String).join(" "));
    warn.mockRestore();

    expect(warnings).toEqual([]);
    expect(harness.fileAsks()).toEqual([]);
  });
});
