import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAgentRunWriteRepository } from "../../db/agent-run-write-repository.js";
import { createChatReadRepository } from "../../db/chat-read-repository.js";
import { createChatSessionWriteRepository } from "../../db/chat-session-write-repository.js";
import { createChatWriteRepository } from "../../db/chat-write-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import { createCanonicalDb, createCanonicalUser } from "./canonical-db.js";
import { createMigratedDb, createPGliteTransactionPool } from "./pglite-db.js";

/**
 * Ticket 43Q: canonical migration 0005 (chat sessions, chat messages, agent runs)
 * on an empty database. No Supabase stubs: only `apps/server/db/canonical/*.sql`.
 *
 * The comparison against the retired `supabase/migrations` chain
 * (`createMigratedDb()`) is the evidence that 0005 is the final form of that chain.
 */

const USER_A = "00000000-0000-0000-0000-0000000000f1";
const USER_GONE = "00000000-0000-0000-0000-0000000000f2";

const PROJECT_A = "aaaa0000-0000-4000-8000-0000000000f1";
const CANVAS_A = "bbbb0000-0000-4000-8000-0000000000f1";
const MESSAGE_1 = "cccc0000-0000-4000-8000-0000000000f1";
const RUN_1 = "dddd0000-0000-4000-8000-0000000000f1";
const THREAD_1 = "thread-43q-1";

const SQL_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/canonical/0005_chat_agent.sql",
);

const TABLE_LIST = "('chat_sessions', 'chat_messages', 'agent_runs')";

let db: PGlite;
let pool: TransactionPool;
let applied: string[] = [];

type ColumnShape = {
  table_name: string;
  ordinal_position: number;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

async function columnShapes(database: PGlite): Promise<ColumnShape[]> {
  const result = await database.query<ColumnShape>(
    `select table_name, ordinal_position, column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name in ${TABLE_LIST}
      order by table_name, ordinal_position`,
  );
  return result.rows;
}

/** Primary key, unique and check constraints by name and definition. */
async function constraintDefs(database: PGlite): Promise<string[]> {
  const result = await database.query<{ line: string }>(
    `select conrelid::regclass::text || ' ' || conname || ' :: ' || pg_get_constraintdef(oid) as line
       from pg_constraint
      where conrelid in ('public.chat_sessions'::regclass, 'public.chat_messages'::regclass, 'public.agent_runs'::regclass)
        and contype in ('p', 'u', 'c')
      order by 1`,
  );
  return result.rows.map((row) => row.line);
}

/** Foreign keys with the `on delete` action, as the catalogue spells them. */
async function foreignKeyActions(database: PGlite): Promise<string[]> {
  const result = await database.query<{ line: string }>(
    `select conrelid::regclass::text || ' ' || conname || ' :: ' || confdeltype::text || ' -> ' || confrelid::regclass::text as line
       from pg_constraint
      where conrelid in ('public.chat_sessions'::regclass, 'public.chat_messages'::regclass, 'public.agent_runs'::regclass)
        and contype = 'f'
      order by 1`,
  );
  return result.rows.map((row) => row.line);
}

async function indexDefs(database: PGlite): Promise<string[]> {
  const result = await database.query<{ indexdef: string }>(
    `select indexdef
       from pg_indexes
      where schemaname = 'public' and tablename in ${TABLE_LIST}
      order by indexname`,
  );
  return result.rows.map((row) => row.indexdef);
}

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

beforeAll(async () => {
  const created = await createCanonicalDb();
  db = created.db;
  applied = created.applied;
  pool = createPGliteTransactionPool(db);

  await createCanonicalUser(db, USER_A, "a@hahart.test");
  await createCanonicalUser(db, USER_GONE, "gone@hahart.test");

  const workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [USER_A],
      )
    ).rows,
  ).id;

  await db.query(
    `insert into public.projects (id, workspace_id, name, slug, description, created_by)
     values ($1, $2, 'Chat Project', 'chat-project', 'a project', $3)`,
    [PROJECT_A, workspaceId, USER_A],
  );
  await db.query(
    `insert into public.canvases (id, project_id, name, is_primary, created_by)
     values ($1, $2, 'Main canvas', true, $3)`,
    [CANVAS_A, PROJECT_A, USER_A],
  );
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("canonical 0005 chat: schema", () => {
  it("applies 0005_chat_agent.sql", () => {
    expect(applied).toContain("0005_chat_agent.sql");
  });

  it("creates the three tables", async () => {
    const result = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ${TABLE_LIST}
        order by table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "agent_runs",
      "chat_messages",
      "chat_sessions",
    ]);
  });

  it("points created_by at hahart_auth.users and not at auth.users", async () => {
    const result = await db.query<{ target: string }>(
      `select confrelid::regclass::text as target
         from pg_constraint
        where conrelid = 'public.chat_sessions'::regclass
          and conname = 'chat_sessions_created_by_fkey'`,
    );
    expect(result.rows).toEqual([{ target: "hahart_auth.users" }]);
  });

  it("deleting a hahart_auth user that created a session is refused (no action, as in the source)", async () => {
    await db.query(
      `insert into public.chat_sessions (canvas_id, title, created_by, thread_id)
       values ($1, 'Owned by a user that leaves', $2, 'thread-43q-gone')`,
      [CANVAS_A, USER_GONE],
    );
    await expect(
      db.query("delete from hahart_auth.users where id = $1", [USER_GONE]),
    ).rejects.toMatchObject({ code: "23503" });

    const stillThere = await db.query<{ created_by: string }>(
      "select created_by from public.chat_sessions where thread_id = 'thread-43q-gone'",
    );
    expect(stillThere.rows).toEqual([{ created_by: USER_GONE }]);
  });

  it("deleting a canvas cascades to its sessions, messages and runs", async () => {
    const canvasId = "bbbb0000-0000-4000-8000-0000000000f9";
    const sessionId = "eeee0000-0000-4000-8000-0000000000f9";
    await db.query(
      "insert into public.canvases (id, project_id, name, created_by) values ($1, $2, 'Throwaway', $3)",
      [canvasId, PROJECT_A, USER_A],
    );
    await db.query(
      "insert into public.chat_sessions (id, canvas_id, thread_id) values ($1, $2, 'thread-43q-cascade')",
      [sessionId, canvasId],
    );
    await db.query(
      "insert into public.chat_messages (session_id, role, content) values ($1, 'user', 'hi')",
      [sessionId],
    );
    await db.query(
      "insert into public.agent_runs (session_id, thread_id, status) values ($1, 'thread-43q-cascade', 'accepted')",
      [sessionId],
    );
    await db.query("delete from public.canvases where id = $1", [canvasId]);

    for (const table of ["chat_sessions", "chat_messages", "agent_runs"]) {
      const column = table === "chat_sessions" ? "id" : "session_id";
      const rows = await db.query<{ n: number }>(
        `select count(*)::int as n from public.${table} where ${column} = $1`,
        [sessionId],
      );
      expect(firstRow(rows.rows).n, table).toBe(0);
    }
  });

  it("updates updated_at through the trigger", async () => {
    const id = "eeee0000-0000-4000-8000-0000000000fa";
    await db.query(
      `insert into public.chat_sessions (id, canvas_id, thread_id, updated_at)
       values ($1, $2, 'thread-43q-trigger', '2000-01-01T00:00:00Z')`,
      [id, CANVAS_A],
    );
    await db.query("update public.chat_sessions set title = 'Renamed' where id = $1", [id]);
    const rows = await db.query<{ fresh: boolean }>(
      "select updated_at > '2001-01-01T00:00:00Z' as fresh from public.chat_sessions where id = $1",
      [id],
    );
    expect(rows.rows).toEqual([{ fresh: true }]);
  });
});

describe("canonical 0005 chat: repositories on the empty database", () => {
  it("creates a session, writes a message and reads both back", async () => {
    const sessions = createChatSessionWriteRepository({ getTransactionPool: () => pool });
    const messages = createChatWriteRepository({ getTransactionPool: () => pool });
    const reads = createChatReadRepository({ getTransactionPool: () => pool });

    const session = await sessions.createSession({
      actorId: USER_A,
      canvasId: CANVAS_A,
      threadId: THREAD_1,
      title: null,
      createdBy: USER_A,
    });
    expect(session.title).toBe("New Chat");

    const message = await messages.insertMessage({
      actorId: USER_A,
      messageId: MESSAGE_1,
      sessionId: session.id,
      role: "user",
      content: "hello canonical",
      toolActivities: null,
      contentBlocks: [{ type: "text", text: "hello canonical" }],
    });
    expect(message.id).toBe(MESSAGE_1);
    expect(message.content).toBe("hello canonical");

    const listed = await reads.listReadableSessions({ actorId: USER_A, canvasId: CANVAS_A });
    expect(listed?.map((row) => row.id)).toContain(session.id);

    const history = await reads.listReadableMessages({ actorId: USER_A, sessionId: session.id });
    expect(history).toHaveLength(1);
    expect(history?.[0]).toMatchObject({
      id: MESSAGE_1,
      role: "user",
      content: "hello canonical",
      content_blocks: [{ type: "text", text: "hello canonical" }],
    });

    const thread = await reads.findReadableSessionThread({
      actorId: USER_A,
      sessionId: session.id,
    });
    expect(thread).toEqual({ id: session.id, threadId: THREAD_1 });

    const touched = await messages.touchSession({
      actorId: USER_A,
      sessionId: session.id,
      updatedAt: "2030-01-01T00:00:00.000Z",
    });
    expect(touched.affectedRows).toBe(1);

    const renamed = await sessions.updateSessionTitle({
      actorId: USER_A,
      sessionId: session.id,
      title: "Renamed chat",
    });
    expect(renamed.affectedRows).toBe(1);
  });

  it("writes an agent run and reads it back", async () => {
    const reads = createChatReadRepository({ getTransactionPool: () => pool });
    const runs = createAgentRunWriteRepository({ getTransactionPool: () => pool });

    const thread = firstRow(
      (
        await db.query<{ id: string }>(
          "select id from public.chat_sessions where thread_id = $1",
          [THREAD_1],
        )
      ).rows,
    );
    expect(await reads.findReadableSessionThread({ actorId: USER_A, sessionId: thread.id })).not.toBeNull();

    await runs.createAcceptedRun({
      runId: RUN_1,
      sessionId: thread.id,
      threadId: THREAD_1,
      model: "model-43q",
    });
    await runs.updateRun({
      runId: RUN_1,
      status: "failed",
      completedAt: "2030-01-01T00:00:00.000Z",
      errorCode: "E43Q",
      errorMessage: "boom",
    });

    const row = firstRow(
      (
        await db.query<Record<string, unknown>>(
          "select session_id, thread_id, status, model, error_code, error_message, completed_at is not null as done from public.agent_runs where id = $1",
          [RUN_1],
        )
      ).rows,
    );
    expect(row).toMatchObject({
      session_id: thread.id,
      thread_id: THREAD_1,
      status: "failed",
      model: "model-43q",
      error_code: "E43Q",
      error_message: "boom",
      done: true,
    });
  });
});

describe("canonical 0005 chat: final form equals the retired migration chain", () => {
  let oldDb: PGlite;

  beforeAll(async () => {
    oldDb = (await createMigratedDb()).db;
  }, 240_000);

  afterAll(async () => {
    await oldDb.close();
  });

  it("has the same columns (position, name, type, nullability, default) on all three tables", async () => {
    const oldShapes = await columnShapes(oldDb);
    expect(oldShapes.length).toBeGreaterThan(0);
    expect(await columnShapes(db)).toEqual(oldShapes);
  });

  it("has the same primary key, unique and check constraints", async () => {
    const oldDefs = await constraintDefs(oldDb);
    expect(oldDefs.length).toBeGreaterThan(0);
    expect(await constraintDefs(db)).toEqual(oldDefs);
  });

  it("has the same foreign keys and on delete actions", async () => {
    const oldDefs = await foreignKeyActions(oldDb);
    expect(oldDefs.length).toBeGreaterThan(0);
    const newDefs = await foreignKeyActions(db);
    // Only the created_by target differs by design: auth.users -> hahart_auth.users.
    const normalize = (lines: string[]) =>
      lines.map((line) => line.replace("hahart_auth.users", "auth.users"));
    expect(normalize(newDefs)).toEqual(normalize(oldDefs));
  });

  it("has the same indexes", async () => {
    const oldDefs = await indexDefs(oldDb);
    expect(oldDefs.length).toBeGreaterThan(0);
    expect(await indexDefs(db)).toEqual(oldDefs);
  });
});

describe("canonical 0005 chat: SQL file hygiene", () => {
  const sql = readFileSync(SQL_FILE, "utf8");
  const lower = sql.toLowerCase();

  it("is at most 400 lines", () => {
    expect(sql.split("\n").length).toBeLessThanOrEqual(400);
  });

  it("carries no Supabase-only constructs", () => {
    const withoutOwnSchema = lower.replaceAll("hahart_auth.", "");
    for (const banned of [
      "auth.",
      "storage.",
      "pgmq",
      "auth.uid",
      "row level security",
      "create policy",
      "grant ",
      "anon",
      "authenticated",
      "service_role",
    ]) {
      expect(withoutOwnSchema.includes(banned), banned).toBe(false);
    }
  });
});
