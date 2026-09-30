/**
 * HaHart team bootstrap CLI (AD-08 §1).
 *
 * Usage:
 *   node --env-file=../../.env.local --import tsx src/cli/hahart-team-init.ts \
 *     --owner-email <email> [--members a@x,b@y] [--migrate]
 *
 * Creates the single team workspace (idempotent), adds the listed members, and
 * optionally migrates existing team members' personal projects into it.
 *
 * Only the report JSON is printed — never environment variables, URLs or keys.
 * Exit code 0 = all good, 1 = some member emails were not found, 2 = owner not
 * found or an RPC failed.
 */
import { pathToFileURL } from "node:url";

import type { AdminSupabaseClient } from "../supabase/admin.js";
import { createAdminSupabaseClient } from "../supabase/admin.js";
import { loadServerEnv } from "../config/env.js";

const TEAM_NAME = "HaHart 团队";

export type TeamInitReport = {
  teamWorkspaceId: string;
  membersAdded: string[];
  membersAlreadyIn: string[];
  membersNotFound: string[];
  migration: Record<string, number> | null;
};

export type TeamInitOptions = {
  ownerEmail: string;
  memberEmails: string[];
  migrate: boolean;
};

export function parseTeamInitArgs(argv: string[]): TeamInitOptions {
  let ownerEmail = "";
  let memberEmails: string[] = [];
  let migrate = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--owner-email") {
      ownerEmail = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--members") {
      memberEmails = (argv[index + 1] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
      index += 1;
    } else if (arg === "--migrate") {
      migrate = true;
    }
  }

  if (!ownerEmail) {
    throw new Error("--owner-email is required");
  }

  return { ownerEmail, memberEmails, migrate };
}

async function findProfileId(
  admin: AdminSupabaseClient,
  email: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email.trim())
    .maybeSingle();

  if (error) {
    throw new Error(`profile lookup failed (${error.code ?? "no_code"})`);
  }

  return data?.id ?? null;
}

export async function runTeamInit(
  admin: AdminSupabaseClient,
  options: TeamInitOptions,
): Promise<TeamInitReport> {
  const ownerId = await findProfileId(admin, options.ownerEmail);

  if (!ownerId) {
    throw new Error("owner not found");
  }

  const { data: teamWorkspaceId, error: teamError } = await admin.rpc(
    "ensure_team_workspace",
    { p_owner_user_id: ownerId, p_name: TEAM_NAME },
  );

  if (teamError || !teamWorkspaceId) {
    throw new Error(`ensure_team_workspace failed (${teamError?.code ?? "no_code"})`);
  }

  const membersAdded: string[] = [];
  const membersAlreadyIn: string[] = [];
  const membersNotFound: string[] = [];

  for (const email of options.memberEmails) {
    const memberId = await findProfileId(admin, email);

    if (!memberId) {
      membersNotFound.push(email);
      continue;
    }

    const { data: added, error: addError } = await admin.rpc("add_team_member", {
      p_user_id: memberId,
      p_role: "member",
    });

    if (addError) {
      throw new Error(`add_team_member failed (${addError.code ?? "no_code"})`);
    }

    if (added) {
      membersAdded.push(email);
    } else {
      membersAlreadyIn.push(email);
    }
  }

  let migration: Record<string, number> | null = null;

  if (options.migrate) {
    const { data, error } = await admin.rpc("migrate_personal_projects_to_team");

    if (error) {
      throw new Error(`migrate_personal_projects_to_team failed (${error.code ?? "no_code"})`);
    }

    migration = (data ?? {}) as Record<string, number>;
  }

  return {
    teamWorkspaceId,
    membersAdded,
    membersAlreadyIn,
    membersNotFound,
    migration,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: TeamInitOptions;

  try {
    options = parseTeamInitArgs(argv);
  } catch (error) {
    process.stderr.write(
      `team init failed: ${error instanceof Error ? error.message : "bad arguments"}\n`,
    );
    return 2;
  }

  try {
    const admin = createAdminSupabaseClient(loadServerEnv());
    const report = await runTeamInit(admin, options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.membersNotFound.length > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      `team init failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    return 2;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
