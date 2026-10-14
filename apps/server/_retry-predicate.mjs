// Verify the retry predicate against REAL error shapes.
//
// This is the part that fails silently: if the regex misses, the retry never
// fires and nothing reports it. The first case below is copied verbatim from the
// server log, including the fact that pgCode printed as an EMPTY STRING rather
// than "?" -- meaning supabase-js set `code` to "" and not undefined.
//
// Imports the REAL predicate. It used to re-declare its own copy, which meant the
// script stayed green no matter what happened to the shipped one -- a test of a
// duplicate is not a test.
//
// 工单21 前置A (T-31): the mutation lookups now run on the `pg` repository instead
// of PostgREST, so the table below also pins the pg/Node transport classification
// that shipped in 20E fixup (2558eb5):
//
//   - node-postgres' own disconnect carries NO code at all and its message is
//     `Connection terminated unexpectedly`;
//   - the socket errors underneath it carry a truthy NODE code;
//   - every SQLSTATE and every code we have not proven stays fail-fast, even when
//     its message mentions a connection -- the predicate consults `code` BEFORE
//     the message, so `fetch failed` on an unproven code is NOT retried.
//
// Run with:  npx tsx _retry-predicate.mjs      (cwd: apps/server)
// Exit code: 0 + "ALL PASS" only when every case matches; 1 on any mismatch.
import { isTransportFailure as isTransport } from "./src/supabase/transport-retry.js";

/** The Node socket codes node-postgres reports when nothing reached Postgres. */
const NODE_NETWORK_CODES = [
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
];

const cases = [
  // --- should retry: the Supabase/proxy shapes from the original server log ---
  [{ code: "", message: "TypeError: fetch failed" }, true, "observed in log (code empty string)"],
  [{ message: "TypeError: fetch failed" }, true, "code undefined"],
  [
    {
      message:
        "Client network socket disconnected before secure TLS connection was established",
    },
    true,
    "the underlying cause text",
  ],
  [{ message: "read ECONNRESET" }, true, "raw socket reset"],
  [{ message: "connect ETIMEDOUT 198.18.0.20:443" }, true, "proxy fake-ip timeout"],

  // --- should retry: node-postgres transport failures (工单21 前置A) ---
  [
    new Error("Connection terminated unexpectedly"),
    true,
    "pg disconnect: NO code property at all",
  ],
  [
    { code: "", message: "Connection terminated unexpectedly" },
    true,
    "pg disconnect: code explicitly empty",
  ],
  ...NODE_NETWORK_CODES.map((code) => [
    Object.assign(new Error(`read ${code} 198.18.0.20:5432`), { code }),
    true,
    `Node socket code ${code}`,
  ]),

  // --- should NOT retry: Postgres answered, replaying changes nothing ---
  [
    { code: "57014", message: "canceling statement due to statement timeout" },
    false,
    "statement timeout (the old multi-MB failure)",
  ],
  [{ code: "42501", message: "new row violates row-level security policy" }, false, "RLS denial"],
  [{ code: "23505", message: "duplicate key value violates unique constraint" }, false, "constraint"],
  [{ code: "22P02", message: "invalid input syntax for type uuid" }, false, "invalid text representation"],
  [{ code: "PGRST116", message: "JSON object requested, multiple rows returned" }, false, "PostgREST"],
  [{ message: "invalid input syntax for type json" }, false, "no code, but not a transport message"],

  // --- should NOT retry: a SQLSTATE beats the message (工单21 前置A) ---
  [
    { code: "57P01", message: "terminating connection due to administrator command" },
    false,
    "57P01 admin_shutdown: message says connection, code still wins",
  ],
  [
    { code: "08006", message: "connection failure" },
    false,
    "08006 connection_failure: message says connection, code still wins",
  ],
  [
    { code: "08006", message: "Connection terminated unexpectedly" },
    false,
    "SQLSTATE + a message the message-test ALONE would match: decides code-first",
  ],

  // --- should NOT retry: a code the predicate has not proven (工单21 前置A) ---
  [
    { code: "ENOTFOUND", message: "fetch failed" },
    false,
    "unproven Node code + transport-looking message",
  ],
  [
    { code: "UNPROVEN", message: "fetch failed" },
    false,
    "unknown code + transport-looking message",
  ],
];

// Distinguish "code field missing" from "code present and null/empty": the driver
// omits it on its own disconnect and sets "" on the supabase-js path.
const shownCode = (err) => {
  if (!err || typeof err !== "object") return "<not-an-object>";
  if (!Object.prototype.hasOwnProperty.call(err, "code")) return "<absent>";
  return JSON.stringify(err.code);
};

// The message is printed too: it is the half of the shape the note describes
// ("message says connection", "message contains fetch failed"), so a reader can
// check the claim instead of trusting the label.
const shownMsg = (err) => {
  if (!err || typeof err !== "object") return "<not-an-object>";
  return typeof err.message === "string" ? JSON.stringify(err.message) : "<no message>";
};

let bad = 0;
for (const [err, want, note] of cases) {
  const got = isTransport(err);
  if (got !== want) bad++;
  console.log(
    `${got === want ? "ok  " : "FAIL"} got=${String(got).padEnd(5)} want=${String(want).padEnd(5)} ` +
      `code=${shownCode(err).padEnd(12)} msg=${shownMsg(err)} :: ${note}`,
  );
}

console.log(
  bad === 0
    ? `\nALL PASS (${cases.length} cases)`
    : `\n${bad} MISCLASSIFIED of ${cases.length}`,
);
process.exitCode = bad === 0 ? 0 : 1;
