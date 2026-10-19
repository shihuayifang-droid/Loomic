import type {
  SkillFileRow,
  WorkspaceSkillReadRepository,
  WorkspaceSkillRow,
} from "../db/workspace-skill-read-repository.js";

/**
 * A file bundled with a skill (scripts/, references/, assets/).
 */
export interface SkillFileEntry {
  /** Relative path, e.g. "scripts/analyze.py" */
  path: string;
  /** Raw file content */
  content: string;
}

/**
 * Metadata for a workspace skill loaded from the database.
 * Compatible with the deepagents SkillsMiddleware SkillMetadata shape.
 */
export interface WorkspaceSkillEntry {
  /** Skill slug (used as directory name in virtual path) */
  name: string;
  /** Human-readable description for the system prompt */
  description: string;
  /** Virtual path where the agent can read_file the full SKILL.md content */
  path: string;
  /** Raw SKILL.md content stored in the database */
  content: string;
  /** Associated files (scripts, references, assets) */
  files: SkillFileEntry[];
}

/**
 * Load enabled skills (both system and user-created) for a given workspace.
 *
 * The workspace id is resolved by the caller from the canvas → project link
 * (workorder 21R): that read is an ACL decision and belongs in the canvas
 * repository, not here. This function only fetches the skills installed and
 * enabled in the workspace it is handed, and only returns those with non-empty
 * `skill_content`.
 *
 * Workorder 21AC moved both reads to `WorkspaceSkillReadRepository`, asked with
 * the run's own `userId`. That repository translates `ws_skills_select`,
 * `skills_select_all` and `skill_files_select` into its statements, so the two
 * questions that mattered before still hold:
 *
 * - a non-member of the workspace loads NO skills;
 * - another member's private user skill stays invisible even when its install is
 *   enabled — which is why the two lists can disagree with the install count.
 *
 * Both reads degrade instead of throwing, exactly as the PostgREST reads did:
 *
 * - the skill read failing or answering nothing is an empty list (the run simply
 *   has no workspace skills);
 * - the FILE read failing leaves every skill in place with no files, because the
 *   old code read `data` and ignored `error` there.
 *
 * The actor is passed separately from the workspace on purpose: membership and
 * skill ownership are two different questions and neither may be derived from
 * the other.
 */
export async function loadWorkspaceSkills(input: {
  repository: WorkspaceSkillReadRepository;
  actorId: string;
  workspaceId: string;
}): Promise<WorkspaceSkillEntry[]> {
  const { repository, actorId, workspaceId } = input;
  if (!workspaceId) return [];

  let rows: WorkspaceSkillRow[];
  try {
    rows = await repository.listEnabledWorkspaceSkills({ actorId, workspaceId });
  } catch {
    // Non-fatal: the agent runs without workspace skills.
    return [];
  }

  if (rows.length === 0) return [];

  // Batch-load associated files for all enabled skills. A failed read leaves the
  // skills themselves intact — see the header.
  const skillIds = rows.map((row) => row.id);

  let fileRows: SkillFileRow[] = [];
  try {
    fileRows = await repository.listSkillFiles({ actorId, skillIds });
  } catch {
    fileRows = [];
  }

  const filesBySkillId = new Map<string, SkillFileEntry[]>();
  for (const file of fileRows) {
    const existing = filesBySkillId.get(file.skill_id) ?? [];
    existing.push({ path: file.file_path, content: file.content });
    filesBySkillId.set(file.skill_id, existing);
  }

  // Map to WorkspaceSkillEntry, filtering out skills without DB content.
  const entries: WorkspaceSkillEntry[] = [];
  for (const skill of rows) {
    if (!skill.skill_content) {
      console.warn(
        `[workspace-skills] Skill "${skill.slug}" is enabled but has empty content — skipping`,
      );
      continue;
    }

    entries.push({
      name: skill.slug,
      description: skill.description,
      path: `/workspace-skills/${skill.slug}/SKILL.md`,
      content: skill.skill_content,
      files: filesBySkillId.get(skill.id) ?? [],
    });
  }

  return entries;
}
