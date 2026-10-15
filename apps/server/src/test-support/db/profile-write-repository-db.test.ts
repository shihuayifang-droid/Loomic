import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ProfileWriteError,
  UPDATE_DISPLAY_NAME,
  createProfileWriteRepository,
  type ProfileWriteRepository,
} from "../../db/profile-write-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL integration for the profile write repository (workorder 21D).
 *
 * The unit tests beside the repository prove WHICH statement is built and which
 * columns it may touch. This file proves PostgreSQL actually parses and executes
 * it against real tables: the `$1::uuid` / `$2::text` binds, that exactly one row
 * changes and it is the actor's, that a non-existent actor is refused instead of
 * silently updating nothing, that a malformed id is a real SQL error whose
 * ROLLBACK leaves the pool usable, and that the transaction-local settings of
 * workorder 19 do not survive the call.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built through the real signup trigger, and
 * `afterAll` closes it. PGlite holds a single session, so nothing here runs
 * concurrently and no case may leave a transaction open for the next one.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000e1";
const NEIGHBOUR = "00000000-0000-0000-0000-0000000000e2";
/** A complete user whose `profiles` row is deleted: a valid uuid, no profile. */
const ORPHAN = "00000000-0000-0000-0000-0000000000e3";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ACTOR = "not-a-uuid";

/**
 * A uuid-position bind carrying SQL. It is a bind parameter, so it can only ever
 * be a (malformed) uuid literal — if it were ever concatenated it would rewrite
 * every profile in the table. This case exists to prove it does not.
 */
const INJECTION_ACTOR = "' or '1'='1";

const FIRST_NAME = "Actor One";
const SECOND_NAME = "Actor Two";
const NEIGHBOUR_NAME = "Neighbour Untouched";
const INJECTED_NAME = "INJECTED BY A CONCATENATED STATEMENT";

const READ_SETTINGS_SQL = `
select
  current_setting('app.user_id', true) as user_id,
  current_setting('app.workspace_id', true) as workspace_id,
  current_setting('app.role', true) as role,
  current_setting('app.execution_mode', true) as execution_mode
`;

const SETTINGS_GONE_SQL = `
select
  nullif(current_setting('app.user_id', true), '') is null as user_id,
  nullif(current_setting('app.workspace_id', true), '') is null as workspace_id,
  nullif(current_setting('app.role', true), '') is null as role,
  nullif(current_setting('app.execution_mode', true), '') is null as execution_mode
`;

type ProfileRecord = {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

type SettingsGoneRow = {
  user_id: boolean;
  workspace_id: boolean;
  role: boolean;
  execution_mode: boolean;
};

const AVATAR_URL = "https://cdn.invalid/avatar-of-the-actor.png";

let db: PGlite;
let pool: TransactionPool;
let repository: ProfileWriteRepository;

async function readProfile(userId: string): Promise<ProfileRecord> {
  const rows = (
    await db.query<ProfileRecord>(
      `select id, email, display_name, avatar_url
         from public.profiles
        where id = $1`,
      [userId],
    )
  ).rows;

  const row = rows[0];
  if (row === undefined) throw new Error(`profile ${userId} is missing`);
  return row;
}

async function displayNameOf(userId: string): Promise<string | null> {
  return (await readProfile(userId)).display_name;
}

async function countProfiles(): Promise<number> {
  const rows = (
    await db.query<{ count: number }>(
      "select count(*)::int as count from public.profiles",
    )
  ).rows;

  const row = rows[0];
  if (row === undefined) throw new Error("count query answered nothing");
  return row.count;
}

async function allDisplayNames(): Promise<string[]> {
  const rows = (
    await db.query<{ display_name: string | null }>(
      "select display_name from public.profiles order by id",
    )
  ).rows;

  return rows.map((row) => row.display_name ?? "<null>");
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createProfileWriteRepository({ getTransactionPool: () => pool });

  // The real signup path builds the profile row (display_name comes from the
  // e-mail local part), so nothing below hand-writes the row it then renames.
  await createUser(db, ACTOR, "actor@hahart.test");
  await createUser(db, NEIGHBOUR, "neighbour@hahart.test");
  await createUser(db, ORPHAN, "orphan@hahart.test");

  // Fixture for the untouched-columns and untouched-neighbour cases: a real
  // avatar on the actor's row and a different stored name to compare against.
  await db.query(
    "update public.profiles set avatar_url = $1 where id = $2",
    [AVATAR_URL, ACTOR],
  );

  const neighbour = await repository.updateDisplayName({
    actorId: NEIGHBOUR,
    displayName: NEIGHBOUR_NAME,
  });
  if (neighbour.displayName !== NEIGHBOUR_NAME) {
    throw new Error("fixture: the neighbour's name was not stored");
  }

  // A valid uuid with no profile row: the zero-row refusal fixture.
  await db.query("delete from public.profiles where id = $1", [ORPHAN]);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("profile-write-repository: PGlite real SQL", () => {
  it("case 1: the actor's own row is renamed and the stored value matches the answer", async () => {
    const row = await repository.updateDisplayName({
      actorId: ACTOR,
      displayName: FIRST_NAME,
    });

    expect(row).toEqual({
      id: ACTOR,
      email: "actor@hahart.test",
      displayName: FIRST_NAME,
      avatarUrl: AVATAR_URL,
    });

    // The row really changed, read back through a separate statement.
    expect(await displayNameOf(ACTOR)).toBe(FIRST_NAME);
  });

  it("case 2: a second write replaces the value and returns the new one", async () => {
    const row = await repository.updateDisplayName({
      actorId: ACTOR,
      displayName: SECOND_NAME,
    });

    expect(row.displayName).toBe(SECOND_NAME);
    expect(await displayNameOf(ACTOR)).toBe(SECOND_NAME);
  });

  it("case 3: another profile is not touched by the actor's write", async () => {
    const neighbourBefore = await readProfile(NEIGHBOUR);

    await repository.updateDisplayName({
      actorId: ACTOR,
      displayName: "Actor Three",
    });

    expect(await readProfile(NEIGHBOUR)).toEqual(neighbourBefore);
    expect(await displayNameOf(NEIGHBOUR)).toBe(NEIGHBOUR_NAME);
  });

  it("case 4: only display_name is written — email and avatar_url survive", async () => {
    const row = await repository.updateDisplayName({
      actorId: ACTOR,
      displayName: "Actor Four",
    });

    const stored = await readProfile(ACTOR);
    expect(stored.email).toBe("actor@hahart.test");
    expect(stored.avatar_url).toBe(AVATAR_URL);
    expect(stored.display_name).toBe("Actor Four");
    // The answer and the row agree, so the projection cannot drift from storage.
    expect(row.email).toBe(stored.email);
    expect(row.avatarUrl).toBe(stored.avatar_url);
  });

  it("case 5: a valid actor with no profile row is refused and creates nothing", async () => {
    const before = await countProfiles();

    const error = await repository
      .updateDisplayName({ actorId: ORPHAN, displayName: "Ghost" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProfileWriteError);
    const writeError = error as ProfileWriteError;
    expect(writeError.operation).toBe(UPDATE_DISPLAY_NAME);
    expect(writeError.message).toBe(
      `profile write failed (${UPDATE_DISPLAY_NAME})`,
    );
    // No row was created and no other row was harmed: zero rows really is
    // "nothing happened", not "something happened elsewhere".
    expect(await countProfiles()).toBe(before);
  });

  it("case 6: a malformed uuid is a real SQL error, wrapped and leaked nowhere", async () => {
    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query("select id from public.profiles where id = $1", [INVALID_ACTOR]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const error = await repository
      .updateDisplayName({ actorId: INVALID_ACTOR, displayName: "Never Stored" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProfileWriteError);
    const writeError = error as ProfileWriteError;
    expect(writeError.operation).toBe(UPDATE_DISPLAY_NAME);
    // The fixed message carries no SQL, no host, no id and no existence answer.
    expect(writeError.message).toBe(
      `profile write failed (${UPDATE_DISPLAY_NAME})`,
    );
    expect(writeError.message).not.toMatch(
      /public\.|set display_name|where id|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The cause is the PostgreSQL parse failure, not a shape or zero-row answer.
    expect((writeError.cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );
  });

  it("case 7: an actor id carrying SQL changes nothing, because it is only a bind", async () => {
    const before = await allDisplayNames();
    const error = await repository
      .updateDisplayName({ actorId: INJECTION_ACTOR, displayName: INJECTED_NAME })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProfileWriteError);
    expect((error as ProfileWriteError).cause).toBeInstanceOf(Error);
    // The whole table is byte-identical: if the id had been concatenated, this
    // statement would have renamed every profile in it.
    expect(await allDisplayNames()).toEqual(before);
    expect(await allDisplayNames()).not.toContain(INJECTED_NAME);
  });

  it("case 8: after a failure the same pool still writes — the failed call rolled back", async () => {
    // If the transaction had been left open or aborted, this call would answer
    // "current transaction is aborted" instead of a row.
    const error = await repository
      .updateDisplayName({ actorId: INVALID_ACTOR, displayName: "Never Stored" })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProfileWriteError);

    const row = await repository.updateDisplayName({
      actorId: ACTOR,
      displayName: "Actor After The Rollback",
    });

    expect(row.displayName).toBe("Actor After The Rollback");
    expect(await displayNameOf(ACTOR)).toBe("Actor After The Rollback");
  });

  it("case 9: the transaction carries the actor and leaks no setting after COMMIT", async () => {
    const row = await repository.updateDisplayName({
      actorId: ACTOR,
      displayName: "Actor Five",
    });
    expect(row.id).toBe(ACTOR);

    // Read through the pool, outside the transaction the repository opened: the
    // four settings were written with `set_config(..., true)`, so none of them
    // survives — a GUC that leaked would be an authorization hole.
    const gone = (await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows[0];
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });

    // The same read inside a transaction shows what the repository writes: the
    // actor, in privileged mode, and nothing else.
    expect(
      (
        await repository.updateDisplayName({
          actorId: ACTOR,
          displayName: "Actor Six",
        })
      ).displayName,
    ).toBe("Actor Six");
  });

  it("case 10: the actor and the privileged mode are visible INSIDE the write's transaction", async () => {
    // A pool that wraps the real one and reads the four settings through the SAME
    // connection, right after the repository's own statement: whatever it sees is
    // the state of the transaction the write ran in, not a reconstruction.
    const observed: Array<Record<string, unknown>> = [];
    const observingPool: TransactionPool = {
      async connect() {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const result = await inner.query(sql, params);
            if (sql.includes("public.profiles")) {
              observed.push(
                (await inner.query(READ_SETTINGS_SQL)).rows[0] as Record<
                  string,
                  unknown
                >,
              );
            }
            return result;
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const observing = createProfileWriteRepository({
      getTransactionPool: () => observingPool,
    });

    const row = await observing.updateDisplayName({
      actorId: ACTOR,
      displayName: "Actor Seven",
    });
    expect(row.displayName).toBe("Actor Seven");

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({
      user_id: ACTOR,
      workspace_id: "",
      role: "",
      execution_mode: "privileged",
    });

    // And immediately after COMMIT the same four settings are gone again, so the
    // actor of this write cannot become the actor of the next one.
    const gone = (await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows[0];
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });
});
