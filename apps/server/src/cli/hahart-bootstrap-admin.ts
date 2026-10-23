/**
 * First-administrator bootstrap CLI (OP-04 / AD-08) for a fresh canonical database.
 *
 * Usage:
 *   HAHART_BOOTSTRAP_ADMIN_PASSWORD=<password> \
 *   node --env-file-if-exists=../../.env.local --import tsx \
 *     src/cli/hahart-bootstrap-admin.ts --email <email> [--name <display name>]
 *
 * Reads `DATABASE_URL`. Creates the administrator account (argon2id password,
 * status `active`) when the email is new, then makes sure the personal
 * workspace and the single team workspace exist. Re-running with the same email
 * never changes the password. The password is read from the environment only
 * and is never printed.
 *
 * Exit code 0 = done, 1 = runtime failure, 2 = bad arguments.
 */
import { pathToFileURL } from "node:url";

import { hashPassword, validatePasswordPolicy } from "../auth/password.js";
import {
  createUser,
  findUserByEmail,
  setUserStatus,
} from "../db/auth-repository.js";
import { createDatabasePool } from "../db/pool.js";
import {
  type TransactionPool,
  withPrivilegedTransaction,
} from "../db/transaction.js";

const TEAM_NAME = "HaHart 团队";
const PASSWORD_ENV_KEY = "HAHART_BOOTSTRAP_ADMIN_PASSWORD";

export type BootstrapAdminArgs = { email: string; displayName?: string };

export type BootstrapAdminInput = {
  email: string;
  displayName?: string;
  password: string | undefined;
};

export type BootstrapAdminResult = {
  userId: string;
  created: boolean;
  teamWorkspaceId: string;
};

export function parseBootstrapAdminArgs(argv: string[]): BootstrapAdminArgs {
  let email = "";
  let displayName: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--email") {
      email = (argv[index + 1] ?? "").trim();
      index += 1;
    } else if (arg === "--name") {
      const value = (argv[index + 1] ?? "").trim();
      displayName = value === "" ? undefined : value;
      index += 1;
    }
  }

  if (!email) {
    throw new Error("--email is required");
  }

  return displayName === undefined ? { email } : { email, displayName };
}

export async function runBootstrapAdmin(
  pool: TransactionPool,
  input: BootstrapAdminInput,
): Promise<BootstrapAdminResult> {
  let userId: string;
  let created = false;

  const existing = await findUserByEmail(pool, input.email);

  if (existing) {
    userId = existing.id;
    if (existing.status !== "active") {
      await setUserStatus(pool, userId, "active");
    }
  } else {
    if (!input.password) {
      throw new Error(
        `${PASSWORD_ENV_KEY} is required to create the first administrator`,
      );
    }

    const policy = validatePasswordPolicy(input.password);
    if (!policy.ok) {
      throw new Error(`password does not meet the policy (${policy.reason})`);
    }

    const passwordHash = await hashPassword(input.password);
    const result = await createUser(pool, {
      email: input.email,
      displayName: input.displayName ?? null,
      passwordHash,
    });

    if ("conflict" in result) {
      throw new Error("administrator email already exists");
    }

    userId = result.id;
    await setUserStatus(pool, userId, "active");
    created = true;
  }

  const teamWorkspaceId = await withPrivilegedTransaction(
    pool,
    null,
    async (client) => {
      await client.query("select public.bootstrap_viewer($1, $2, '{}'::jsonb)", [
        userId,
        input.email,
      ]);
      const team = await client.query(
        "select public.ensure_team_workspace($1, $2) as id",
        [userId, TEAM_NAME],
      );
      const row = team.rows[0] as { id?: unknown } | undefined;
      if (typeof row?.id !== "string") {
        throw new Error("ensure_team_workspace returned no workspace id");
      }
      return row.id;
    },
  );

  return { userId, created, teamWorkspaceId };
}

export type BootstrapAdminDeps = {
  createPool?: (databaseUrl: string) => TransactionPool & {
    end(): Promise<void>;
  };
};

function defaultCreatePool(
  databaseUrl: string,
): TransactionPool & { end(): Promise<void> } {
  const pool = createDatabasePool(databaseUrl);
  return {
    connect: async () => pool.connect(),
    end: () => pool.end(),
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: BootstrapAdminDeps = {},
): Promise<number> {
  let args: BootstrapAdminArgs;

  try {
    args = parseBootstrapAdminArgs(argv);
  } catch (error) {
    process.stderr.write(
      `bootstrap admin failed: ${error instanceof Error ? error.message : "bad arguments"}\n`,
    );
    return 2;
  }

  const databaseUrl = env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    process.stderr.write("DATABASE_URL is required\n");
    return 1;
  }

  const pool = (deps.createPool ?? defaultCreatePool)(databaseUrl);

  try {
    const result = await runBootstrapAdmin(pool, {
      email: args.email,
      ...(args.displayName === undefined ? {} : { displayName: args.displayName }),
      password: env[PASSWORD_ENV_KEY],
    });
    process.stdout.write(
      `admin=${args.email} created=${result.created} team=${result.teamWorkspaceId}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `bootstrap admin failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    return 1;
  } finally {
    await pool.end();
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
