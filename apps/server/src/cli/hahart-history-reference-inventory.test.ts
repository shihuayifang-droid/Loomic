// X-52 phase 1B (T-23): the history inventory may only report what it can PROVE.
//
// WHAT EVERY CASE BELOW IS PROTECTING
//   * Two different facts, kept apart: a message inside project A proves the
//     MESSAGE is A's, and proves nothing about the object a URL in it points at.
//     A URL, path or object name is only ever a fingerprint here.
//   * The scan is read-only by construction: allowlisted statements inside a
//     REPEATABLE READ READ ONLY transaction. The cases check the allowlist, check
//     that no write/DDL/RPC statement is ever sent, and check that PostgreSQL
//     itself refuses a write inside that transaction.
//   * Completeness is a claim: keyset pagination (never OFFSET) is exercised at
//     pageSize + 1 and 2 * pageSize + 1, a repeated cursor key fails the run, and
//     a blob that cannot be decoded is reported instead of skipped.
//   * Nothing that could carry a secret reaches stdout. The fixtures use URLs
//     that carry a query token, so a leak would fail the deny-list rather than
//     quietly ship.
//
// The database is the in-repo PGlite harness with the real migrations applied;
// the CLI's own executor is injected, so the SQL under test is the shipped SQL.
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "../test-support/db/pglite-db.js";
import {
  ACTIONS,
  DEFAULT_PAGE_SIZE,
  DENY_LIST,
  LEGACY_CANVASES_BUCKET,
  MAX_PAGE_SIZE,
  PaginationError,
  StatementNotAllowedError,
  USAGE_TEXT,
  UsageError,
  assertReadOnlyStatement,
  assertRedactionSafe,
  buildReport,
  collectReferences,
  createReadOnlyExecutor,
  decodeSerializedValue,
  exitCodeForReport,
  fingerprint,
  fingerprintKindFor,
  isRedactionSafe,
  parseArgs,
  runHistoryReferenceInventory,
  sanitizeIdentifier,
  sanitizePointerSegment,
  serializeReport,
  toBytes,
  type InventoryItem,
  type QueryExecutor,
} from "./hahart-history-reference-inventory.js";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let db: PGlite;
let workspaceId = "";

const USER_ID = randomUUID();

/** Every statement the shipped code actually sent, in order. */
const executed: string[] = [];

const baseExecutor: QueryExecutor = {
  query: async (sql, params) => {
    executed.push(sql);
    const result = await db.query(sql, params === undefined ? undefined : [...params]);
    return { rows: result.rows as Array<Record<string, unknown>> };
  },
};

const executor = createReadOnlyExecutor(baseExecutor);

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

async function inventory(options: { pageSize?: number } = {}): Promise<
  Awaited<ReturnType<typeof runHistoryReferenceInventory>>
> {
  executed.length = 0;
  return runHistoryReferenceInventory(executor, options);
}

/** Only the items this case created — the database is shared across cases. */
function itemsOf(report: { items: InventoryItem[] }, rowId: string): InventoryItem[] {
  return report.items.filter((item) => item.rowId === rowId);
}

async function makeProject(name: string): Promise<{ id: string; canvasId: string }> {
  const project = firstRow(
    (
      await db.query<{ id: string }>(
        "insert into public.projects (workspace_id, name, slug, created_by) values ($1, $2, $3, $4) returning id",
        [workspaceId, name, `${name}-${randomUUID().slice(0, 8)}`, USER_ID],
      )
    ).rows,
  );
  const canvas = firstRow(
    (
      await db.query<{ id: string }>(
        "insert into public.canvases (project_id, name, created_by) values ($1, $2, $3) returning id",
        [project.id, `${name}-canvas`, USER_ID],
      )
    ).rows,
  );
  return { id: project.id, canvasId: canvas.id };
}

async function makeSession(canvasId: string, threadId: string | null): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "insert into public.chat_sessions (canvas_id, thread_id, title, created_by) values ($1, $2, $3, $4) returning id",
        [canvasId, threadId, "t", USER_ID],
      )
    ).rows,
  ).id;
}

async function makeMessage(
  sessionId: string,
  contentBlocks: unknown,
  toolActivities: unknown,
): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.chat_messages (session_id, role, content, content_blocks, tool_activities)
         values ($1, 'assistant', '', $2::jsonb, $3::jsonb) returning id`,
        [
          sessionId,
          contentBlocks === null ? null : JSON.stringify(contentBlocks),
          toolActivities === null ? null : JSON.stringify(toolActivities),
        ],
      )
    ).rows,
  ).id;
}

async function makeRun(sessionId: string, threadId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "insert into public.agent_runs (session_id, thread_id, status) values ($1, $2, 'completed') returning id",
        [sessionId, threadId],
      )
    ).rows,
  ).id;
}

async function makeAsset(projectId: string | null, objectPath: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
         values ($1, $2, 'project-assets', $3, $4) returning id`,
        [workspaceId, projectId, objectPath, USER_ID],
      )
    ).rows,
  ).id;
}

async function makeJob(options: {
  projectId?: string | null;
  canvasId?: string | null;
  sessionId?: string | null;
  threadId?: string | null;
  result: unknown;
}): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.background_jobs
           (workspace_id, project_id, canvas_id, session_id, thread_id, queue_name, job_type, status, result, created_by)
         values ($1, $2, $3, $4, $5, 'image', 'image_generation', 'succeeded', $6::jsonb, $7) returning id`,
        [
          workspaceId,
          options.projectId ?? null,
          options.canvasId ?? null,
          options.sessionId ?? null,
          options.threadId ?? null,
          JSON.stringify(options.result),
          USER_ID,
        ],
      )
    ).rows,
  ).id;
}

async function makeCheckpoint(options: {
  threadId: string;
  checkpointId?: string;
  checkpoint: unknown;
  metadata?: unknown;
  type?: string | null;
}): Promise<string> {
  const checkpointId = options.checkpointId ?? randomUUID();
  await db.query(
    `insert into langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata)
     values ($1, '', $2, $3, $4::jsonb, $5::jsonb)`,
    [
      options.threadId,
      checkpointId,
      options.type === undefined ? "json" : options.type,
      JSON.stringify(options.checkpoint ?? {}),
      JSON.stringify(options.metadata ?? {}),
    ],
  );
  return checkpointId;
}

const hex = (value: string | Uint8Array): string =>
  typeof value === "string"
    ? Buffer.from(value, "utf8").toString("hex")
    : Buffer.from(value).toString("hex");

async function makeBlob(options: {
  threadId: string;
  channel?: string;
  /** `null` is a real value here: `langgraph.checkpoints.type` is nullable. */
  type: string | null;
  blob: string | Uint8Array | null;
}): Promise<void> {
  await db.query(
    `insert into langgraph.checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
     values ($1, '', $2, $3, $4, decode($5, 'hex'))`,
    [
      options.threadId,
      options.channel ?? `channel-${randomUUID().slice(0, 8)}`,
      randomUUID(),
      options.type,
      options.blob === null ? null : hex(options.blob),
    ],
  );
}

async function makeWrite(options: {
  threadId: string;
  /** `null` is a real value here: `langgraph.checkpoint_writes.type` is nullable. */
  type: string | null;
  blob: string | Uint8Array;
}): Promise<void> {
  await db.query(
    `insert into langgraph.checkpoint_writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob)
     values ($1, '', $2, $3, 0, $4, $5, decode($6, 'hex'))`,
    [
      options.threadId,
      randomUUID(),
      randomUUID(),
      `channel-${randomUUID().slice(0, 8)}`,
      options.type,
      hex(options.blob),
    ],
  );
}

async function makeStorageObject(name: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "insert into storage.objects (bucket_id, name) values ('canvases', $1) returning id",
        [name],
      )
    ).rows,
  ).id;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  await createUser(db, USER_ID, "inventory-exec@example.test");
  workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "insert into public.workspaces (type, name, owner_user_id) values ('team', 'w17', $1) returning id",
        [USER_ID],
      )
    ).rows,
  ).id;
  await db.query(
    "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')",
    [workspaceId, USER_ID],
  );
}, 120_000);

const URL_WITH_TOKEN = `https://example.test/generated/${randomUUID()}.png?token=secret-value`;

/* ------------------------------------------------------------------ */
/* Arguments and the read-only allowlist                               */
/* ------------------------------------------------------------------ */

describe("arguments", () => {
  it("case 1: defaults come from the documented page size", () => {
    expect(parseArgs([])).toEqual({ pageSize: DEFAULT_PAGE_SIZE });
    expect(DEFAULT_PAGE_SIZE).toBe(200);
  });

  it("case 2: --page-size accepts both spellings inside 1..1000", () => {
    expect(parseArgs(["--page-size", "1"])).toEqual({ pageSize: 1 });
    expect(parseArgs(["--page-size", String(MAX_PAGE_SIZE)])).toEqual({ pageSize: MAX_PAGE_SIZE });
    expect(parseArgs(["--page-size=37"])).toEqual({ pageSize: 37 });
  });

  it("case 3: --page-size out of range or not a number is a usage error", () => {
    expect(() => parseArgs(["--page-size", "0"])).toThrow(UsageError);
    expect(() => parseArgs(["--page-size", "1001"])).toThrow(UsageError);
    expect(() => parseArgs(["--page-size", "abc"])).toThrow(UsageError);
    expect(() => parseArgs(["--page-size"])).toThrow(UsageError);
  });

  it("case 4: parseArgs(['--apply']) fails — there is no writable mode", () => {
    expect(() => parseArgs(["--apply"])).toThrow(UsageError);
    expect(() => parseArgs(["--apply", "--page-size", "5"])).toThrow(UsageError);
  });

  it("case 5: the help text advertises no writable mode", () => {
    expect(() => parseArgs(["--help"])).toThrow(UsageError);
    expect(USAGE_TEXT).toContain("READ-ONLY");
    expect(USAGE_TEXT).not.toMatch(/--apply|dry.run|writable mode is/i);
    expect(USAGE_TEXT).toContain("--page-size");
  });
});

describe("statement allowlist", () => {
  it("case 6: BEGIN / SET / SELECT / COMMIT / ROLLBACK are the whole list", () => {
    for (const sql of [
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET LOCAL statement_timeout = '15000ms'",
      "select id from public.projects",
      "COMMIT",
      "ROLLBACK",
      "-- leading comment\nselect 1",
      "/* block */ select 1",
      "select 1;",
    ]) {
      expect(() => assertReadOnlyStatement(sql)).not.toThrow();
    }
  });

  it("case 7: every write, DDL and RPC statement is rejected before it is sent", () => {
    for (const sql of [
      "INSERT INTO public.asset_objects (id) VALUES (1)",
      "update public.asset_objects set project_id = null",
      "DELETE FROM public.chat_messages",
      "create table evil (x int)",
      "drop table public.asset_objects",
      "truncate public.chat_messages",
      "grant all on public.projects to anon",
      "call public.record_project_asset(null)",
      "select public.record_project_asset('a', 'b')",
      "do $$ begin perform 1; end $$",
      "copy public.projects to stdout",
      "vacuum full public.projects",
    ]) {
      expect(() => assertReadOnlyStatement(sql)).toThrow(StatementNotAllowedError);
    }
    // `select ... into` is a write wearing a SELECT's first keyword.
    expect(() => assertReadOnlyStatement("select 1; drop table public.projects")).toThrow(
      StatementNotAllowedError,
    );
  });

  it("case 8: one call carries exactly one statement", () => {
    expect(() => assertReadOnlyStatement("select 1;select 2")).toThrow(StatementNotAllowedError);
    expect(() => assertReadOnlyStatement("   ")).toThrow(StatementNotAllowedError);
  });

  it("case 9: the executor guard is what the scan runs behind", async () => {
    const guarded = createReadOnlyExecutor(baseExecutor);
    await expect(guarded.query("delete from public.chat_messages")).rejects.toThrow(
      StatementNotAllowedError,
    );
    // Nothing forbidden reached the driver.
    expect(executed.some((sql) => /delete/i.test(sql))).toBe(false);
  });

  it("case 10: PostgreSQL itself refuses a write inside the read-only transaction", async () => {
    // The allowlist is the second guard; this is the first one, and it is the
    // database's own. It is exercised on the raw connection, because a write can
    // never get past the allowlist to reach the database in the first place.
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await expect(db.query("create table w17_probe (x int)")).rejects.toThrow(
        /read-only transaction/i,
      );
    } finally {
      await db.query("ROLLBACK");
    }

    // A fresh transaction: the first failure aborts the rest of its own block.
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await expect(
        db.query(
          "insert into public.asset_objects (workspace_id, bucket, object_path) values ($1, 'project-assets', $2)",
          [workspaceId, `w17/probe-${randomUUID()}.png`],
        ),
      ).rejects.toThrow(/read-only transaction/i);
    } finally {
      await db.query("ROLLBACK");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

describe("redaction", () => {
  it("case 11: every deny-list token is caught, case-insensitively", () => {
    for (const token of DENY_LIST) {
      expect(isRedactionSafe(`prefix ${token.toUpperCase()} suffix`)).toBe(false);
      expect(() => assertRedactionSafe(`prefix ${token.toUpperCase()} suffix`)).toThrow();
    }
    expect(isRedactionSafe('{"reason":"asset_id_missing"}')).toBe(true);
    expect(() => assertRedactionSafe("clean report")).not.toThrow();
    // The refusal message names an index, never the offending value.
    try {
      assertRedactionSafe("see https://example.test/x?token=1");
      throw new Error("should have thrown");
    } catch (error) {
      expect(String(error)).not.toContain("example.test");
    }
  });

  it("case 12: fingerprints are truncated, stable and do not collide", () => {
    const one = fingerprint(URL_WITH_TOKEN);
    expect(one).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint(URL_WITH_TOKEN)).toBe(one);
    expect(fingerprint(`${URL_WITH_TOKEN}x`)).not.toBe(one);
  });

  it("case 13: an unsafe object key is replaced by a fingerprint, not printed", () => {
    expect(sanitizePointerSegment("url")).toBe("url");
    expect(sanitizePointerSegment("a~b")).toBe("a~0b");
    const unsafe = sanitizePointerSegment(URL_WITH_TOKEN);
    expect(unsafe).toBe(`#${fingerprint(URL_WITH_TOKEN)}`);
    expect(unsafe).not.toContain("example.test");
  });

  it("case 14: row identities stay readable only while they look like ids", () => {
    const id = randomUUID();
    expect(sanitizeIdentifier(id)).toBe(id);
    expect(sanitizeIdentifier(URL_WITH_TOKEN)).toBe(`#${fingerprint(URL_WITH_TOKEN)}`);
  });
});

/* ------------------------------------------------------------------ */
/* Reference discovery and decoding                                    */
/* ------------------------------------------------------------------ */

describe("reference discovery", () => {
  it("case 15: asset ids, URLs and known path keys are found; data URLs are not", () => {
    const assetId = randomUUID();
    const found: Array<{ pointer: string; assetId: string | null; kind: string | null }> = [];
    collectReferences(
      {
        blocks: [
          { type: "image", assetId },
          { type: "file", dataURL: "data:image/png;base64,AAAA" },
          { type: "image", url: URL_WITH_TOKEN },
          { type: "file", object_path: "project-assets/ws/1/a.png" },
          { type: "note", text: "half/way through a sentence" },
          { type: "image", image_url: "https://example.test/other.png" },
        ],
      },
      (discovery) =>
        found.push({
          pointer: discovery.pointer,
          assetId: discovery.assetId,
          kind: discovery.fingerprintKind,
        }),
    );

    expect(found).toContainEqual({ pointer: "/blocks/0/assetId", assetId, kind: null });
    expect(found).toContainEqual({
      pointer: "/blocks/2/url",
      assetId: null,
      kind: "url",
    });
    expect(found).toContainEqual({
      pointer: "/blocks/3/object_path",
      assetId: null,
      kind: "object_path",
    });
    // A URL is a reference under any key; a bare path only under a known key.
    expect(found).toContainEqual({ pointer: "/blocks/5/image_url", assetId: null, kind: "url" });
    expect(found.some((entry) => entry.pointer.includes("dataURL"))).toBe(false);
    expect(found.some((entry) => entry.pointer.includes("text"))).toBe(false);
    expect(found).toHaveLength(4);
  });

  it("case 16: fingerprint kinds separate URLs from object paths", () => {
    expect(fingerprintKindFor("https://example.test/a.png")).toBe("url");
    expect(fingerprintKindFor("oss://project-assets/a/b.png")).toBe("object_path");
    expect(fingerprintKindFor("ws-team/canvas/a.png")).toBe("object_path");
    expect(fingerprintKindFor("plain words here")).toBe(null);
  });

  it("case 17: a deeply nested value does not blow the stack", () => {
    let nested: unknown = { asset_id: randomUUID() };
    for (let depth = 0; depth < 5000; depth += 1) nested = { child: nested };
    const found: string[] = [];
    collectReferences(nested, (discovery) => found.push(discovery.pointer));
    expect(found).toHaveLength(1);
  });
});

describe("serializer decoding", () => {
  it("case 18: json decodes, empty+null is skipped, bytes is an explicit human item", () => {
    expect(decodeSerializedValue("json", Buffer.from('{"a":1}', "utf8"))).toEqual({
      kind: "value",
      value: { a: 1 },
    });
    expect(decodeSerializedValue("empty", null)).toEqual({ kind: "skipped" });
    expect(decodeSerializedValue("bytes", Buffer.from([0x00, 0xff]))).toEqual({
      kind: "opaque_binary",
    });
  });

  it("case 18b: a serializer that is not an explicit json / empty / bytes is never guessed", () => {
    // This assertion used to say the opposite (`null` type decoded as JSON). The
    // ticket corrected it: bytes that happen to parse as JSON do not prove the
    // serializer was JSON, so NULL / empty / non-string is `unsupported_encoding`.
    for (const serializer of [null, undefined, "", 0, 42, {}, [], Buffer.from("json")]) {
      expect(decodeSerializedValue(serializer, Buffer.from('{"a":1}', "utf8"))).toEqual({
        kind: "unsupported_encoding",
      });
    }
    expect(decodeSerializedValue("JSON", Buffer.from("[]", "utf8"))).toEqual({
      kind: "unsupported_encoding",
    });
    expect(decodeSerializedValue("json", Buffer.from("[]", "utf8"))).toEqual({
      kind: "value",
      value: [],
    });
    expect(decodeSerializedValue("bytes", new Uint8Array([1]))).toEqual({ kind: "opaque_binary" });
    expect(decodeSerializedValue("empty", null)).toEqual({ kind: "skipped" });
  });

  it("case 19: an unknown serializer is reported, never guessed", () => {
    expect(decodeSerializedValue("msgpack", Buffer.from("x", "utf8"))).toEqual({
      kind: "unsupported_encoding",
    });
  });

  it("case 20: broken UTF-8 and broken JSON are decode failures", () => {
    expect(decodeSerializedValue("json", new Uint8Array([0xff, 0xfe, 0xfd]))).toEqual({
      kind: "decode_failure",
    });
    expect(decodeSerializedValue("json", Buffer.from("{not json", "utf8"))).toEqual({
      kind: "decode_failure",
    });
    expect(decodeSerializedValue("json", null)).toEqual({ kind: "decode_failure" });
    expect(decodeSerializedValue("empty", Buffer.from("x", "utf8"))).toEqual({
      kind: "decode_failure",
    });
  });

  it("case 21: bytea arrives as bytes or as \\x-hex, and both are understood", () => {
    expect(toBytes(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
    expect(toBytes("\\x0102")).toEqual(new Uint8Array([1, 2]));
    expect(toBytes("abc")).toEqual(new TextEncoder().encode("abc"));
    expect(toBytes(null)).toBe(null);
    expect(toBytes("\\xzz")).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/* Report shape and exit codes                                         */
/* ------------------------------------------------------------------ */

function item(overrides: Partial<InventoryItem>): InventoryItem {
  return {
    sourceTable: "public.chat_messages",
    sourceColumn: "content_blocks",
    rowId: "row",
    pointer: "/0/url",
    containerProjectId: "p",
    containerProof: "PROJECT_CHAIN_EXACT",
    assetId: null,
    objectProof: "UNPROVEN",
    reason: "asset_id_missing",
    action: "BACKFILL_ASSET_ID_AFTER_MANUAL_PROOF",
    fingerprint: "0".repeat(16),
    fingerprintKind: "url",
    ...overrides,
  };
}

describe("report and exit codes", () => {
  it("case 22: exit 0 needs a complete scan with nothing unresolved", () => {
    const report = buildReport([
      item({
        objectProof: "ASSET_ID_EXACT",
        reason: "asset_id_exact",
        action: "NONE",
        assetId: randomUUID(),
        fingerprint: null,
        fingerprintKind: null,
      }),
    ]);
    expect(report.summary).toMatchObject({ unresolved: 0, conflicts: 0, exactBindings: 1 });
    expect(exitCodeForReport(report)).toBe(0);
  });

  it("case 23: exit 1 is a complete scan that still needs a human", () => {
    expect(exitCodeForReport(buildReport([item({})]))).toBe(1);
    expect(
      exitCodeForReport(buildReport([item({ containerProof: "UNPROVEN", reason: "unbound_thread" })])),
    ).toBe(1);
    expect(
      exitCodeForReport(
        buildReport([item({ reason: "opaque_binary", action: "REVIEW_DECODER_GAP" })]),
      ),
    ).toBe(1);
  });

  it("case 24: exit 2 means the scan could not be trusted", () => {
    const report = buildReport([
      item({ reason: "decode_failure", action: "REVIEW_DECODER_GAP" }),
    ]);
    expect(report.complete).toBe(false);
    expect(exitCodeForReport(report)).toBe(2);

    const unsupported = buildReport([
      item({ reason: "unsupported_encoding", action: "REVIEW_DECODER_GAP" }),
    ]);
    expect(unsupported.summary.unsupportedEncodings).toBe(1);
    expect(exitCodeForReport(unsupported)).toBe(2);
  });

  it("case 25: a report is one JSON document with the fixed header fields", () => {
    const report = buildReport([item({})]);
    expect(report.schemaVersion).toBe(1);
    expect(report.mode).toBe("read-only");
    expect(JSON.parse(serializeReport(report))).toMatchObject({ schemaVersion: 1 });
    expect(isRedactionSafe(serializeReport(report))).toBe(true);
  });

  it("case 26: the action vocabulary is closed — nothing applyable exists", () => {
    expect(ACTIONS).toContain("BACKFILL_ASSET_ID_AFTER_MANUAL_PROOF");
    expect(ACTIONS.some((action) => /apply|fix_now|write/i.test(action))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The scan itself — real migrations, injected executor                */
/* ------------------------------------------------------------------ */

describe("history inventory against the migrated schema", () => {
  it("case 27: a URL-only content block proves the container and not the object", async () => {
    const project = await makeProject("w17-url-only");
    const session = await makeSession(project.canvasId, randomUUID());
    const message = await makeMessage(session, [{ type: "image", url: URL_WITH_TOKEN }], null);

    const report = await inventory();
    const items = itemsOf(report, message);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceTable: "public.chat_messages",
      sourceColumn: "content_blocks",
      pointer: "/0/url",
      containerProjectId: project.id,
      containerProof: "PROJECT_CHAIN_EXACT",
      assetId: null,
      objectProof: "UNPROVEN",
      reason: "asset_id_missing",
      action: "BACKFILL_ASSET_ID_AFTER_MANUAL_PROOF",
    });
    expect(items[0]?.fingerprint).toBe(fingerprint(URL_WITH_TOKEN));
    // The raw URL, its host and its token are nowhere in the document.
    const json = serializeReport(report);
    expect(json).not.toContain("example.test");
    expect(json).not.toContain("secret-value");
    expect(json).not.toContain(URL_WITH_TOKEN);
  });

  it("case 28: an exact assetId in a content block is an exact binding", async () => {
    const project = await makeProject("w17-exact");
    const session = await makeSession(project.canvasId, randomUUID());
    const assetId = await makeAsset(project.id, `w17/${randomUUID()}.png`);
    const message = await makeMessage(session, [{ type: "image", assetId }], null);

    const items = itemsOf(await inventory(), message);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      assetId,
      objectProof: "ASSET_ID_EXACT",
      reason: "asset_id_exact",
      action: "NONE",
      containerProjectId: project.id,
    });
  });

  it("case 29: a tool artifact carries the same stable identity", async () => {
    const project = await makeProject("w17-tool");
    const session = await makeSession(project.canvasId, randomUUID());
    const assetId = await makeAsset(project.id, `w17/${randomUUID()}.png`);
    const message = await makeMessage(session, null, [
      { name: "generate_image", output: { asset_id: assetId } },
    ]);

    const items = itemsOf(await inventory(), message);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceColumn: "tool_activities",
      pointer: "/0/output/asset_id",
      objectProof: "ASSET_ID_EXACT",
      reason: "asset_id_exact",
    });
  });

  it("case 30: the two physical columns are reported separately, never merged", async () => {
    const project = await makeProject("w17-two-columns");
    const session = await makeSession(project.canvasId, randomUUID());
    const message = await makeMessage(
      session,
      [{ type: "image", url: URL_WITH_TOKEN }],
      [{ name: "generate_image", output: { url: URL_WITH_TOKEN } }],
    );

    const items = itemsOf(await inventory(), message);

    expect(items).toHaveLength(2);
    expect(items.map((entry) => entry.sourceColumn).sort()).toEqual([
      "content_blocks",
      "tool_activities",
    ]);
    expect(items.map((entry) => entry.pointer).sort()).toEqual(["/0/output/url", "/0/url"]);
    expect(items.every((entry) => entry.objectProof === "UNPROVEN")).toBe(true);
  });

  it("case 31: the same URL in two rows is two items and never upgrades the proof", async () => {
    const project = await makeProject("w17-same-url");
    const session = await makeSession(project.canvasId, randomUUID());
    const shared = `https://example.test/shared/${randomUUID()}.png`;
    const first = await makeMessage(session, [{ type: "image", url: shared }], null);
    const second = await makeMessage(session, [{ type: "image", url: shared }], null);

    const report = await inventory();
    const items = [...itemsOf(report, first), ...itemsOf(report, second)];

    expect(items).toHaveLength(2);
    expect(items[0]?.fingerprint).toBe(items[1]?.fingerprint);
    expect(items.every((entry) => entry.objectProof === "UNPROVEN")).toBe(true);
    expect(items.every((entry) => entry.reason === "asset_id_missing")).toBe(true);
  });

  it("case 32: a broken session -> canvas chain is reported, not repaired", async () => {
    // The chain cannot be broken in a valid database (every link is a NOT NULL
    // FK), so the fixture hides the canvas row from the scan — the same shape a
    // restricted role or a partially visible catalog would produce.
    const project = await makeProject("w17-broken-chain");
    const session = await makeSession(project.canvasId, randomUUID());
    const message = await makeMessage(session, [{ type: "image", url: URL_WITH_TOKEN }], null);

    const blind: QueryExecutor = createReadOnlyExecutor({
      query: async (sql, params) => {
        const result = await baseExecutor.query(sql, params);
        return sql.includes("from public.canvases") ? { rows: [] } : result;
      },
    });

    const report = await runHistoryReferenceInventory(blind, {});
    const items = itemsOf(report, message);

    expect(items.map((entry) => entry.reason).sort()).toEqual([
      "asset_id_missing",
      "broken_container_chain",
    ]);
    expect(items.every((entry) => entry.containerProof === "UNPROVEN")).toBe(true);
    expect(items.every((entry) => entry.containerProjectId === null)).toBe(true);
  });

  it("case 33: an assetId that is not an id is missing, and its value is not echoed", async () => {
    const project = await makeProject("w17-bad-id");
    const session = await makeSession(project.canvasId, randomUUID());
    const message = await makeMessage(
      session,
      [{ type: "image", asset_id: "not-a-uuid-but-probably-a-secret" }],
      null,
    );

    const report = await inventory();
    const items = itemsOf(report, message);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      assetId: null,
      objectProof: "UNPROVEN",
      reason: "asset_id_missing",
      action: "KEEP_UNRESOLVED",
      fingerprint: null,
    });
    expect(serializeReport(report)).not.toContain("not-a-uuid-but-probably-a-secret");
  });

  it("case 34: an assetId with no row is asset_row_missing", async () => {
    const project = await makeProject("w17-row-missing");
    const session = await makeSession(project.canvasId, randomUUID());
    const message = await makeMessage(session, [{ type: "image", assetId: randomUUID() }], null);

    const items = itemsOf(await inventory(), message);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      objectProof: "UNPROVEN",
      reason: "asset_row_missing",
      action: "KEEP_UNRESOLVED",
    });
  });

  it("case 35: an asset row with no project is unassigned", async () => {
    const project = await makeProject("w17-unassigned");
    const session = await makeSession(project.canvasId, randomUUID());
    const assetId = await makeAsset(null, `w17/${randomUUID()}.png`);
    const message = await makeMessage(session, [{ type: "image", assetId }], null);

    const items = itemsOf(await inventory(), message);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      assetId,
      objectProof: "UNPROVEN",
      reason: "asset_project_unassigned",
      action: "FIX_RELATIONSHIP",
    });
  });

  it("case 36: an asset owned by another project is a conflict", async () => {
    const projectA = await makeProject("w17-conflict-a");
    const projectB = await makeProject("w17-conflict-b");
    const session = await makeSession(projectA.canvasId, randomUUID());
    const assetId = await makeAsset(projectB.id, `w17/${randomUUID()}.png`);
    const message = await makeMessage(session, [{ type: "image", assetId }], null);

    const items = itemsOf(await inventory(), message);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      assetId,
      containerProjectId: projectA.id,
      objectProof: "CONFLICT",
      reason: "asset_project_conflict",
      action: "FIX_RELATIONSHIP",
    });
  });

  it("case 37: a run that agrees with its session is silent, and binds the thread", async () => {
    const project = await makeProject("w17-run-ok");
    const thread = randomUUID();
    const session = await makeSession(project.canvasId, thread);
    const runId = await makeRun(session, thread);
    const checkpointId = await makeCheckpoint({
      threadId: thread,
      checkpoint: { url: URL_WITH_TOKEN },
    });

    const report = await inventory();

    expect(itemsOf(report, runId)).toHaveLength(0);
    const checkpoints = report.items.filter(
      (entry) => entry.sourceTable === "langgraph.checkpoints" && entry.rowId.includes(checkpointId),
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      containerProof: "THREAD_SESSION_EXACT",
      containerProjectId: project.id,
      sourceColumn: "checkpoint",
    });
  });

  it("case 38: a run whose session carries another thread is a mismatch", async () => {
    const project = await makeProject("w17-run-mismatch");
    const sessionThread = randomUUID();
    const session = await makeSession(project.canvasId, sessionThread);
    const runThread = randomUUID();
    const runId = await makeRun(session, runThread);

    const items = itemsOf(await inventory(), runId);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceTable: "public.agent_runs",
      sourceColumn: "thread_id",
      containerProof: "CONFLICT",
      reason: "run_session_thread_mismatch",
      action: "FIX_RELATIONSHIP",
    });
  });

  it("case 39: runs converging on two projects make the thread ambiguous", async () => {
    const projectA = await makeProject("w17-ambiguous-a");
    const projectB = await makeProject("w17-ambiguous-b");
    // Legacy sessions (no thread_id of their own) so the only route is agent_runs.
    const sessionA = await makeSession(projectA.canvasId, null);
    const sessionB = await makeSession(projectB.canvasId, null);
    const thread = randomUUID();
    await makeRun(sessionA, thread);
    await makeRun(sessionB, thread);
    const checkpointId = await makeCheckpoint({ threadId: thread, checkpoint: {} });

    const report = await inventory();
    const items = report.items.filter(
      (entry) => entry.sourceTable === "langgraph.checkpoints" && entry.rowId.includes(checkpointId),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      containerProof: "CONFLICT",
      containerProjectId: null,
      reason: "ambiguous_thread_binding",
      action: "FIX_RELATIONSHIP",
    });
  });

  it("case 40: a thread nothing binds is unbound, not guessed", async () => {
    const thread = randomUUID();
    const checkpointId = await makeCheckpoint({ threadId: thread, checkpoint: {} });

    const report = await inventory();
    const items = report.items.filter(
      (entry) => entry.sourceTable === "langgraph.checkpoints" && entry.rowId.includes(checkpointId),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      containerProof: "UNPROVEN",
      containerProjectId: null,
      reason: "unbound_thread",
      action: "KEEP_UNRESOLVED",
    });
  });

  it("case 41: legacy sessions with one shared project still give a weak binding", async () => {
    const project = await makeProject("w17-consensus");
    const session = await makeSession(project.canvasId, null);
    const thread = randomUUID();
    await makeRun(session, thread);
    const checkpointId = await makeCheckpoint({
      threadId: thread,
      checkpoint: { url: URL_WITH_TOKEN },
    });

    const report = await inventory();
    const items = report.items.filter((entry) => entry.rowId.includes(checkpointId));

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((entry) => entry.containerProof === "THREAD_AGENT_RUN_CONSENSUS")).toBe(true);
    expect(items.every((entry) => entry.containerProjectId === project.id)).toBe(true);
  });

  it("case 42: a json blob is decoded and its references are reported", async () => {
    const project = await makeProject("w17-blob-json");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const assetId = await makeAsset(project.id, `w17/${randomUUID()}.png`);
    const channel = `channel-${randomUUID().slice(0, 8)}`;
    await makeBlob({
      threadId: thread,
      channel,
      type: "json",
      blob: JSON.stringify({ output: { asset_id: assetId } }),
    });

    const report = await inventory();
    const items = report.items.filter(
      (entry) =>
        entry.sourceTable === "langgraph.checkpoint_blobs" && entry.rowId.includes(channel),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceColumn: "blob",
      pointer: "/output/asset_id",
      objectProof: "ASSET_ID_EXACT",
      containerProof: "THREAD_SESSION_EXACT",
    });
  });

  it("case 43: an empty serializer with a null blob is skipped, not reported", async () => {
    const project = await makeProject("w17-blob-empty");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const channel = `channel-${randomUUID().slice(0, 8)}`;
    await makeBlob({ threadId: thread, channel, type: "empty", blob: null });

    const report = await inventory();

    expect(
      report.items.filter(
        (entry) => entry.sourceTable === "langgraph.checkpoint_blobs" && entry.rowId.includes(channel),
      ),
    ).toHaveLength(0);
  });

  it("case 44: a bytes blob is an explicit human item, never a guess", async () => {
    const project = await makeProject("w17-blob-bytes");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const channel = `channel-${randomUUID().slice(0, 8)}`;
    await makeBlob({ threadId: thread, channel, type: "bytes", blob: new Uint8Array([0, 1, 2, 255]) });

    const report = await inventory();
    const items = report.items.filter((entry) => entry.rowId.includes(channel));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      reason: "opaque_binary",
      action: "REVIEW_DECODER_GAP",
      objectProof: "UNPROVEN",
      containerProof: "THREAD_SESSION_EXACT",
    });
    const scoped = buildReport(items);
    expect(scoped.summary.opaqueBinary).toBe(1);
    expect(exitCodeForReport(scoped)).toBe(1);
  });

  it("case 45: an unknown serializer makes the scan incomplete", async () => {
    const project = await makeProject("w17-blob-unknown");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const channel = `channel-${randomUUID().slice(0, 8)}`;
    await makeBlob({ threadId: thread, channel, type: "msgpack", blob: "anything" });

    const report = await inventory();
    const items = report.items.filter((entry) => entry.rowId.includes(channel));

    expect(items).toHaveLength(1);
    expect(items[0]?.reason).toBe("unsupported_encoding");
    expect(buildReport(items).complete).toBe(false);
    expect(exitCodeForReport(buildReport(items))).toBe(2);
    expect(report.complete).toBe(false);
  });

  it("case 46: broken UTF-8 and broken JSON in blobs are decode failures", async () => {
    const project = await makeProject("w17-blob-broken");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const badUtf8 = `channel-${randomUUID().slice(0, 8)}`;
    const badJson = `channel-${randomUUID().slice(0, 8)}`;
    await makeBlob({ threadId: thread, channel: badUtf8, type: "json", blob: new Uint8Array([0xff, 0xfe]) });
    await makeBlob({ threadId: thread, channel: badJson, type: "json", blob: "{oops" });

    const report = await inventory();
    const items = report.items.filter((entry) => entry.rowId.includes(badUtf8) || entry.rowId.includes(badJson));

    expect(items).toHaveLength(2);
    expect(items.every((entry) => entry.reason === "decode_failure")).toBe(true);
    expect(items.every((entry) => entry.action === "REVIEW_DECODER_GAP")).toBe(true);
    expect(buildReport(items).summary.decodeFailures).toBe(2);
    expect(exitCodeForReport(buildReport(items))).toBe(2);
  });

  it("case 47: checkpoint writes are a source of their own", async () => {
    const project = await makeProject("w17-writes");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const marker = `marker-${randomUUID().slice(0, 8)}`;
    await makeWrite({ threadId: thread, type: "json", blob: JSON.stringify({ url: `https://example.test/${marker}.png` }) });

    const report = await inventory();
    const items = report.items.filter(
      (entry) => entry.sourceTable === "langgraph.checkpoint_writes" && entry.rowId.includes(thread),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceColumn: "blob",
      pointer: "/url",
      objectProof: "UNPROVEN",
      containerProof: "THREAD_SESSION_EXACT",
    });
    expect(items[0]?.fingerprint).toBe(fingerprint(`https://example.test/${marker}.png`));
  });

  it("case 48: the checkpoints table's own JSONB columns are walked", async () => {
    const project = await makeProject("w17-checkpoint-jsonb");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const checkpointId = await makeCheckpoint({
      threadId: thread,
      checkpoint: { url: URL_WITH_TOKEN },
      metadata: { source: { object_path: "project-assets/ws/1/a.png" } },
    });

    const report = await inventory();
    const items = report.items.filter((entry) => entry.rowId.includes(checkpointId));

    expect(items.map((entry) => entry.sourceColumn).sort()).toEqual(["checkpoint", "metadata"]);
    expect(items.map((entry) => entry.pointer).sort()).toEqual(["/source/object_path", "/url"]);
    expect(items.every((entry) => entry.containerProjectId === project.id)).toBe(true);
  });

  it("case 49: a job whose clues converge is bound to that project", async () => {
    const project = await makeProject("w17-job-ok");
    const session = await makeSession(project.canvasId, randomUUID());
    const jobId = await makeJob({
      projectId: project.id,
      canvasId: project.canvasId,
      sessionId: session,
      result: { url: URL_WITH_TOKEN },
    });

    const items = itemsOf(await inventory(), jobId);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceTable: "public.background_jobs",
      sourceColumn: "result",
      pointer: "/url",
      containerProjectId: project.id,
      containerProof: "PROJECT_CHAIN_EXACT",
      objectProof: "UNPROVEN",
      reason: "asset_id_missing",
    });
  });

  it("case 50: a job whose clues disagree is a relation conflict", async () => {
    const projectA = await makeProject("w17-job-conflict-a");
    const projectB = await makeProject("w17-job-conflict-b");
    const jobId = await makeJob({
      projectId: projectA.id,
      canvasId: projectB.canvasId,
      result: { url: URL_WITH_TOKEN },
    });

    const report = await inventory();
    const items = itemsOf(report, jobId);

    expect(items.map((entry) => entry.reason).sort()).toEqual([
      "asset_id_missing",
      "job_relation_conflict",
    ]);
    const defect = items.find((entry) => entry.reason === "job_relation_conflict");
    expect(defect).toMatchObject({
      containerProof: "CONFLICT",
      containerProjectId: null,
      action: "FIX_RELATIONSHIP",
    });
  });

  it("case 51: a job with no clue at all is unbound, and workspace_id is never read", async () => {
    const jobId = await makeJob({ result: { url: URL_WITH_TOKEN } });

    const report = await inventory();
    const items = itemsOf(report, jobId);

    expect(items.map((entry) => entry.reason).sort()).toEqual([
      "asset_id_missing",
      "unbound_thread",
    ]);
    expect(items.every((entry) => entry.containerProjectId === null)).toBe(true);
    // `workspace_id` is a personal billing workspace; it says nothing about a project.
    const jobSql = executed.filter((sql) => sql.includes("background_jobs"));
    expect(jobSql.length).toBeGreaterThan(0);
    expect(jobSql.some((sql) => sql.includes("workspace_id"))).toBe(false);
  });

  it("case 52: every legacy canvases object is unbound, even with a project id in its name", async () => {
    const project = await makeProject("w17-legacy");
    const legacyName = `projects/${project.id}/screenshot-${randomUUID()}.png`;
    const objectId = await makeStorageObject(legacyName);
    const otherBucketPath = `w17/${randomUUID()}.png`;
    await makeAsset(project.id, otherBucketPath);

    const report = await inventory();
    const items = itemsOf(report, objectId);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceTable: "storage.objects",
      sourceColumn: "name",
      containerProjectId: null,
      containerProof: "UNPROVEN",
      assetId: null,
      objectProof: "UNPROVEN",
      reason: "legacy_canvases_object_unbound",
      action: "REVIEW_LEGACY_CANVASES_OBJECT",
      fingerprintKind: "object_name",
    });
    expect(items[0]?.fingerprint).toBe(fingerprint(legacyName));
    // Only the legacy bucket is inventoried here.
    expect(report.items.some((entry) => entry.rowId === fingerprint(otherBucketPath))).toBe(false);
    expect(serializeReport(report)).not.toContain(legacyName);
  });

  it("case 53: exactly pageSize + 1 rows are all seen exactly once", async () => {
    const project = await makeProject("w17-page-plus-one");
    const session = await makeSession(project.canvasId, randomUUID());
    const ids = [
      await makeMessage(session, [{ url: `https://example.test/p1-${randomUUID()}.png` }], null),
      await makeMessage(session, [{ url: `https://example.test/p2-${randomUUID()}.png` }], null),
      await makeMessage(session, [{ url: `https://example.test/p3-${randomUUID()}.png` }], null),
    ];

    const report = await inventory({ pageSize: 2 });

    for (const id of ids) expect(itemsOf(report, id)).toHaveLength(1);
  });

  it("case 54: 2 * pageSize + 1 rows across composite keys are all seen exactly once", async () => {
    const project = await makeProject("w17-page-double");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const checkpointIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      checkpointIds.push(
        await makeCheckpoint({
          threadId: thread,
          checkpoint: { url: `https://example.test/c${index}-${randomUUID()}.png` },
        }),
      );
    }

    const report = await inventory({ pageSize: 2 });

    for (const checkpointId of checkpointIds) {
      const items = report.items.filter((entry) => entry.rowId.includes(checkpointId));
      expect(items).toHaveLength(1);
      expect(items[0]?.containerProjectId).toBe(project.id);
    }
  });

  it("case 55: a repeated cursor key fails the whole scan", async () => {
    // A page that hands back the same key twice is the failure mode keyset
    // pagination exists to prevent; it must not be reported as a clean scan.
    const repeating: QueryExecutor = createReadOnlyExecutor({
      query: async (sql, params) => {
        const result = await baseExecutor.query(sql, params);
        if (sql.includes("content_blocks") && result.rows.length > 0) {
          return { rows: [result.rows[0] as Record<string, unknown>, ...result.rows] };
        }
        return result;
      },
    });

    await expect(runHistoryReferenceInventory(repeating, { pageSize: 2 })).rejects.toThrow(
      PaginationError,
    );
  });

  it("case 56: a failed scan is rolled back and never committed", async () => {
    const seen: string[] = [];
    const failing: QueryExecutor = createReadOnlyExecutor({
      query: async (sql, params) => {
        seen.push(sql.trim().split(/\s+/)[0] ?? "");
        if (sql.includes("from public.projects")) throw new Error("read failed");
        return baseExecutor.query(sql, params);
      },
    });

    await expect(runHistoryReferenceInventory(failing, {})).rejects.toThrow(/read failed/);
    expect(seen).toContain("ROLLBACK");
    expect(seen).not.toContain("COMMIT");
  });

  it("case 57: a full scan sends only allowlisted, single, read-only statements", async () => {
    await inventory({ pageSize: 3 });

    expect(executed.length).toBeGreaterThan(20);
    for (const sql of executed) {
      expect(() => assertReadOnlyStatement(sql)).not.toThrow();
    }

    const keywords = new Set(
      executed.map((sql) => (/^\s*([A-Za-z]+)/.exec(sql)?.[1] ?? "").toLowerCase()),
    );
    expect([...keywords].sort()).toEqual(["begin", "commit", "select", "set"]);

    const forbidden = /\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|call|copy|vacuum|rpc|do)\b/i;
    const offenders = executed.filter((sql) => forbidden.test(sql));
    expect(offenders).toEqual([]);
    expect(executed.some((sql) => /storage\.objects\s+(insert|update|delete)/i.test(sql))).toBe(false);
  });

  it("case 58: an anon identity sees nothing, so the tool needs a real role", async () => {
    const hidden = await asUser(db, null, (tx) =>
      tx.query<{ n: number }>("select count(*)::int as n from public.chat_messages"),
    );
    expect(firstRow(hidden.rows).n).toBe(0);
  });

  it("case 59: the whole report is redaction-safe end to end", async () => {
    const report = await inventory();
    const json = serializeReport(report);

    expect(() => assertRedactionSafe(json)).not.toThrow();
    expect(isRedactionSafe(json)).toBe(true);
    expect(json).not.toContain("example.test");
    expect(json).not.toContain("token=");
    expect(JSON.parse(json)).toMatchObject({ schemaVersion: 1, mode: "read-only" });

    // The bucket constant is asserted here so the SQL literal cannot drift.
    expect(LEGACY_CANVASES_BUCKET).toBe("canvases");
    expect(executed.some((sql) => sql.includes("bucket_id = $1"))).toBe(true);
  });

  /* ---------------------------------------------------------------- */
  /* F1 — a job clue that cannot be resolved is not convergence        */
  /* ---------------------------------------------------------------- */

  it("case 60: a job with a resolved project and an unknown thread is a conflict", async () => {
    // The counter-example the ticket named: before the fix this returned
    // PROJECT_CHAIN_EXACT for the project and silently dropped the thread.
    const project = await makeProject("w17-job-unknown-thread");
    const jobId = await makeJob({
      projectId: project.id,
      threadId: `thread-${randomUUID()}`,
      result: { url: URL_WITH_TOKEN },
    });

    const items = itemsOf(await inventory(), jobId);

    expect(items.map((entry) => entry.reason).sort()).toEqual([
      "asset_id_missing",
      "job_relation_conflict",
    ]);
    const defect = items.find((entry) => entry.reason === "job_relation_conflict");
    expect(defect).toMatchObject({
      sourceTable: "public.background_jobs",
      sourceColumn: "project_id",
      pointer: null,
      containerProof: "CONFLICT",
      containerProjectId: null,
      objectProof: "UNPROVEN",
      action: "FIX_RELATIONSHIP",
    });
    // The reference is still reported — with a container that proves nothing.
    expect(items.find((entry) => entry.reason === "asset_id_missing")).toMatchObject({
      containerProof: "CONFLICT",
      containerProjectId: null,
      action: "REVIEW_REFERENCE",
    });
    const scoped = buildReport(items);
    expect(scoped.summary.conflicts).toBeGreaterThan(0);
    expect(exitCodeForReport(scoped)).toBe(1);
  });

  it("case 61: a job whose canvas cannot be resolved is a conflict, not a proven project", async () => {
    const project = await makeProject("w17-job-blind-canvas");
    const jobId = await makeJob({
      projectId: project.id,
      canvasId: project.canvasId,
      result: { url: URL_WITH_TOKEN },
    });

    // The canvas row is hidden from the scan, so that clue cannot be resolved.
    const blind: QueryExecutor = createReadOnlyExecutor({
      query: async (sql, params) => {
        const result = await baseExecutor.query(sql, params);
        return sql.includes("from public.canvases") ? { rows: [] } : result;
      },
    });

    const items = itemsOf(await runHistoryReferenceInventory(blind, {}), jobId);

    expect(items.map((entry) => entry.reason).sort()).toEqual([
      "asset_id_missing",
      "job_relation_conflict",
    ]);
    expect(items.find((entry) => entry.reason === "job_relation_conflict")).toMatchObject({
      containerProof: "CONFLICT",
      containerProjectId: null,
      action: "FIX_RELATIONSHIP",
    });
  });

  it("case 62: a job whose session chain is broken is a conflict", async () => {
    const project = await makeProject("w17-job-broken-session");
    const session = await makeSession(project.canvasId, randomUUID());
    const jobId = await makeJob({
      projectId: project.id,
      sessionId: session,
      result: { url: URL_WITH_TOKEN },
    });

    const blind: QueryExecutor = createReadOnlyExecutor({
      query: async (sql, params) => {
        const result = await baseExecutor.query(sql, params);
        return sql.includes("from public.canvases") ? { rows: [] } : result;
      },
    });

    const items = itemsOf(await runHistoryReferenceInventory(blind, {}), jobId);

    expect(items.map((entry) => entry.reason).sort()).toEqual([
      "asset_id_missing",
      "job_relation_conflict",
    ]);
    expect(items.find((entry) => entry.reason === "job_relation_conflict")).toMatchObject({
      containerProof: "CONFLICT",
      containerProjectId: null,
      action: "FIX_RELATIONSHIP",
    });
  });

  it("case 63: a job whose four clues all converge keeps the explicit proof", async () => {
    const project = await makeProject("w17-job-converge");
    const thread = randomUUID();
    const session = await makeSession(project.canvasId, thread);
    await makeRun(session, thread);
    const jobId = await makeJob({
      projectId: project.id,
      canvasId: project.canvasId,
      sessionId: session,
      threadId: thread,
      result: { url: URL_WITH_TOKEN },
    });

    const items = itemsOf(await inventory(), jobId);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceColumn: "result",
      pointer: "/url",
      reason: "asset_id_missing",
      containerProof: "PROJECT_CHAIN_EXACT",
      containerProjectId: project.id,
      objectProof: "UNPROVEN",
    });
  });

  it("case 64: a job with no clue at all stays unbound instead of conflicted", async () => {
    const jobId = await makeJob({ result: { url: URL_WITH_TOKEN } });

    const items = itemsOf(await inventory(), jobId);

    expect(items.map((entry) => entry.reason).sort()).toEqual([
      "asset_id_missing",
      "unbound_thread",
    ]);
    const defect = items.find((entry) => entry.reason === "unbound_thread");
    expect(defect).toMatchObject({
      pointer: null,
      containerProof: "UNPROVEN",
      containerProjectId: null,
      action: "KEEP_UNRESOLVED",
    });
    expect(items.some((entry) => entry.reason === "job_relation_conflict")).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* F2 — the declared serializer decides, and NULL is not json        */
  /* ---------------------------------------------------------------- */

  it("case 65: a checkpoint_writes row typed NULL is unsupported even when its blob is JSON", async () => {
    const project = await makeProject("w17-writes-null-type");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const assetId = await makeAsset(project.id, `w17/${randomUUID()}.png`);
    await makeWrite({
      threadId: thread,
      type: null,
      blob: JSON.stringify({ output: { asset_id: assetId } }),
    });

    const report = await inventory();
    const items = report.items.filter(
      (entry) =>
        entry.sourceTable === "langgraph.checkpoint_writes" && entry.rowId.includes(thread),
    );

    // The bytes happen to be readable JSON. That still proves nothing about the
    // serializer, so no reference may be claimed out of them.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceColumn: "blob",
      pointer: null,
      assetId: null,
      fingerprint: null,
      reason: "unsupported_encoding",
      action: "REVIEW_DECODER_GAP",
      objectProof: "UNPROVEN",
      containerProof: "THREAD_SESSION_EXACT",
    });
    const scoped = buildReport(items);
    expect(scoped.summary.unsupportedEncodings).toBe(1);
    expect(scoped.summary.referencesScanned).toBe(0);
    expect(scoped.complete).toBe(false);
    expect(exitCodeForReport(scoped)).toBe(2);
    expect(report.complete).toBe(false);
  });

  it("case 66: a bytes-typed checkpoints row reports the gap and still walks its JSONB", async () => {
    const project = await makeProject("w17-checkpoint-bytes-type");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const checkpointId = await makeCheckpoint({
      threadId: thread,
      type: "bytes",
      checkpoint: { url: URL_WITH_TOKEN },
    });

    const report = await inventory();
    const items = report.items.filter((entry) => entry.rowId.includes(checkpointId));

    expect(items.map((entry) => entry.reason).sort()).toEqual([
      "asset_id_missing",
      "opaque_binary",
    ]);
    expect(items.find((entry) => entry.reason === "opaque_binary")).toMatchObject({
      sourceColumn: "checkpoint",
      pointer: null,
      action: "REVIEW_DECODER_GAP",
      containerProof: "THREAD_SESSION_EXACT",
      containerProjectId: project.id,
    });
    // The visible JSONB is independent evidence and is still reported.
    expect(items.find((entry) => entry.reason === "asset_id_missing")).toMatchObject({
      sourceColumn: "checkpoint",
      pointer: "/url",
      containerProjectId: project.id,
    });
    const scoped = buildReport(items);
    expect(scoped.summary.opaqueBinary).toBe(1);
    expect(scoped.complete).toBe(true);
    expect(exitCodeForReport(scoped)).toBe(1);
  });

  it("case 67: an unknown-typed checkpoints row reports the gap and stays incomplete", async () => {
    const project = await makeProject("w17-checkpoint-unknown-type");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const checkpointId = await makeCheckpoint({
      threadId: thread,
      type: "msgpack",
      checkpoint: { url: URL_WITH_TOKEN },
    });

    const report = await inventory();
    const items = report.items.filter((entry) => entry.rowId.includes(checkpointId));

    expect(items.map((entry) => entry.reason).sort()).toEqual([
      "asset_id_missing",
      "unsupported_encoding",
    ]);
    expect(items.find((entry) => entry.reason === "unsupported_encoding")).toMatchObject({
      sourceColumn: "checkpoint",
      pointer: null,
      action: "REVIEW_DECODER_GAP",
    });
    expect(items.find((entry) => entry.reason === "asset_id_missing")).toMatchObject({
      sourceColumn: "checkpoint",
      pointer: "/url",
      containerProjectId: project.id,
    });
    const scoped = buildReport(items);
    expect(scoped.summary.unsupportedEncodings).toBe(1);
    expect(scoped.complete).toBe(false);
    expect(exitCodeForReport(scoped)).toBe(2);
  });

  it("case 68: a NULL-typed checkpoints row is unsupported and its JSONB is still walked", async () => {
    const project = await makeProject("w17-checkpoint-null-type");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const checkpointId = await makeCheckpoint({
      threadId: thread,
      type: null,
      checkpoint: { url: URL_WITH_TOKEN },
    });

    const report = await inventory();
    const items = report.items.filter((entry) => entry.rowId.includes(checkpointId));

    expect(items.map((entry) => entry.reason).sort()).toEqual([
      "asset_id_missing",
      "unsupported_encoding",
    ]);
    expect(items.find((entry) => entry.reason === "unsupported_encoding")).toMatchObject({
      sourceColumn: "checkpoint",
      pointer: null,
      action: "REVIEW_DECODER_GAP",
    });
    expect(items.find((entry) => entry.reason === "asset_id_missing")?.pointer).toBe("/url");
    const scoped = buildReport(items);
    expect(scoped.complete).toBe(false);
    expect(exitCodeForReport(scoped)).toBe(2);
  });

  /* ---------------------------------------------------------------- */
  /* F3 — explicit object-name keys are candidates                     */
  /* ---------------------------------------------------------------- */

  it("case 69: object-name keys are found by name, and a generic `name` key is not", () => {
    const bare = `render-${randomUUID()}.png`;
    const nested = `${randomUUID()}/nested-${randomUUID()}.png`;
    const upper = `UPPER-${randomUUID()}.PNG`;
    const dashed = `dashed-${randomUUID()}.png`;
    const plain = `plain-${randomUUID()}.png`;
    const found: Array<{
      pointer: string;
      assetId: string | null;
      kind: string | null;
      fingerprint: string | null;
    }> = [];

    collectReferences(
      {
        object: {
          objectName: bare,
          object_name: nested,
          fileName: plain,
          file_name: dashed,
          filename: upper,
        },
        tool: { name: "generate_image", displayName: "Generate Image" },
        inline: { fileName: "data:image/png;base64,AAAA" },
      },
      (discovery) =>
        found.push({
          pointer: discovery.pointer,
          assetId: discovery.assetId,
          kind: discovery.fingerprintKind,
          fingerprint: discovery.fingerprint,
        }),
    );

    expect(found).toHaveLength(5);
    expect(found.map((entry) => entry.pointer).sort()).toEqual([
      "/object/fileName",
      "/object/file_name",
      "/object/filename",
      "/object/objectName",
      "/object/object_name",
    ]);
    for (const entry of found) {
      expect(entry.kind).toBe("object_name");
      expect(entry.assetId).toBeNull();
      expect(entry.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(found.find((entry) => entry.pointer === "/object/objectName")?.fingerprint).toBe(
      fingerprint(bare),
    );
    expect(found.find((entry) => entry.pointer === "/object/object_name")?.fingerprint).toBe(
      fingerprint(nested),
    );
    // A bare `name` is a model / tool name far more often than an object name.
    expect(found.some((entry) => entry.pointer.startsWith("/tool"))).toBe(false);
    // A data URL is an inline payload, never an object name.
    expect(found.some((entry) => entry.pointer.startsWith("/inline"))).toBe(false);
  });

  it("case 70: an object name in a message column never becomes an object proof", async () => {
    const project = await makeProject("w17-object-name-message");
    const session = await makeSession(project.canvasId, randomUUID());
    const contentName = `content-${randomUUID()}.png`;
    const toolName = `tool-${randomUUID()}.png`;
    const message = await makeMessage(
      session,
      [{ type: "image", objectName: contentName }],
      [{ name: "generate_image", output: { file_name: toolName } }],
    );

    const report = await inventory();
    const items = itemsOf(report, message);

    expect(items).toHaveLength(2);
    expect(items.map((entry) => entry.sourceColumn).sort()).toEqual([
      "content_blocks",
      "tool_activities",
    ]);
    expect(items.map((entry) => entry.pointer).sort()).toEqual(["/0/objectName", "/0/output/file_name"]);
    expect(items.every((entry) => entry.fingerprintKind === "object_name")).toBe(true);
    expect(items.every((entry) => entry.assetId === null)).toBe(true);
    expect(items.every((entry) => entry.objectProof === "UNPROVEN")).toBe(true);
    expect(items.every((entry) => entry.reason === "asset_id_missing")).toBe(true);
    expect(items.every((entry) => entry.containerProof === "PROJECT_CHAIN_EXACT")).toBe(true);
    expect(items.some((entry) => entry.fingerprint === fingerprint(contentName))).toBe(true);
    expect(items.some((entry) => entry.fingerprint === fingerprint(toolName))).toBe(true);

    const json = serializeReport(report);
    expect(json).not.toContain(contentName);
    expect(json).not.toContain(toolName);
  });

  it("case 71: object names in a checkpoint and in a job are candidates too", async () => {
    const project = await makeProject("w17-object-name-misc");
    const thread = randomUUID();
    await makeSession(project.canvasId, thread);
    const checkpointName = `checkpoint-${randomUUID()}.png`;
    const jobName = `job-${randomUUID()}.png`;
    const checkpointId = await makeCheckpoint({
      threadId: thread,
      metadata: { attachment: { fileName: checkpointName } },
      checkpoint: {},
    });
    const jobId = await makeJob({
      projectId: project.id,
      result: { artefacts: [{ object_name: jobName }] },
    });

    const report = await inventory();
    const checkpointItems = report.items.filter((entry) => entry.rowId.includes(checkpointId));
    const jobItems = itemsOf(report, jobId);

    expect(checkpointItems).toHaveLength(1);
    expect(checkpointItems[0]).toMatchObject({
      sourceTable: "langgraph.checkpoints",
      sourceColumn: "metadata",
      pointer: "/attachment/fileName",
      fingerprintKind: "object_name",
      assetId: null,
      objectProof: "UNPROVEN",
      reason: "asset_id_missing",
      containerProof: "THREAD_SESSION_EXACT",
      containerProjectId: project.id,
    });
    expect(checkpointItems[0]?.fingerprint).toBe(fingerprint(checkpointName));

    expect(jobItems).toHaveLength(1);
    expect(jobItems[0]).toMatchObject({
      sourceTable: "public.background_jobs",
      sourceColumn: "result",
      pointer: "/artefacts/0/object_name",
      fingerprintKind: "object_name",
      assetId: null,
      objectProof: "UNPROVEN",
      reason: "asset_id_missing",
      containerProof: "PROJECT_CHAIN_EXACT",
      containerProjectId: project.id,
    });
    expect(jobItems[0]?.fingerprint).toBe(fingerprint(jobName));

    const json = serializeReport(report);
    expect(json).not.toContain(checkpointName);
    expect(json).not.toContain(jobName);
  });

  /* ---------------------------------------------------------------- */
  /* F4 — dedup stops at the container defect                          */
  /* ---------------------------------------------------------------- */

  it("case 72: one broken container is one defect, but two columns are two references", async () => {
    const project = await makeProject("w17-dedup-boundary");
    const session = await makeSession(project.canvasId, randomUUID());
    const message = await makeMessage(
      session,
      [{ type: "image", url: URL_WITH_TOKEN }],
      [{ name: "generate_image", output: { url: URL_WITH_TOKEN } }],
    );

    const blind: QueryExecutor = createReadOnlyExecutor({
      query: async (sql, params) => {
        const result = await baseExecutor.query(sql, params);
        return sql.includes("from public.canvases") ? { rows: [] } : result;
      },
    });

    const items = itemsOf(await runHistoryReferenceInventory(blind, {}), message);

    expect(items.filter((entry) => entry.reason === "broken_container_chain")).toHaveLength(1);
    const references = items.filter((entry) => entry.reason === "asset_id_missing");
    expect(references).toHaveLength(2);
    expect(references.map((entry) => entry.sourceColumn).sort()).toEqual([
      "content_blocks",
      "tool_activities",
    ]);
    expect(references.map((entry) => entry.pointer).sort()).toEqual(["/0/output/url", "/0/url"]);
    // The same URL on both sides is still two hits: identical fingerprints are
    // never merged into one item.
    expect(new Set(references.map((entry) => entry.fingerprint)).size).toBe(1);
    expect(items.every((entry) => entry.containerProof === "UNPROVEN")).toBe(true);
  });

  it("case 73: only container defects are deduplicated, never references", () => {
    const defect = item({
      reason: "broken_container_chain",
      action: "FIX_RELATIONSHIP",
      pointer: null,
      containerProof: "UNPROVEN",
      containerProjectId: null,
      fingerprint: null,
      fingerprintKind: null,
    });
    const reference = item({});

    const report = buildReport([defect, defect, reference, item({})]);

    expect(report.items.filter((entry) => entry.reason === "broken_container_chain")).toHaveLength(1);
    // Two byte-identical reference items stay two items.
    expect(report.items.filter((entry) => entry.reason === "asset_id_missing")).toHaveLength(2);
    expect(report.summary.referencesScanned).toBe(2);
  });
});
