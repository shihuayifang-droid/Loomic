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
// Run with:  npx tsx _retry-predicate.mjs
import { isTransportFailure as isTransport } from "./src/supabase/transport-retry.js";

const cases = [
  // --- should retry: never reached Postgres ---
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

  // --- should NOT retry: Postgres answered, replaying changes nothing ---
  [
    { code: "57014", message: "canceling statement due to statement timeout" },
    false,
    "statement timeout (the old multi-MB failure)",
  ],
  [{ code: "42501", message: "new row violates row-level security policy" }, false, "RLS denial"],
  [{ code: "23505", message: "duplicate key value violates unique constraint" }, false, "constraint"],
  [{ code: "PGRST116", message: "JSON object requested, multiple rows returned" }, false, "PostgREST"],
  [{ message: "invalid input syntax for type json" }, false, "no code, but not a transport message"],
];

let bad = 0;
for (const [err, want, note] of cases) {
  const got = isTransport(err);
  const mark = got === want ? "ok  " : "FAIL";
  if (got !== want) bad++;
  console.log(
    `${mark} retry=${String(got).padEnd(5)} want=${String(want).padEnd(5)} ` +
      `code=${JSON.stringify(err.code ?? null).padEnd(10)} ${note}`,
  );
}
console.log(bad === 0 ? "\nALL PASS" : `\n${bad} MISCLASSIFIED`);
