/**
 * X-52 phase 1B (T-23): read-only inventory of historical references to stored objects.
 *
 * Usage:
 *   node --env-file=../../.env.local --import tsx src/cli/hahart-history-reference-inventory.ts
 *   node --env-file=../../.env.local --import tsx src/cli/hahart-history-reference-inventory.ts --page-size 500
 *
 * WHY THIS EXISTS
 * Before the private-bucket cutover (X-52 工单15) somebody has to answer two
 * questions about history that no single table answers:
 *   1. CONTAINER OWNERSHIP — can a chat message, an agent checkpoint or a job be
 *      PROVEN to belong to a project?
 *   2. OBJECT BINDING — does the reference inside it point at a row in
 *      `asset_objects`?
 * Those are two different facts and they are reported separately. A URL that sits
 * inside project A's message proves the MESSAGE is A's; it proves nothing about
 * the object the URL points at. A URL, an object path or an object name may be
 * equal to something in another project, and that is still not ownership, so it
 * only ever becomes a truncated fingerprint here.
 *
 * READ-ONLY BY CONSTRUCTION
 *   - Every statement runs inside `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`
 *     with `SET LOCAL statement_timeout`. The database itself refuses writes
 *     inside that transaction.
 *   - On top of that, every statement text is checked against a statement
 *     allowlist (BEGIN / SET / SELECT / COMMIT / ROLLBACK only, one statement per
 *     call) before it reaches the driver, so a mistake here cannot even be sent.
 *   - There is no `--apply`, no RPC call, no Storage write and no auto-fix. The
 *     only output is a report a human reads.
 *
 * COMPLETENESS
 * Every source is read with keyset pagination (never OFFSET). Each page asks for
 * `pageSize + 1` rows so "more to come" is a fact, not a guess, and the keys are
 * required to be strictly increasing across the whole scan. A repeated key is a
 * pagination bug, not a duplicate row, so it fails the whole run: a partial
 * report that looks complete is worse than no report.
 *
 * WHAT IS NEVER PRINTED
 * No URL, host, path, query, token, message body, prompt, tool input/output,
 * blob, base64 payload, user id, email, connection string or key. References are
 * reduced to a truncated SHA-256 fingerprint, JSON Pointers replace opaque object
 * keys with a fingerprint, and the finished JSON is checked against a deny-list
 * before it is allowed onto stdout.
 *
 * EXIT CODES
 *   0 — complete scan, nothing unresolved, nothing conflicted
 *   1 — complete scan, but items a human must look at (unresolved / conflict /
 *       opaque binary blob)
 *   2 — arguments, read, pagination, decode completeness or redaction failed
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import pg from "pg";

/* ------------------------------------------------------------------ */
/* Fixed vocabularies                                                  */
/* ------------------------------------------------------------------ */

/** How a container (message / checkpoint / job) was tied to a project. */
export const CONTAINER_PROOFS = [
  "PROJECT_CHAIN_EXACT",
  "THREAD_SESSION_EXACT",
  "THREAD_AGENT_RUN_CONSENSUS",
  "UNPROVEN",
  "CONFLICT",
] as const;
export type ContainerProof = (typeof CONTAINER_PROOFS)[number];

/** How a reference was tied to a stored object. Nothing else may be used. */
export const OBJECT_PROOFS = ["ASSET_ID_EXACT", "UNPROVEN", "CONFLICT"] as const;
export type ObjectProof = (typeof OBJECT_PROOFS)[number];

/** What a human may be told to do. Deliberately contains no "apply" step. */
export const ACTIONS = [
  "NONE",
  "REVIEW_REFERENCE",
  "BACKFILL_ASSET_ID_AFTER_MANUAL_PROOF",
  "FIX_RELATIONSHIP",
  "KEEP_UNRESOLVED",
  "REVIEW_LEGACY_CANVASES_OBJECT",
  "REVIEW_DECODER_GAP",
] as const;
export type InventoryAction = (typeof ACTIONS)[number];

/** Why an item is in the report. */
export const REASONS = [
  "asset_id_exact",
  "asset_id_missing",
  "asset_row_missing",
  "asset_project_unassigned",
  "asset_project_conflict",
  "broken_container_chain",
  "run_session_thread_mismatch",
  "ambiguous_thread_binding",
  "unbound_thread",
  "job_relation_conflict",
  "legacy_canvases_object_unbound",
  "opaque_binary",
  "unsupported_encoding",
  "decode_failure",
] as const;
export type InventoryReason = (typeof REASONS)[number];

export type FingerprintKind = "url" | "object_path" | "object_name";

/** The legacy public bucket: its objects have no provable `asset_objects` owner. */
export const LEGACY_CANVASES_BUCKET = "canvases";

export type InventoryItem = {
  sourceTable: string;
  sourceColumn: string;
  /** Stable, locatable row identity (composite keys are joined with `|`). */
  rowId: string;
  /** JSON Pointer into the scanned value; null when the item is not a JSON reference. */
  pointer: string | null;
  containerProjectId: string | null;
  containerProof: ContainerProof;
  assetId: string | null;
  objectProof: ObjectProof;
  reason: InventoryReason;
  action: InventoryAction;
  /** Truncated SHA-256 of the original value — the original is never emitted. */
  fingerprint: string | null;
  fingerprintKind: FingerprintKind | null;
};

export type InventorySummary = {
  referencesScanned: number;
  exactBindings: number;
  unresolved: number;
  conflicts: number;
  opaqueBinary: number;
  decodeFailures: number;
  /** Extra counter: these force exit code 2 (the scan could not be trusted). */
  unsupportedEncodings: number;
};

export type InventoryReport = {
  schemaVersion: 1;
  mode: "read-only";
  complete: boolean;
  summary: InventorySummary;
  items: InventoryItem[];
};

const REFERENCE_REASONS: readonly InventoryReason[] = [
  "asset_id_exact",
  "asset_id_missing",
  "asset_row_missing",
  "asset_project_unassigned",
  "asset_project_conflict",
];

/* ------------------------------------------------------------------ */
/* Argument parsing                                                    */
/* ------------------------------------------------------------------ */

export const DEFAULT_PAGE_SIZE = 200;
export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 1000;

export class UsageError extends Error {}

export type InventoryOptions = { pageSize: number };

export const USAGE_TEXT = [
  "hahart-history-reference-inventory — read-only inventory of historical asset references.",
  "",
  "Usage:",
  "  node --env-file=../../.env.local --import tsx src/cli/hahart-history-reference-inventory.ts [options]",
  "",
  "Options:",
  `  --page-size <${MIN_PAGE_SIZE}..${MAX_PAGE_SIZE}>   keyset page size (default ${DEFAULT_PAGE_SIZE})`,
  "  --help                                  print this text on stderr",
  "",
  "This tool is READ-ONLY. It opens one REPEATABLE READ READ ONLY transaction, runs",
  "SELECT statements only, and writes its report to stdout as a single JSON document.",
  "There is no writable mode and no repair step.",
].join("\n");

function parsePageSize(raw: string | undefined): number {
  if (raw === undefined) throw new UsageError("--page-size requires a value");
  if (!/^[0-9]+$/.test(raw)) throw new UsageError("--page-size must be an integer");
  const value = Number.parseInt(raw, 10);
  if (value < MIN_PAGE_SIZE || value > MAX_PAGE_SIZE) {
    throw new UsageError(`--page-size must be between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`);
  }
  return value;
}

/**
 * Only `--page-size` and `--help` exist. `--apply` is not merely ignored: it is
 * rejected, so a phase-1B inventory can never be turned into a write entry point.
 */
export function parseArgs(argv: readonly string[]): InventoryOptions {
  let pageSize = DEFAULT_PAGE_SIZE;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") throw new UsageError("help requested");
    if (argument === "--page-size") {
      pageSize = parsePageSize(argv[index + 1]);
      index += 1;
      continue;
    }
    if (argument !== undefined && argument.startsWith("--page-size=")) {
      pageSize = parsePageSize(argument.slice("--page-size=".length));
      continue;
    }
    // The rejected value is not echoed: an argument can be a URL or a token.
    throw new UsageError(
      argument !== undefined && /^--?[A-Za-z-]{1,32}$/.test(argument)
        ? `unsupported argument: ${argument}`
        : "unsupported argument",
    );
  }

  return { pageSize };
}

/* ------------------------------------------------------------------ */
/* Query plumbing: allowlist + keyset pagination                       */
/* ------------------------------------------------------------------ */

export type QueryResult = { rows: Array<Record<string, unknown>> };

export type QueryExecutor = {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResult>;
};

export class StatementNotAllowedError extends Error {}

export class PaginationError extends Error {}

export class RedactionError extends Error {}

const ALLOWED_STATEMENTS = ["begin", "set", "select", "commit", "rollback"] as const;

/**
 * A SELECT can still write: `select some_rpc(...)` runs a function, and
 * `select ... into` creates a table. Neither belongs in this scan, and this tool
 * never needs one, so both are refused rather than reasoned about.
 */
const SCHEMA_QUALIFIED_CALL =
  /\b(public|private|auth|storage|extensions|pg_catalog|information_schema|langgraph)\s*\.\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/i;
const SELECT_INTO = /\binto\b/i;

/** Strip leading `--` line comments and `/* *\/` block comments before matching. */
function stripLeadingComments(sql: string): string {
  let rest = sql;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) {
      const newline = trimmed.indexOf("\n");
      if (newline === -1) return "";
      rest = trimmed.slice(newline + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end === -1) return "";
      rest = trimmed.slice(end + 2);
      continue;
    }
    return trimmed;
  }
}

/**
 * The database statement allowlist. One statement per call, and its first
 * keyword must be BEGIN / SET / SELECT / COMMIT / ROLLBACK.
 *
 * The read-only transaction is the real guard (PostgreSQL refuses the write);
 * this is the second one, and it is the one a unit test can pin down.
 */
export function assertReadOnlyStatement(sql: string): void {
  const stripped = stripLeadingComments(sql);
  if (stripped.length === 0) throw new StatementNotAllowedError("empty statement");

  const keywordMatch = /^([A-Za-z]+)/.exec(stripped);
  const keyword = keywordMatch?.[1]?.toLowerCase();
  if (keyword === undefined) throw new StatementNotAllowedError("statement has no leading keyword");
  if (!(ALLOWED_STATEMENTS as readonly string[]).includes(keyword)) {
    throw new StatementNotAllowedError(`statement not allowed: ${keyword}`);
  }

  const withoutTrailing = stripped.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    throw new StatementNotAllowedError("multiple statements are not allowed in one call");
  }

  if (keyword === "select") {
    if (SCHEMA_QUALIFIED_CALL.test(withoutTrailing)) {
      throw new StatementNotAllowedError("a read-only scan may not call a function");
    }
    if (SELECT_INTO.test(withoutTrailing)) {
      throw new StatementNotAllowedError("SELECT ... INTO writes a table and is not allowed");
    }
  }
}

/** Wraps a driver so nothing reaches it without passing the allowlist. */
export function createReadOnlyExecutor(client: QueryExecutor): QueryExecutor {
  return {
    async query(sql: string, params?: readonly unknown[]): Promise<QueryResult> {
      assertReadOnlyStatement(sql);
      return client.query(sql, params);
    },
  };
}

type SourceQuery = { text: string; values: unknown[] };

/**
 * `select <columns> from <table> [where ...] and (keys...) > (...) order by keys limit n`.
 *
 * Extra (constant) predicates come first so the placeholder numbering is stable.
 */
export function buildKeysetQuery(options: {
  table: string;
  columns: string;
  keyColumns: readonly string[];
  cursor: readonly unknown[] | null;
  limit: number;
  extraWhere?: string;
  extraValues?: readonly unknown[];
}): SourceQuery {
  const values: unknown[] = [...(options.extraValues ?? [])];
  const conditions: string[] = [];
  if (options.extraWhere !== undefined) conditions.push(options.extraWhere);

  if (options.cursor !== null) {
    const placeholders = options.keyColumns.map((_, index) => `$${values.length + index + 1}`);
    conditions.push(`(${options.keyColumns.join(", ")}) > (${placeholders.join(", ")})`);
    values.push(...options.cursor);
  }

  values.push(options.limit);
  const limitPlaceholder = `$${values.length}`;
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";

  return {
    text:
      `select ${options.columns} from ${options.table} ${where} ` +
      `order by ${options.keyColumns.join(", ")} limit ${limitPlaceholder}`,
    values,
  };
}

function compareKeyPart(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
  if (typeof left === "bigint" && typeof right === "bigint") return left < right ? -1 : 1;
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : 1;
  throw new PaginationError("keyset cursor type changed between pages");
}

function compareKeys(left: readonly unknown[], right: readonly unknown[]): number {
  if (left.length !== right.length) throw new PaginationError("keyset cursor arity changed");
  for (let index = 0; index < left.length; index += 1) {
    const verdict = compareKeyPart(left[index], right[index]);
    if (verdict !== 0) return verdict;
  }
  return 0;
}

/**
 * Read one source completely. Returns the number of rows handled.
 *
 * The cursor is required to move strictly forward: a page whose first key is not
 * greater than the previous page's last key would repeat or drop rows, so it
 * fails the run instead of producing a report that claims to be complete.
 */
async function scanKeyset(options: {
  label: string;
  executor: QueryExecutor;
  pageSize: number;
  build: (cursor: readonly unknown[] | null, limit: number) => SourceQuery;
  keyOf: (row: Record<string, unknown>) => readonly unknown[];
  handle: (row: Record<string, unknown>) => void | Promise<void>;
}): Promise<number> {
  let cursor: readonly unknown[] | null = null;
  let scanned = 0;

  for (;;) {
    const page = options.build(cursor, options.pageSize + 1);
    const result = await options.executor.query(page.text, page.values);
    const rows = result.rows;
    const hasMore = rows.length > options.pageSize;
    const current = hasMore ? rows.slice(0, options.pageSize) : rows;

    for (const row of current) {
      const key = options.keyOf(row);
      if (cursor !== null && compareKeys(key, cursor) <= 0) {
        throw new PaginationError(
          `${options.label}: keyset cursor did not advance — pagination would repeat or skip rows`,
        );
      }
      await options.handle(row);
      cursor = key;
      scanned += 1;
    }

    if (!hasMore) return scanned;
  }
}

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

/** Case-insensitive deny-list applied to the finished report and to stderr text. */
export const DENY_LIST = ["http://", "https://", "token=", "eyj", "base64,"] as const;

export function isRedactionSafe(text: string): boolean {
  const lowered = text.toLowerCase();
  return !DENY_LIST.some((token) => lowered.includes(token));
}

/** Throws when the finished report would carry a value it must never carry. */
export function assertRedactionSafe(text: string): void {
  const lowered = text.toLowerCase();
  for (const token of DENY_LIST) {
    if (lowered.includes(token)) {
      throw new RedactionError(
        `report failed the redaction deny-list (token index ${DENY_LIST.indexOf(token)}); refusing to write it`,
      );
    }
  }
}

/** Truncated SHA-256 — a locator for a human, never the value itself. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:\-]{1,200}$/;
const SAFE_POINTER_SEGMENT = /^[A-Za-z0-9_~\-]{1,64}$/;

/** Row identities stay readable when they look like ids; anything else is hashed. */
export function sanitizeIdentifier(value: string): string {
  return SAFE_IDENTIFIER.test(value) ? value : `#${fingerprint(value)}`;
}

/** A JSON Pointer segment, or a fingerprint when the key itself could leak. */
export function sanitizePointerSegment(segment: string): string {
  if (!SAFE_POINTER_SEGMENT.test(segment)) return `#${fingerprint(segment)}`;
  return segment.replace(/~/g, "~0");
}

/* ------------------------------------------------------------------ */
/* Reference discovery                                                 */
/* ------------------------------------------------------------------ */

export type Discovery = {
  pointer: string;
  assetId: string | null;
  fingerprint: string | null;
  fingerprintKind: FingerprintKind | null;
};

/** Keys whose string value is a stored-object reference (fingerprint only). */
const REFERENCE_KEYS = new Set([
  "url",
  "link",
  "href",
  "uri",
  "src",
  "signed_url",
  "signedUrl",
  "public_url",
  "publicUrl",
  "object_path",
  "objectPath",
  "storage_path",
  "storagePath",
  "path",
  "file_path",
  "filePath",
]);

const URL_LIKE = /^https?:\/\//i;
const SCHEME_LIKE = /^(oss|s3|gs|storage):\/\//i;

/** `bucket/key`-shaped and not prose: a candidate, never a proof. */
function isPathLike(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  if (/\s/.test(value)) return false;
  if (value.includes("://")) return false;
  return value.includes("/");
}

export function fingerprintKindFor(value: string): FingerprintKind | null {
  if (URL_LIKE.test(value)) return "url";
  if (SCHEME_LIKE.test(value)) return "object_path";
  if (isPathLike(value)) return "object_path";
  return null;
}

function discoveryForEntry(key: string, value: unknown, pointer: string): Discovery | null {
  if ((key === "assetId" || key === "asset_id") && typeof value === "string" && value.length > 0) {
    return { pointer, assetId: value, fingerprint: null, fingerprintKind: null };
  }
  if (typeof value !== "string" || value.length === 0) return null;
  // Inline payloads are not references to a stored object.
  if (value.startsWith("data:")) return null;

  const kind = fingerprintKindFor(value);
  if (kind === null) return null;
  // A URL is a reference wherever it appears; a bare path only under a known key,
  // because arbitrary strings with a slash are prose far more often than paths.
  if (!REFERENCE_KEYS.has(key) && !URL_LIKE.test(value) && !SCHEME_LIKE.test(value)) return null;

  return { pointer, assetId: null, fingerprint: fingerprint(value), fingerprintKind: kind };
}

/**
 * Walk a decoded JSON value and report every reference in it.
 *
 * Iterative on purpose: a deeply nested checkpoint must not blow the stack.
 */
export function collectReferences(root: unknown, visit: (discovery: Discovery) => void): void {
  const stack: Array<{ value: unknown; pointer: string }> = [{ value: root, pointer: "" }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const value = current.value;

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], pointer: `${current.pointer}/${index}` });
      }
      continue;
    }
    if (value === null || typeof value !== "object") continue;

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      const child = record[key];
      const pointer = `${current.pointer}/${sanitizePointerSegment(key)}`;

      const discovery = discoveryForEntry(key, child, pointer);
      if (discovery !== null) visit(discovery);

      if (child !== null && typeof child === "object") stack.push({ value: child, pointer });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Serializer decoding (LangGraph)                                     */
/* ------------------------------------------------------------------ */

export const KNOWN_SERIALIZERS = new Set(["json", "empty", "bytes"]);

export type DecodeOutcome =
  | { kind: "skipped" }
  | { kind: "value"; value: unknown }
  | { kind: "opaque_binary" }
  | { kind: "unsupported_encoding" }
  | { kind: "decode_failure" };

/** bytea arrives as bytes (pg Buffer / PGlite Uint8Array) or as `\x`-hex text. */
export function toBytes(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    if (value.startsWith("\\x")) {
      const hex = value.slice(2);
      if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
      const bytes = new Uint8Array(hex.length / 2);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      }
      return bytes;
    }
    return new TextEncoder().encode(value);
  }
  return null;
}

/**
 * `json` — strict UTF-8, then `JSON.parse`. `empty` — nothing to read.
 * `bytes` — not guessed, not deep-imported: an explicit human item.
 * Anything else — the scan cannot be trusted to be complete.
 */
export function decodeSerializedValue(serializer: unknown, blob: unknown): DecodeOutcome {
  const type = typeof serializer === "string" && serializer.length > 0 ? serializer : "json";

  if (!KNOWN_SERIALIZERS.has(type)) return { kind: "unsupported_encoding" };
  if (type === "bytes") return { kind: "opaque_binary" };
  if (type === "empty") return blob === null || blob === undefined ? { kind: "skipped" } : { kind: "decode_failure" };

  const bytes = toBytes(blob);
  if (bytes === null) return { kind: "decode_failure" };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "decode_failure" };
  }

  try {
    return { kind: "value", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "decode_failure" };
  }
}

/* ------------------------------------------------------------------ */
/* Row readers                                                         */
/* ------------------------------------------------------------------ */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

function readUuid(value: unknown): string | null {
  const text = readText(value);
  return text !== null && isUuid(text) ? text : null;
}

function rowId(parts: ReadonlyArray<string | number | null>): string {
  return parts.map((part) => (part === null ? "-" : sanitizeIdentifier(String(part)))).join("|");
}

/* ------------------------------------------------------------------ */
/* The scan                                                            */
/* ------------------------------------------------------------------ */

type ContainerResolution = {
  proof: ContainerProof;
  projectId: string | null;
  /** Set when the container could not be proven — a locatable item is emitted. */
  defect: InventoryReason | null;
};

type SessionRow = { canvasId: string; threadId: string | null };
type AgentRunRow = { id: string; sessionId: string; threadId: string; rowId: string };

type Catalog = {
  sessions: Map<string, SessionRow>;
  canvases: Map<string, string>;
  projects: Set<string>;
  runsByThread: Map<string, AgentRunRow[]>;
  sessionIdByThread: Map<string, string>;
};

function unproven(defect: InventoryReason): ContainerResolution {
  return { proof: "UNPROVEN", projectId: null, defect };
}

/**
 * `chat_messages.session_id -> chat_sessions.canvas_id -> canvases.project_id -> projects.id`
 * is the only strong chain a message has; a missing link is reported, never patched.
 */
function resolveSessionContainer(catalog: Catalog, sessionId: string | null): ContainerResolution {
  if (sessionId === null) return unproven("broken_container_chain");
  const session = catalog.sessions.get(sessionId);
  if (session === undefined) return unproven("broken_container_chain");
  const projectId = catalog.canvases.get(session.canvasId);
  if (projectId === undefined || !catalog.projects.has(projectId)) {
    return unproven("broken_container_chain");
  }
  return { proof: "PROJECT_CHAIN_EXACT", projectId, defect: null };
}

/**
 * A checkpoint is only strongly bound when its thread is a session's thread. When
 * the only route is `agent_runs`, every run must converge on one project before
 * that weaker consensus may be reported.
 */
function resolveThreadContainer(catalog: Catalog, threadId: string | null): ContainerResolution {
  if (threadId === null) return unproven("unbound_thread");

  const sessionId = catalog.sessionIdByThread.get(threadId);
  if (sessionId !== undefined) {
    const viaSession = resolveSessionContainer(catalog, sessionId);
    if (viaSession.proof === "PROJECT_CHAIN_EXACT") {
      return { proof: "THREAD_SESSION_EXACT", projectId: viaSession.projectId, defect: null };
    }
    return unproven("broken_container_chain");
  }

  const runs = catalog.runsByThread.get(threadId) ?? [];
  if (runs.length === 0) return unproven("unbound_thread");

  const corroborating: AgentRunRow[] = [];
  let mismatch = false;
  for (const run of runs) {
    const session = catalog.sessions.get(run.sessionId);
    if (session === undefined) continue;
    // A legacy session with no thread_id cannot contradict the run; a session
    // that carries a DIFFERENT thread does.
    if (session.threadId !== null && session.threadId !== threadId) {
      mismatch = true;
      continue;
    }
    corroborating.push(run);
  }
  if (mismatch) return { proof: "CONFLICT", projectId: null, defect: "run_session_thread_mismatch" };

  const projects = new Set<string>();
  for (const run of corroborating) {
    const resolved = resolveSessionContainer(catalog, run.sessionId);
    if (resolved.projectId !== null) projects.add(resolved.projectId);
  }
  if (projects.size === 0) return unproven("unbound_thread");
  if (projects.size > 1) {
    return { proof: "CONFLICT", projectId: null, defect: "ambiguous_thread_binding" };
  }
  return {
    proof: "THREAD_AGENT_RUN_CONSENSUS",
    projectId: [...projects][0] ?? null,
    defect: null,
  };
}

type JobRow = {
  id: string;
  projectId: string | null;
  canvasId: string | null;
  sessionId: string | null;
  threadId: string | null;
};

/**
 * Every clue a job carries must name the same project. `workspace_id` is never
 * selected: it is a personal billing workspace and says nothing about ownership.
 */
function resolveJobContainer(catalog: Catalog, job: JobRow): ContainerResolution {
  const clues: ContainerResolution[] = [];

  if (job.projectId !== null) {
    clues.push({ proof: "PROJECT_CHAIN_EXACT", projectId: job.projectId, defect: null });
  }
  if (job.canvasId !== null) {
    const projectId = catalog.canvases.get(job.canvasId);
    clues.push(
      projectId === undefined
        ? unproven("broken_container_chain")
        : { proof: "PROJECT_CHAIN_EXACT", projectId, defect: null },
    );
  }
  if (job.sessionId !== null) clues.push(resolveSessionContainer(catalog, job.sessionId));
  if (job.threadId !== null) clues.push(resolveThreadContainer(catalog, job.threadId));

  const projects = new Set<string>();
  for (const clue of clues) if (clue.projectId !== null) projects.add(clue.projectId);

  if (projects.size > 1 || clues.some((clue) => clue.proof === "CONFLICT")) {
    return { proof: "CONFLICT", projectId: null, defect: "job_relation_conflict" };
  }
  if (projects.size === 0) return unproven("unbound_thread");

  const projectId = [...projects][0] ?? null;
  const explicit = clues.some((clue) => clue.proof === "PROJECT_CHAIN_EXACT");
  if (explicit) return { proof: "PROJECT_CHAIN_EXACT", projectId, defect: null };

  const threaded = clues.find((clue) => clue.proof === "THREAD_SESSION_EXACT");
  if (threaded !== undefined) return { proof: "THREAD_SESSION_EXACT", projectId, defect: null };
  return { proof: "THREAD_AGENT_RUN_CONSENSUS", projectId, defect: null };
}

const ACTION_BY_REASON: Record<InventoryReason, InventoryAction> = {
  asset_id_exact: "NONE",
  asset_id_missing: "KEEP_UNRESOLVED",
  asset_row_missing: "KEEP_UNRESOLVED",
  asset_project_unassigned: "FIX_RELATIONSHIP",
  asset_project_conflict: "FIX_RELATIONSHIP",
  broken_container_chain: "FIX_RELATIONSHIP",
  run_session_thread_mismatch: "FIX_RELATIONSHIP",
  ambiguous_thread_binding: "FIX_RELATIONSHIP",
  unbound_thread: "KEEP_UNRESOLVED",
  job_relation_conflict: "FIX_RELATIONSHIP",
  legacy_canvases_object_unbound: "REVIEW_LEGACY_CANVASES_OBJECT",
  opaque_binary: "REVIEW_DECODER_GAP",
  unsupported_encoding: "REVIEW_DECODER_GAP",
  decode_failure: "REVIEW_DECODER_GAP",
};

type AssetRow = { projectId: string | null };

function actionForReference(reason: InventoryReason, container: ContainerResolution): InventoryAction {
  if (reason === "asset_id_missing") {
    // With a proven container a human can decide, then record the stable id.
    return container.projectId === null ? "REVIEW_REFERENCE" : "BACKFILL_ASSET_ID_AFTER_MANUAL_PROOF";
  }
  return ACTION_BY_REASON[reason];
}

class InventoryRun {
  private readonly items: InventoryItem[] = [];

  constructor(
    private readonly executor: QueryExecutor,
    private readonly pageSize: number,
  ) {}

  private readonly catalog: Catalog = {
    sessions: new Map(),
    canvases: new Map(),
    projects: new Set(),
    runsByThread: new Map(),
    sessionIdByThread: new Map(),
  };

  private readonly assetCache = new Map<string, AssetRow | null>();

  private emit(item: InventoryItem): void {
    this.items.push(item);
  }

  private emitContainerDefect(options: {
    sourceTable: string;
    sourceColumn: string;
    rowId: string;
    container: ContainerResolution;
  }): void {
    const defect = options.container.defect;
    if (defect === null) return;
    this.emit({
      sourceTable: options.sourceTable,
      sourceColumn: options.sourceColumn,
      rowId: options.rowId,
      pointer: null,
      containerProjectId: options.container.projectId,
      containerProof: options.container.proof,
      assetId: null,
      objectProof: "UNPROVEN",
      reason: defect,
      action: ACTION_BY_REASON[defect],
      fingerprint: null,
      fingerprintKind: null,
    });
  }

  private async loadAsset(assetId: string): Promise<AssetRow | null> {
    const cached = this.assetCache.get(assetId);
    if (cached !== undefined) return cached;

    const result = await this.executor.query(
      "select id, project_id from public.asset_objects where id = $1",
      [assetId],
    );
    const row = result.rows[0];
    const loaded: AssetRow | null =
      row === undefined ? null : { projectId: readUuid(row.project_id) };
    this.assetCache.set(assetId, loaded);
    return loaded;
  }

  /**
   * Only a stable `assetId` / `asset_id` equal to `asset_objects.id` proves the
   * object. Everything else stays UNPROVEN, whatever its fingerprint matches.
   */
  private async resolveReference(options: {
    sourceTable: string;
    sourceColumn: string;
    rowId: string;
    container: ContainerResolution;
    discovery: Discovery;
  }): Promise<void> {
    const { discovery, container } = options;
    const base = {
      sourceTable: options.sourceTable,
      sourceColumn: options.sourceColumn,
      rowId: options.rowId,
      pointer: discovery.pointer,
      containerProjectId: container.projectId,
      containerProof: container.proof,
      fingerprint: discovery.fingerprint,
      fingerprintKind: discovery.fingerprintKind,
    };

    if (discovery.assetId === null) {
      this.emit({
        ...base,
        assetId: null,
        objectProof: "UNPROVEN",
        reason: "asset_id_missing",
        action: actionForReference("asset_id_missing", container),
      });
      return;
    }

    if (!isUuid(discovery.assetId)) {
      // The value is not an id at all — it is not echoed, not even hashed.
      this.emit({
        ...base,
        assetId: null,
        fingerprint: null,
        fingerprintKind: null,
        objectProof: "UNPROVEN",
        reason: "asset_id_missing",
        action: "KEEP_UNRESOLVED",
      });
      return;
    }

    const assetId = discovery.assetId.toLowerCase();
    const asset = await this.loadAsset(assetId);

    if (asset === null) {
      this.emit({
        ...base,
        assetId,
        objectProof: "UNPROVEN",
        reason: "asset_row_missing",
        action: ACTION_BY_REASON.asset_row_missing,
      });
      return;
    }
    if (asset.projectId === null) {
      this.emit({
        ...base,
        assetId,
        objectProof: "UNPROVEN",
        reason: "asset_project_unassigned",
        action: ACTION_BY_REASON.asset_project_unassigned,
      });
      return;
    }
    if (container.projectId !== null && container.projectId !== asset.projectId) {
      this.emit({
        ...base,
        assetId,
        objectProof: "CONFLICT",
        reason: "asset_project_conflict",
        action: ACTION_BY_REASON.asset_project_conflict,
      });
      return;
    }

    this.emit({
      ...base,
      assetId,
      objectProof: "ASSET_ID_EXACT",
      reason: "asset_id_exact",
      action: "NONE",
    });
  }

  private async emitReferences(options: {
    sourceTable: string;
    sourceColumn: string;
    rowId: string;
    container: ContainerResolution;
    value: unknown;
  }): Promise<void> {
    const discoveries: Discovery[] = [];
    collectReferences(options.value, (discovery) => discoveries.push(discovery));
    for (const discovery of discoveries) {
      await this.resolveReference({
        sourceTable: options.sourceTable,
        sourceColumn: options.sourceColumn,
        rowId: options.rowId,
        container: options.container,
        discovery,
      });
    }
  }

  private emitDecodeGap(options: {
    sourceTable: string;
    sourceColumn: string;
    rowId: string;
    container: ContainerResolution;
    outcome: "opaque_binary" | "unsupported_encoding" | "decode_failure";
  }): void {
    this.emit({
      sourceTable: options.sourceTable,
      sourceColumn: options.sourceColumn,
      rowId: options.rowId,
      pointer: null,
      containerProjectId: options.container.projectId,
      containerProof: options.container.proof,
      assetId: null,
      objectProof: "UNPROVEN",
      reason: options.outcome,
      action: ACTION_BY_REASON[options.outcome],
      fingerprint: null,
      fingerprintKind: null,
    });
  }

  // ---- source loaders (the catalog) -------------------------------------

  private async loadCatalog(): Promise<void> {
    await scanKeyset({
      label: "public.projects",
      executor: this.executor,
      pageSize: this.pageSize,
      build: (cursor, limit) =>
        buildKeysetQuery({
          table: "public.projects",
          columns: "id",
          keyColumns: ["id"],
          cursor,
          limit,
        }),
      keyOf: (row) => [String(row.id)],
      handle: (row) => {
        const id = readUuid(row.id);
        if (id !== null) this.catalog.projects.add(id);
      },
    });

    await scanKeyset({
      label: "public.canvases",
      executor: this.executor,
      pageSize: this.pageSize,
      build: (cursor, limit) =>
        buildKeysetQuery({
          table: "public.canvases",
          columns: "id, project_id",
          keyColumns: ["id"],
          cursor,
          limit,
        }),
      keyOf: (row) => [String(row.id)],
      handle: (row) => {
        const id = readUuid(row.id);
        const projectId = readUuid(row.project_id);
        if (id !== null && projectId !== null) this.catalog.canvases.set(id, projectId);
      },
    });

    await scanKeyset({
      label: "public.chat_sessions",
      executor: this.executor,
      pageSize: this.pageSize,
      build: (cursor, limit) =>
        buildKeysetQuery({
          table: "public.chat_sessions",
          columns: "id, canvas_id, thread_id",
          keyColumns: ["id"],
          cursor,
          limit,
        }),
      keyOf: (row) => [String(row.id)],
      handle: (row) => {
        const id = readUuid(row.id);
        const canvasId = readUuid(row.canvas_id);
        if (id === null || canvasId === null) return;
        const threadId = readText(row.thread_id);
        this.catalog.sessions.set(id, { canvasId, threadId });
        if (threadId !== null) this.catalog.sessionIdByThread.set(threadId, id);
      },
    });
  }

  // ---- sources ----------------------------------------------------------

  /** `agent_runs` exists here to check the run/session thread, not to list assets. */
  async scanAgentRuns(): Promise<void> {
    await scanKeyset({
      label: "public.agent_runs",
      executor: this.executor,
      pageSize: this.pageSize,
      build: (cursor, limit) =>
        buildKeysetQuery({
          table: "public.agent_runs",
          columns: "id, session_id, thread_id",
          keyColumns: ["id"],
          cursor,
          limit,
        }),
      keyOf: (row) => [String(row.id)],
      handle: (row) => {
        const id = readUuid(row.id);
        const sessionId = readUuid(row.session_id);
        const threadId = readText(row.thread_id);
        if (id === null || threadId === null) return;

        const run: AgentRunRow = {
          id,
          sessionId: sessionId ?? "",
          threadId,
          rowId: rowId([id]),
        };
        if (sessionId !== null) {
          const list = this.catalog.runsByThread.get(threadId) ?? [];
          list.push(run);
          this.catalog.runsByThread.set(threadId, list);
        }

        if (sessionId === null) return;
        const session = this.catalog.sessions.get(sessionId);
        if (session === undefined) {
          this.emitContainerDefect({
            sourceTable: "public.agent_runs",
            sourceColumn: "thread_id",
            rowId: run.rowId,
            container: unproven("broken_container_chain"),
          });
          return;
        }
        if (session.threadId !== null && session.threadId !== threadId) {
          this.emitContainerDefect({
            sourceTable: "public.agent_runs",
            sourceColumn: "thread_id",
            rowId: run.rowId,
            container: { proof: "CONFLICT", projectId: null, defect: "run_session_thread_mismatch" },
          });
        }
      },
    });
  }

  /**
   * `content_blocks` and `tool_activities` are two physical columns: a message
   * that has both is reported twice, and the two are never merged or deduplicated.
   */
  async scanChatMessages(column: "content_blocks" | "tool_activities"): Promise<void> {
    await scanKeyset({
      label: `public.chat_messages.${column}`,
      executor: this.executor,
      pageSize: this.pageSize,
      build: (cursor, limit) =>
        buildKeysetQuery({
          table: "public.chat_messages",
          columns: `id, session_id, ${column}`,
          keyColumns: ["id"],
          cursor,
          limit,
        }),
      keyOf: (row) => [String(row.id)],
      handle: async (row) => {
        const id = readUuid(row.id);
        if (id === null) return;
        const container = resolveSessionContainer(this.catalog, readUuid(row.session_id));
        const identity = rowId([id]);
        this.emitContainerDefect({
          sourceTable: "public.chat_messages",
          sourceColumn: "session_id",
          rowId: identity,
          container,
        });
        if (row[column] === null || row[column] === undefined) return;
        await this.emitReferences({
          sourceTable: "public.chat_messages",
          sourceColumn: column,
          rowId: identity,
          container,
          value: row[column],
        });
      },
    });
  }

  private async scanCheckpoints(): Promise<void> {
    await scanKeyset({
      label: "langgraph.checkpoints",
      executor: this.executor,
      pageSize: this.pageSize,
      build: (cursor, limit) =>
        buildKeysetQuery({
          table: "langgraph.checkpoints",
          columns: "thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata",
          keyColumns: ["thread_id", "checkpoint_ns", "checkpoint_id"],
          cursor,
          limit,
        }),
      keyOf: (row) => [String(row.thread_id), String(row.checkpoint_ns), String(row.checkpoint_id)],
      handle: async (row) => {
        const threadId = readText(row.thread_id);
        const identity = rowId([
          threadId,
          readText(row.checkpoint_ns) ?? "",
          readText(row.checkpoint_id),
        ]);
        const container = resolveThreadContainer(this.catalog, threadId);
        this.emitContainerDefect({
          sourceTable: "langgraph.checkpoints",
          sourceColumn: "thread_id",
          rowId: identity,
          container,
        });

        // `checkpoint` / `metadata` are JSONB and are walked as such. The row's
        // declared serializer is still checked, because a `bytes` or unknown
        // serializer means the JSON we can see may not be the whole payload.
        const serializer = readText(row.type) ?? "json";
        if (!KNOWN_SERIALIZERS.has(serializer)) {
          this.emitDecodeGap({
            sourceTable: "langgraph.checkpoints",
            sourceColumn: "checkpoint",
            rowId: identity,
            container,
            outcome: "unsupported_encoding",
          });
        } else if (serializer === "bytes") {
          this.emitDecodeGap({
            sourceTable: "langgraph.checkpoints",
            sourceColumn: "checkpoint",
            rowId: identity,
            container,
            outcome: "opaque_binary",
          });
        }

        // checkpoint / metadata are JSONB: the driver already decoded them.
        await this.emitReferences({
          sourceTable: "langgraph.checkpoints",
          sourceColumn: "checkpoint",
          rowId: identity,
          container,
          value: row.checkpoint,
        });
        await this.emitReferences({
          sourceTable: "langgraph.checkpoints",
          sourceColumn: "metadata",
          rowId: identity,
          container,
          value: row.metadata,
        });
      },
    });
  }

  private async scanCheckpointBlobs(): Promise<void> {
    await scanKeyset({
      label: "langgraph.checkpoint_blobs",
      executor: this.executor,
      pageSize: this.pageSize,
      build: (cursor, limit) =>
        buildKeysetQuery({
          table: "langgraph.checkpoint_blobs",
          columns: "thread_id, checkpoint_ns, channel, version, type, blob",
          keyColumns: ["thread_id", "checkpoint_ns", "channel", "version"],
          cursor,
          limit,
        }),
      keyOf: (row) => [
        String(row.thread_id),
        String(row.checkpoint_ns),
        String(row.channel),
        String(row.version),
      ],
      handle: async (row) => {
        const identity = rowId([
          readText(row.thread_id),
          readText(row.checkpoint_ns) ?? "",
          readText(row.channel),
          readText(row.version),
        ]);
        await this.handleSerializedRow({
          sourceTable: "langgraph.checkpoint_blobs",
          rowId: identity,
          threadId: readText(row.thread_id),
          serializer: row.type,
          blob: row.blob,
        });
      },
    });
  }

  private async scanCheckpointWrites(): Promise<void> {
    await scanKeyset({
      label: "langgraph.checkpoint_writes",
      executor: this.executor,
      pageSize: this.pageSize,
      build: (cursor, limit) =>
        buildKeysetQuery({
          table: "langgraph.checkpoint_writes",
          columns: "thread_id, checkpoint_ns, checkpoint_id, task_id, idx, type, blob",
          keyColumns: ["thread_id", "checkpoint_ns", "checkpoint_id", "task_id", "idx"],
          cursor,
          limit,
        }),
      keyOf: (row) => [
        String(row.thread_id),
        String(row.checkpoint_ns),
        String(row.checkpoint_id),
        String(row.task_id),
        typeof row.idx === "number" ? row.idx : Number(row.idx),
      ],
      handle: async (row) => {
        const identity = rowId([
          readText(row.thread_id),
          readText(row.checkpoint_ns) ?? "",
          readText(row.checkpoint_id),
          readText(row.task_id),
          typeof row.idx === "number" ? row.idx : Number(row.idx),
        ]);
        await this.handleSerializedRow({
          sourceTable: "langgraph.checkpoint_writes",
          rowId: identity,
          threadId: readText(row.thread_id),
          serializer: row.type,
          blob: row.blob,
        });
      },
    });
  }

  private async handleSerializedRow(options: {
    sourceTable: string;
    rowId: string;
    threadId: string | null;
    serializer: unknown;
    blob: unknown;
  }): Promise<void> {
    const container = resolveThreadContainer(this.catalog, options.threadId);
    this.emitContainerDefect({
      sourceTable: options.sourceTable,
      sourceColumn: "thread_id",
      rowId: options.rowId,
      container,
    });

    const outcome = decodeSerializedValue(options.serializer, options.blob);
    if (outcome.kind === "skipped") return;
    if (outcome.kind !== "value") {
      this.emitDecodeGap({
        sourceTable: options.sourceTable,
        sourceColumn: "blob",
        rowId: options.rowId,
        container,
        outcome: outcome.kind,
      });
      return;
    }

    await this.emitReferences({
      sourceTable: options.sourceTable,
      sourceColumn: "blob",
      rowId: options.rowId,
      container,
      value: outcome.value,
    });
  }

  /**
   * `payload` is deliberately not selected: it can hold prompts. Only `result`
   * (the artefact the job produced) is scanned.
   */
  private async scanBackgroundJobs(): Promise<void> {
    await scanKeyset({
      label: "public.background_jobs",
      executor: this.executor,
      pageSize: this.pageSize,
      build: (cursor, limit) =>
        buildKeysetQuery({
          table: "public.background_jobs",
          columns: "id, project_id, canvas_id, session_id, thread_id, result",
          keyColumns: ["id"],
          cursor,
          limit,
        }),
      keyOf: (row) => [String(row.id)],
      handle: async (row) => {
        const id = readUuid(row.id);
        if (id === null) return;
        const identity = rowId([id]);
        const job: JobRow = {
          id,
          projectId: readUuid(row.project_id),
          canvasId: readUuid(row.canvas_id),
          sessionId: readUuid(row.session_id),
          threadId: readText(row.thread_id),
        };
        const container = resolveJobContainer(this.catalog, job);
        this.emitContainerDefect({
          sourceTable: "public.background_jobs",
          sourceColumn: "project_id",
          rowId: identity,
          container,
        });
        if (row.result === null || row.result === undefined) return;
        await this.emitReferences({
          sourceTable: "public.background_jobs",
          sourceColumn: "result",
          rowId: identity,
          container,
          value: row.result,
        });
      },
    });
  }

  /**
   * The legacy `canvases` bucket. No rule in this ticket may derive a project
   * from an object name, so every object is reported unresolved — even when the
   * name contains a project id.
   */
  private async scanLegacyCanvasesObjects(): Promise<void> {
    await scanKeyset({
      label: "storage.objects(canvases)",
      executor: this.executor,
      pageSize: this.pageSize,
      build: (cursor, limit) =>
        buildKeysetQuery({
          table: "storage.objects",
          columns: "id, bucket_id, name",
          keyColumns: ["bucket_id", "name"],
          cursor,
          limit,
          extraWhere: "bucket_id = $1",
          extraValues: [LEGACY_CANVASES_BUCKET],
        }),
      keyOf: (row) => [String(row.bucket_id), String(row.name)],
      handle: (row) => {
        const name = readText(row.name);
        if (name === null) return;
        const objectId = readUuid(row.id);
        this.emit({
          sourceTable: "storage.objects",
          sourceColumn: "name",
          rowId: objectId !== null ? rowId([objectId]) : rowId([fingerprint(name)]),
          pointer: null,
          containerProjectId: null,
          containerProof: "UNPROVEN",
          assetId: null,
          objectProof: "UNPROVEN",
          reason: "legacy_canvases_object_unbound",
          action: ACTION_BY_REASON.legacy_canvases_object_unbound,
          fingerprint: fingerprint(name),
          fingerprintKind: "object_name",
        });
      },
    });
  }

  async run(): Promise<InventoryReport> {
    await this.executor.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await this.executor.query("SET LOCAL statement_timeout = '15000ms'");

      await this.loadCatalog();
      await this.scanAgentRuns();
      await this.scanChatMessages("content_blocks");
      await this.scanChatMessages("tool_activities");
      await this.scanCheckpoints();
      await this.scanCheckpointBlobs();
      await this.scanCheckpointWrites();
      await this.scanBackgroundJobs();
      await this.scanLegacyCanvasesObjects();

      await this.executor.query("COMMIT");
    } catch (error) {
      // The only recovery a read-only scan is allowed to perform.
      try {
        await this.executor.query("ROLLBACK");
      } catch {
        // The transaction is already gone; the original error is what matters.
      }
      throw error;
    }

    return buildReport(this.items);
  }
}

/**
 * Run one complete inventory scan through an injected executor.
 *
 * The executor is a parameter on purpose: the real CLI hands it a `pg` client,
 * and the test suite hands it the in-repo PGlite harness. Nothing about the scan
 * changes between the two, so the tests exercise the shipped SQL.
 */
export async function runHistoryReferenceInventory(
  executor: QueryExecutor,
  options: { pageSize?: number } = {},
): Promise<InventoryReport> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (
    !Number.isInteger(pageSize) ||
    pageSize < MIN_PAGE_SIZE ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw new UsageError(`pageSize must be between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`);
  }
  return new InventoryRun(executor, pageSize).run();
}

function itemComparator(left: InventoryItem, right: InventoryItem): number {
  const leftKey = [
    left.sourceTable,
    left.sourceColumn,
    left.rowId,
    left.pointer ?? "",
    left.reason,
  ];
  const rightKey = [
    right.sourceTable,
    right.sourceColumn,
    right.rowId,
    right.pointer ?? "",
    right.reason,
  ];
  for (let index = 0; index < leftKey.length; index += 1) {
    const a = leftKey[index] ?? "";
    const b = rightKey[index] ?? "";
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

export function buildReport(items: InventoryItem[]): InventoryReport {
  // Two scans can discover the same container defect (a message is read once per
  // physical column), and an identical item is the same fact. References from two
  // columns differ in `sourceColumn`, so they can never collapse into one.
  const unique = new Map<string, InventoryItem>();
  for (const entry of items) unique.set(JSON.stringify(entry), entry);
  const sorted = [...unique.values()].sort(itemComparator);

  const summary: InventorySummary = {
    referencesScanned: sorted.filter((item) => REFERENCE_REASONS.includes(item.reason)).length,
    exactBindings: sorted.filter((item) => item.objectProof === "ASSET_ID_EXACT").length,
    unresolved: sorted.filter(
      (item) => item.objectProof === "UNPROVEN" || item.containerProof === "UNPROVEN",
    ).length,
    conflicts: sorted.filter(
      (item) => item.objectProof === "CONFLICT" || item.containerProof === "CONFLICT",
    ).length,
    opaqueBinary: sorted.filter((item) => item.reason === "opaque_binary").length,
    decodeFailures: sorted.filter((item) => item.reason === "decode_failure").length,
    unsupportedEncodings: sorted.filter((item) => item.reason === "unsupported_encoding").length,
  };

  return {
    schemaVersion: 1,
    mode: "read-only",
    complete: summary.decodeFailures === 0 && summary.unsupportedEncodings === 0,
    summary,
    items: sorted,
  };
}

export function exitCodeForReport(report: InventoryReport): number {
  if (!report.complete) return 2;
  const { unresolved, conflicts, opaqueBinary } = report.summary;
  return unresolved > 0 || conflicts > 0 || opaqueBinary > 0 ? 1 : 0;
}

/** The finished document: exactly one JSON value, nothing appended. */
export function serializeReport(report: InventoryReport): string {
  return JSON.stringify(report);
}

/** Error text is only echoed when it is itself safe to print. */
export function safeErrorText(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
  const trimmed = raw.length > 300 ? `${raw.slice(0, 300)}...` : raw;
  return isRedactionSafe(trimmed) ? trimmed : "error text withheld (failed the redaction deny-list)";
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

async function execute(argv: readonly string[]): Promise<number> {
  let options: InventoryOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`hahart-history-reference-inventory: ${safeErrorText(error)}\n`);
      process.stderr.write(`${USAGE_TEXT}\n`);
      return 2;
    }
    throw error;
  }

  const connectionString = process.env.SUPABASE_DB_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    process.stderr.write("hahart-history-reference-inventory: SUPABASE_DB_URL is not set\n");
    return 2;
  }

  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const executor = createReadOnlyExecutor({
      query: async (sql, params) => {
        const result = await client.query(sql, params === undefined ? undefined : [...params]);
        return { rows: result.rows as Array<Record<string, unknown>> };
      },
    });
    const report = await runHistoryReferenceInventory(executor, { pageSize: options.pageSize });

    const json = serializeReport(report);
    assertRedactionSafe(json);
    process.stdout.write(`${json}\n`);
    return exitCodeForReport(report);
  } catch (error) {
    process.stderr.write(`hahart-history-reference-inventory failed: ${safeErrorText(error)}\n`);
    return 2;
  } finally {
    try {
      await client.end();
    } catch {
      // Nothing useful to do: the report (or the failure) is already decided.
    }
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return execute(argv);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
