import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIND_READABLE_SESSION_THREAD,
  LIST_READABLE_MESSAGES,
  LIST_READABLE_SESSIONS,
  LIST_READABLE_SESSION_ASSETS,
  ChatReadError,
  createChatReadRepository,
  type ChatReadRepository,
} from "../../db/chat-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL ACL integration for the chat read repository (workorder 20D,
 * ADR-0001 migration step 2d).
 *
 * The unit tests beside the repository prove WHICH statement is built. This file
 * proves the statements enforce the ACL on a real PostgreSQL parser and planner:
 * the session → canvas → project → workspace_members walk, the
 * author/admin/owner clause, the archived filter, the `null` versus `[]` split
 * that only the readable-parent CTE + LEFT JOIN can express, both orderings, the
 * preserved null `thread_id`, the project-restricted `uuid[]` asset lookup, and
 * the rollback path after an illegal uuid.
 *
 * PGlite runs in-process, in-repo: no server, no socket, no `DATABASE_URL`, no
 * connection to any host. Its session is the database owner, which BYPASSES RLS
 * — that is exactly why every judge below reads through the repository. Where an
 * old RLS answer would differ, the case shows both and asserts the repository's
 * own SQL is the one that decides.
 *
 * Duplicate-row and unusable-row-shape detection is asserted in the unit test
 * file, against rows a primary key cannot produce; one shape a real table CAN
 * hold (a JSONB object where an array is promised) is exercised here as well.
 *
 * One instance is migrated in `beforeAll`, the fixture is built on real tables,
 * and `afterAll` closes it. PGlite holds a single session, so nothing here runs
 * concurrently and no case may leave a transaction open for the next one.
 */

const AUTHOR_ID = "00000000-0000-0000-0000-0000000000e1";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000e2";
const OWNER_ID = "00000000-0000-0000-0000-0000000000e3";
const MEMBER_ID = "00000000-0000-0000-0000-0000000000e4";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000000e5";

const ACTIVE_PROJECT = "aa110000-0000-4000-8000-000000000001";
const MEMBER_PROJECT = "aa110000-0000-4000-8000-000000000002";
const ARCHIVED_PROJECT = "aa110000-0000-4000-8000-000000000003";
const OUTSIDER_PROJECT = "aa110000-0000-4000-8000-000000000004";

const ACTIVE_CANVAS = "bb110000-0000-4000-8000-000000000001";
const SHAPE_CANVAS = "bb110000-0000-4000-8000-000000000002";
const EMPTY_CANVAS = "bb110000-0000-4000-8000-000000000003";
const MEMBER_CANVAS = "bb110000-0000-4000-8000-000000000004";
const ARCHIVED_CANVAS = "bb110000-0000-4000-8000-000000000005";
const OUTSIDER_CANVAS = "bb110000-0000-4000-8000-000000000006";
const MISSING_CANVAS = "bb110000-0000-4000-8000-00000000000f";

const SESSION_NEW = "cc110000-0000-4000-8000-000000000001";
const SESSION_OLD = "cc110000-0000-4000-8000-000000000002";
const SESSION_EMPTY = "cc110000-0000-4000-8000-000000000003";
const SESSION_SHAPE = "cc110000-0000-4000-8000-000000000004";
const SESSION_MEMBER = "cc110000-0000-4000-8000-000000000005";
const SESSION_ARCHIVED = "cc110000-0000-4000-8000-000000000006";
const SESSION_OUTSIDER = "cc110000-0000-4000-8000-000000000007";
const MISSING_SESSION = "cc110000-0000-4000-8000-00000000000f";

const MSG_EARLY = "dd110000-0000-4000-8000-000000000001";
const MSG_LATE = "dd110000-0000-4000-8000-000000000002";
const MSG_LEGACY = "dd110000-0000-4000-8000-000000000003";
const MSG_SHAPE = "dd110000-0000-4000-8000-000000000004";
const MSG_MEMBER = "dd110000-0000-4000-8000-000000000005";

const ASSET_MATCH = "ee110000-0000-4000-8000-000000000001";
const ASSET_SIBLING = "ee110000-0000-4000-8000-000000000002";
const ASSET_FOREIGN = "ee110000-0000-4000-8000-000000000003";
const ASSET_LEGACY = "ee110000-0000-4000-8000-000000000004";
const ASSET_ARCHIVED = "ee110000-0000-4000-8000-000000000005";
const ASSET_MISSING = "ee110000-0000-4000-8000-00000000000f";

const BUCKET = "project-assets";
const MATCH_PATH = "ws-team/active/pic.png";
const SIBLING_PATH = "ws-team/active/second.png";
const FOREIGN_PATH = "ws-team/member/pic.png";
const LEGACY_PATH = "ws-team/legacy/pic.png";
const ARCHIVED_PATH = "ws-team/archived/pic.png";
const TEAM_NAME = "HaHart Chat Team";
const ARCHIVED_AT = "2026-01-09T00:00:00.000Z";

const THREAD_ACTIVE = "thread_active";
const THREAD_MEMBER = "thread_member";
const THREAD_ARCHIVED = "thread_archived";
const THREAD_OUTSIDER = "thread_outsider";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

let db: PGlite;
let pool: TransactionPool;
let repository: ChatReadRepository;

/** Counts `connect()` calls, so "no SQL for an empty id list" is observable. */
let connectAttempts = 0;

let teamWorkspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function insertProject(options: {
  id: string;
  name: string;
  createdBy: string;
  archivedAt?: string;
}): Promise<void> {
  await db.query(
    `insert into public.projects (
       id, workspace_id, name, slug, description, created_by,
       archived_at, created_at, updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      options.id,
      teamWorkspaceId,
      options.name,
      options.id,
      `description of ${options.name}`,
      options.createdBy,
      options.archivedAt ?? null,
      "2026-01-01T00:00:00.000Z",
    ],
  );
}

async function insertCanvas(options: {
  id: string;
  projectId: string;
  name: string;
  createdBy: string;
  isPrimary: boolean;
}): Promise<void> {
  await db.query(
    `insert into public.canvases (id, project_id, name, is_primary, created_by, content, version)
     values ($1, $2, $3, $4, $5, '{"elements":[],"appState":{},"files":{}}'::jsonb, 1)`,
    [options.id, options.projectId, options.name, options.isPrimary, options.createdBy],
  );
}

async function insertSession(options: {
  id: string;
  canvasId: string;
  title: string;
  createdBy: string;
  updatedAt: string;
  threadId: string | null;
}): Promise<void> {
  await db.query(
    `insert into public.chat_sessions (
       id, canvas_id, title, created_by, created_at, updated_at, thread_id
     )
     values ($1, $2, $3, $4, $5, $5, $6)`,
    [
      options.id,
      options.canvasId,
      options.title,
      options.createdBy,
      options.updatedAt,
      options.threadId,
    ],
  );
}

async function insertMessage(options: {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
  toolActivities?: string | null;
  contentBlocks?: string | null;
}): Promise<void> {
  await db.query(
    `insert into public.chat_messages (
       id, session_id, role, content, tool_activities, content_blocks, created_at
     )
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      options.id,
      options.sessionId,
      options.role,
      options.content,
      options.toolActivities ?? null,
      options.contentBlocks ?? null,
      options.createdAt,
    ],
  );
}

async function insertAsset(options: {
  id: string;
  projectId: string | null;
  bucket: string;
  objectPath: string;
}): Promise<void> {
  await db.query(
    `insert into public.asset_objects (
       id, workspace_id, project_id, bucket, object_path, mime_type, byte_size, created_by
     )
     values ($1, $2, $3, $4, $5, 'image/png', 1234, $6)`,
    [
      options.id,
      teamWorkspaceId,
      options.projectId,
      options.bucket,
      options.objectPath,
      AUTHOR_ID,
    ],
  );
}

const BLOCKS = [{ type: "text", text: "hi" }];

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  // Real signup path for every identity: the auth.users trigger builds profile,
  // personal workspace and the owner membership.
  await createUser(db, AUTHOR_ID, "chat-author@hahart.test");
  await createUser(db, ADMIN_ID, "chat-admin@hahart.test");
  await createUser(db, OWNER_ID, "chat-owner@hahart.test");
  await createUser(db, MEMBER_ID, "chat-member@hahart.test");
  await createUser(db, OUTSIDER_ID, "chat-outsider@hahart.test");

  teamWorkspaceId = firstRow(
    (await db.query<{ id: string }>(
      `insert into public.workspaces (type, name, owner_user_id)
       values ('team', $1, $2)
       returning id`,
      [TEAM_NAME, OWNER_ID],
    )).rows,
  ).id;

  // AUTHOR is an ordinary member, ADMIN an admin, OWNER the owner. OUTSIDER is a
  // complete user with no team membership at all — and still owns a project with
  // a canvas, a session and messages below, so "not a member" is proven by the
  // SQL rather than by the absence of data.
  for (const [userId, role] of [
    [AUTHOR_ID, "member"],
    [ADMIN_ID, "admin"],
    [OWNER_ID, "owner"],
    [MEMBER_ID, "member"],
  ] as const) {
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, $3)`,
      [teamWorkspaceId, userId, role],
    );
  }

  await insertProject({ id: ACTIVE_PROJECT, name: "Active", createdBy: AUTHOR_ID });
  await insertProject({ id: MEMBER_PROJECT, name: "Member own", createdBy: MEMBER_ID });
  await insertProject({
    id: ARCHIVED_PROJECT,
    name: "Archived",
    createdBy: AUTHOR_ID,
    archivedAt: ARCHIVED_AT,
  });
  await insertProject({
    id: OUTSIDER_PROJECT,
    name: "Outsider own",
    createdBy: OUTSIDER_ID,
  });

  await insertCanvas({
    id: ACTIVE_CANVAS,
    projectId: ACTIVE_PROJECT,
    name: "Active canvas",
    createdBy: AUTHOR_ID,
    isPrimary: true,
  });
  // Two more canvases in the SAME project: one carrying the bad-shape message,
  // one deliberately holding no sessions at all.
  await insertCanvas({
    id: SHAPE_CANVAS,
    projectId: ACTIVE_PROJECT,
    name: "Shape canvas",
    createdBy: AUTHOR_ID,
    isPrimary: false,
  });
  await insertCanvas({
    id: EMPTY_CANVAS,
    projectId: ACTIVE_PROJECT,
    name: "Empty canvas",
    createdBy: AUTHOR_ID,
    isPrimary: false,
  });
  await insertCanvas({
    id: MEMBER_CANVAS,
    projectId: MEMBER_PROJECT,
    name: "Member canvas",
    createdBy: MEMBER_ID,
    isPrimary: true,
  });
  await insertCanvas({
    id: ARCHIVED_CANVAS,
    projectId: ARCHIVED_PROJECT,
    name: "Archived canvas",
    createdBy: AUTHOR_ID,
    isPrimary: true,
  });
  await insertCanvas({
    id: OUTSIDER_CANVAS,
    projectId: OUTSIDER_PROJECT,
    name: "Outsider canvas",
    createdBy: OUTSIDER_ID,
    isPrimary: true,
  });

  await insertSession({
    id: SESSION_OLD,
    canvasId: ACTIVE_CANVAS,
    title: "Older chat",
    createdBy: AUTHOR_ID,
    updatedAt: "2026-02-01T00:00:00.000Z",
    threadId: null,
  });
  await insertSession({
    id: SESSION_NEW,
    canvasId: ACTIVE_CANVAS,
    title: "Newest chat",
    createdBy: AUTHOR_ID,
    updatedAt: "2026-02-02T00:00:00.000Z",
    threadId: THREAD_ACTIVE,
  });
  await insertSession({
    id: SESSION_EMPTY,
    canvasId: ACTIVE_CANVAS,
    title: "No messages yet",
    createdBy: AUTHOR_ID,
    updatedAt: "2026-01-15T00:00:00.000Z",
    threadId: "thread_empty",
  });
  await insertSession({
    id: SESSION_SHAPE,
    canvasId: SHAPE_CANVAS,
    title: "Bad shape",
    createdBy: AUTHOR_ID,
    updatedAt: "2026-02-03T00:00:00.000Z",
    threadId: "thread_shape",
  });
  await insertSession({
    id: SESSION_MEMBER,
    canvasId: MEMBER_CANVAS,
    title: "Member chat",
    createdBy: MEMBER_ID,
    updatedAt: "2026-02-04T00:00:00.000Z",
    threadId: THREAD_MEMBER,
  });
  await insertSession({
    id: SESSION_ARCHIVED,
    canvasId: ARCHIVED_CANVAS,
    title: "Archived chat",
    createdBy: AUTHOR_ID,
    updatedAt: "2026-02-05T00:00:00.000Z",
    threadId: THREAD_ARCHIVED,
  });
  await insertSession({
    id: SESSION_OUTSIDER,
    canvasId: OUTSIDER_CANVAS,
    title: "Outsider chat",
    createdBy: OUTSIDER_ID,
    updatedAt: "2026-02-06T00:00:00.000Z",
    threadId: THREAD_OUTSIDER,
  });

  // Inserted newest-first so the ASC ordering has to come from the statement.
  await insertMessage({
    id: MSG_LATE,
    sessionId: SESSION_NEW,
    role: "assistant",
    content: "second",
    createdAt: "2026-03-02T00:00:00.000Z",
    toolActivities: JSON.stringify([{ name: "generate_image", status: "completed" }]),
    contentBlocks: JSON.stringify(BLOCKS),
  });
  await insertMessage({
    id: MSG_EARLY,
    sessionId: SESSION_NEW,
    role: "user",
    content: "first",
    createdAt: "2026-03-01T00:00:00.000Z",
    toolActivities: null,
    contentBlocks: JSON.stringify(BLOCKS),
  });
  // A pre-X-52 row: both jsonb columns are null, which the caller must be able to
  // synthesise legacy blocks from.
  await insertMessage({
    id: MSG_LEGACY,
    sessionId: SESSION_OLD,
    role: "user",
    content: "legacy text",
    createdAt: "2026-03-03T00:00:00.000Z",
  });
  // A JSONB object where the contract promises an array: a real row, and a real
  // shape failure for the mapper.
  await insertMessage({
    id: MSG_SHAPE,
    sessionId: SESSION_SHAPE,
    role: "assistant",
    content: "bad shape",
    createdAt: "2026-03-04T00:00:00.000Z",
    toolActivities: JSON.stringify({ name: "not-an-array" }),
  });
  await insertMessage({
    id: MSG_MEMBER,
    sessionId: SESSION_MEMBER,
    role: "user",
    content: "member hello",
    createdAt: "2026-03-05T00:00:00.000Z",
    contentBlocks: JSON.stringify(BLOCKS),
  });

  await insertAsset({
    id: ASSET_MATCH,
    projectId: ACTIVE_PROJECT,
    bucket: BUCKET,
    objectPath: MATCH_PATH,
  });
  await insertAsset({
    id: ASSET_SIBLING,
    projectId: ACTIVE_PROJECT,
    bucket: BUCKET,
    objectPath: SIBLING_PATH,
  });
  await insertAsset({
    id: ASSET_FOREIGN,
    projectId: MEMBER_PROJECT,
    bucket: BUCKET,
    objectPath: FOREIGN_PATH,
  });
  await insertAsset({
    id: ASSET_LEGACY,
    projectId: null,
    bucket: BUCKET,
    objectPath: LEGACY_PATH,
  });
  await insertAsset({
    id: ASSET_ARCHIVED,
    projectId: ARCHIVED_PROJECT,
    bucket: BUCKET,
    objectPath: ARCHIVED_PATH,
  });

  const pglitePool = createPGliteTransactionPool(db);
  connectAttempts = 0;
  pool = {
    async connect() {
      connectAttempts += 1;
      return pglitePool.connect();
    },
  };
  repository = createChatReadRepository({ getTransactionPool: () => pool });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("chat-read-repository: PGlite real SQL ACL", () => {
  it("case 1: the author reads their own canvas's sessions, most recently updated first", async () => {
    const sessions = await repository.listReadableSessions({
      actorId: AUTHOR_ID,
      canvasId: ACTIVE_CANVAS,
    });

    expect(sessions?.map((row) => row.id)).toEqual([
      SESSION_NEW,
      SESSION_OLD,
      SESSION_EMPTY,
    ]);
    expect(sessions?.[0]).toEqual({
      id: SESSION_NEW,
      title: "Newest chat",
      updated_at: "2026-02-02T00:00:00.000Z",
    });

    // The rows really are in the table, in the order the fixture inserted them.
    const stored = await db.query<{ id: string }>(
      `select id from public.chat_sessions where canvas_id = $1 order by updated_at desc`,
      [ACTIVE_CANVAS],
    );
    expect(stored.rows.map((row) => row.id)).toEqual([
      SESSION_NEW,
      SESSION_OLD,
      SESSION_EMPTY,
    ]);
  });

  it("case 2: admin and owner read a member's canvas sessions; a plain member and a non-member do not", async () => {
    for (const actor of [ADMIN_ID, OWNER_ID]) {
      const sessions = await repository.listReadableSessions({
        actorId: actor,
        canvasId: MEMBER_CANVAS,
      });
      expect(sessions?.map((row) => row.id)).toEqual([SESSION_MEMBER]);
    }

    await expect(
      repository.listReadableSessions({
        actorId: MEMBER_ID,
        canvasId: ACTIVE_CANVAS,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.listReadableSessions({
        actorId: OUTSIDER_ID,
        canvasId: ACTIVE_CANVAS,
      }),
    ).resolves.toBeNull();
  });

  it("case 3: an archived project's canvas and a missing canvas are both null", async () => {
    await expect(
      repository.listReadableSessions({
        actorId: AUTHOR_ID,
        canvasId: ARCHIVED_CANVAS,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.listReadableSessions({
        actorId: AUTHOR_ID,
        canvasId: MISSING_CANVAS,
      }),
    ).resolves.toBeNull();
  });

  it("case 4: a readable canvas with no sessions is [], a missing canvas is null", async () => {
    const sessions = await repository.listReadableSessions({
      actorId: AUTHOR_ID,
      canvasId: EMPTY_CANVAS,
    });

    expect(sessions).toEqual([]);

    // Proof the canvas really exists and really has no sessions, so `[]` is the
    // CTE's readable-parent answer rather than an accident of missing data.
    const stored = await db.query<{ id: string }>(
      `select id from public.canvases where id = $1`,
      [EMPTY_CANVAS],
    );
    expect(stored.rows).toHaveLength(1);

    await expect(
      repository.listReadableSessions({
        actorId: AUTHOR_ID,
        canvasId: MISSING_CANVAS,
      }),
    ).resolves.toBeNull();
  });

  it("case 5: messages come back oldest first with the real jsonb columns", async () => {
    const messages = await repository.listReadableMessages({
      actorId: AUTHOR_ID,
      sessionId: SESSION_NEW,
    });

    expect(messages?.map((row) => row.id)).toEqual([MSG_EARLY, MSG_LATE]);
    expect(messages?.[0]).toEqual({
      id: MSG_EARLY,
      role: "user",
      content: "first",
      tool_activities: null,
      content_blocks: BLOCKS,
      created_at: "2026-03-01T00:00:00.000Z",
    });
    expect(messages?.[1]?.tool_activities).toEqual([
      { name: "generate_image", status: "completed" },
    ]);

    // A pre-X-52 row keeps both columns null, which is what the caller's legacy
    // block synthesis reads.
    const legacy = await repository.listReadableMessages({
      actorId: AUTHOR_ID,
      sessionId: SESSION_OLD,
    });
    expect(legacy).toEqual([
      {
        id: MSG_LEGACY,
        role: "user",
        content: "legacy text",
        tool_activities: null,
        content_blocks: null,
        created_at: "2026-03-03T00:00:00.000Z",
      },
    ]);
  });

  it("case 6: a readable session with no messages is [], an unreadable or missing session is null", async () => {
    await expect(
      repository.listReadableMessages({
        actorId: AUTHOR_ID,
        sessionId: SESSION_EMPTY,
      }),
    ).resolves.toEqual([]);

    await expect(
      repository.listReadableMessages({
        actorId: OUTSIDER_ID,
        sessionId: SESSION_NEW,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.listReadableMessages({
        actorId: AUTHOR_ID,
        sessionId: SESSION_ARCHIVED,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.listReadableMessages({
        actorId: AUTHOR_ID,
        sessionId: MISSING_SESSION,
      }),
    ).resolves.toBeNull();
  });

  it("case 7: admin and owner read a member's messages; a plain member and a non-member do not", async () => {
    for (const actor of [ADMIN_ID, OWNER_ID]) {
      const messages = await repository.listReadableMessages({
        actorId: actor,
        sessionId: SESSION_MEMBER,
      });
      expect(messages?.map((row) => row.id)).toEqual([MSG_MEMBER]);
    }

    await expect(
      repository.listReadableMessages({
        actorId: MEMBER_ID,
        sessionId: SESSION_NEW,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.listReadableMessages({
        actorId: OUTSIDER_ID,
        sessionId: SESSION_MEMBER,
      }),
    ).resolves.toBeNull();
  });

  it("case 8: the thread binding is readable, keeps a null thread_id, and follows the same ACL", async () => {
    await expect(
      repository.findReadableSessionThread({
        actorId: AUTHOR_ID,
        sessionId: SESSION_NEW,
      }),
    ).resolves.toEqual({ id: SESSION_NEW, threadId: THREAD_ACTIVE });

    // Legacy session: the row exists and is readable, the binding is absent.
    await expect(
      repository.findReadableSessionThread({
        actorId: AUTHOR_ID,
        sessionId: SESSION_OLD,
      }),
    ).resolves.toEqual({ id: SESSION_OLD, threadId: null });

    await expect(
      repository.findReadableSessionThread({
        actorId: ADMIN_ID,
        sessionId: SESSION_MEMBER,
      }),
    ).resolves.toEqual({ id: SESSION_MEMBER, threadId: THREAD_MEMBER });

    await expect(
      repository.findReadableSessionThread({
        actorId: MEMBER_ID,
        sessionId: SESSION_NEW,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findReadableSessionThread({
        actorId: OUTSIDER_ID,
        sessionId: SESSION_OUTSIDER,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findReadableSessionThread({
        actorId: AUTHOR_ID,
        sessionId: SESSION_ARCHIVED,
      }),
    ).resolves.toBeNull();
  });

  it("case 9: assets answer only for ids of the session's own project", async () => {
    const rows = await repository.listReadableSessionAssets({
      actorId: AUTHOR_ID,
      sessionId: SESSION_NEW,
      assetIds: [
        ASSET_MATCH,
        ASSET_SIBLING,
        ASSET_FOREIGN,
        ASSET_LEGACY,
        ASSET_ARCHIVED,
        ASSET_MISSING,
      ],
    });

    expect(rows.map((row) => row.id).sort()).toEqual(
      [ASSET_MATCH, ASSET_SIBLING].sort(),
    );
    expect(rows.find((row) => row.id === ASSET_MATCH)).toEqual({
      id: ASSET_MATCH,
      object_path: MATCH_PATH,
      bucket: BUCKET,
    });

    // The excluded rows really exist — the exclusion is the SQL's, not the
    // fixture's.
    const stored = await db.query<{ id: string }>(
      `select id from public.asset_objects where id = any($1::uuid[])`,
      [[ASSET_FOREIGN, ASSET_LEGACY, ASSET_ARCHIVED]],
    );
    expect(stored.rows).toHaveLength(3);
  });

  it("case 10: an empty id list answers [] without opening a connection", async () => {
    connectAttempts = 0;

    const rows = await repository.listReadableSessionAssets({
      actorId: AUTHOR_ID,
      sessionId: SESSION_NEW,
      assetIds: [],
    });

    expect(rows).toEqual([]);
    expect(connectAttempts).toBe(0);

    // The counter really does observe a read: this one has to open one.
    await repository.listReadableSessions({
      actorId: AUTHOR_ID,
      canvasId: ACTIVE_CANVAS,
    });
    expect(connectAttempts).toBe(1);
  });

  it("case 11: a plain member and a non-member get no asset identities although the rows exist", async () => {
    const assetIds = [ASSET_MATCH, ASSET_SIBLING];

    await expect(
      repository.listReadableSessionAssets({
        actorId: MEMBER_ID,
        sessionId: SESSION_NEW,
        assetIds,
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.listReadableSessionAssets({
        actorId: OUTSIDER_ID,
        sessionId: SESSION_NEW,
        assetIds,
      }),
    ).resolves.toEqual([]);

    const owners = await repository.listReadableSessionAssets({
      actorId: OWNER_ID,
      sessionId: SESSION_NEW,
      assetIds,
    });
    expect(owners.map((row) => row.id).sort()).toEqual(assetIds.sort());
  });

  it("case 12: a JSONB object where an array is promised fails loud", async () => {
    await expect(
      repository.listReadableMessages({
        actorId: AUTHOR_ID,
        sessionId: SESSION_SHAPE,
      }),
    ).rejects.toBeInstanceOf(ChatReadError);

    // The row really is a JSONB object in the table.
    const stored = await db.query<{ shape: string }>(
      `select jsonb_typeof(tool_activities) as shape
         from public.chat_messages where id = $1`,
      [MSG_SHAPE],
    );
    expect(firstRow(stored.rows).shape).toBe("object");
  });

  it("case 13: an illegal uuid is a real SQL error, wrapped, and the same pool still reads", async () => {
    await expect(
      db.query("select id from public.chat_sessions where id = $1", [INVALID_ID]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const detail = await repository
      .listReadableSessions({ actorId: AUTHOR_ID, canvasId: INVALID_ID })
      .catch((reason: unknown) => reason);

    expect(detail).toBeInstanceOf(ChatReadError);
    expect((detail as ChatReadError).operation).toBe(LIST_READABLE_SESSIONS);
    expect((detail as ChatReadError).message).toBe(
      `chat read failed (${LIST_READABLE_SESSIONS})`,
    );
    expect((detail as ChatReadError).message).not.toMatch(
      /select|public\.|join|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    expect(((detail as ChatReadError).cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    // Each of the other reads reports its own operation for the same class of
    // failure — including a non-uuid inside the bound id array.
    const messagesError = await repository
      .listReadableMessages({ actorId: AUTHOR_ID, sessionId: INVALID_ID })
      .catch((reason: unknown) => reason);
    expect((messagesError as ChatReadError).operation).toBe(
      LIST_READABLE_MESSAGES,
    );

    const threadError = await repository
      .findReadableSessionThread({ actorId: AUTHOR_ID, sessionId: INVALID_ID })
      .catch((reason: unknown) => reason);
    expect((threadError as ChatReadError).operation).toBe(
      FIND_READABLE_SESSION_THREAD,
    );

    const assetsError = await repository
      .listReadableSessionAssets({
        actorId: AUTHOR_ID,
        sessionId: SESSION_NEW,
        assetIds: [INVALID_ID],
      })
      .catch((reason: unknown) => reason);
    expect((assetsError as ChatReadError).operation).toBe(
      LIST_READABLE_SESSION_ASSETS,
    );

    // ROLLBACK plus release left the connection usable for the next read.
    const after = await repository.listReadableMessages({
      actorId: AUTHOR_ID,
      sessionId: SESSION_NEW,
    });
    expect(after?.map((row) => row.id)).toEqual([MSG_EARLY, MSG_LATE]);
  });

  it("case 14: the repository's own SQL decides, not the old RLS policy", async () => {
    // Under the old policies an archived project is still readable: nothing in
    // `private.can_read_project` filters `archived_at`. The authenticated role
    // therefore SEES the archived session.
    const viaRls = await asUser(db, AUTHOR_ID, async (tx) =>
      tx.query<{ id: string }>(
        "select id from public.chat_sessions where id = $1",
        [SESSION_ARCHIVED],
      ),
    );
    expect(viaRls.rows.map((row) => row.id)).toEqual([SESSION_ARCHIVED]);

    // The repository runs privileged (the database owner bypasses RLS) and still
    // answers null, because the archived filter is IN the statement.
    await expect(
      repository.listReadableSessions({
        actorId: AUTHOR_ID,
        canvasId: ARCHIVED_CANVAS,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findReadableSessionThread({
        actorId: AUTHOR_ID,
        sessionId: SESSION_ARCHIVED,
      }),
    ).resolves.toBeNull();

    // And the ordinary read is not blocked by anything else: the same actor
    // reads their own active canvas.
    await expect(
      repository.listReadableSessions({
        actorId: AUTHOR_ID,
        canvasId: ACTIVE_CANVAS,
      }),
    ).resolves.not.toBeNull();
  });
});
