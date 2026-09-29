// Find every error code the server sends that applicationErrorCodeSchema does
// not accept.
//
// Why this matters: applicationErrorResponseSchema.parse() is called INSIDE the
// error path. An unlisted code makes the parse throw, so instead of the intended
// response the client gets Fastify's generic handler output -- i.e. the real
// cause is replaced by a zod validation dump. Found while verifying P0-2: the
// "No provider registered" branch sends `provider_not_configured`, which is not
// in the enum, so that branch has never produced its intended response.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SHARED = "D:\\cherry stuido\\Loomic\\packages\\shared\\src\\http.ts";
const ROOT = "D:\\cherry stuido\\Loomic\\apps\\server\\src";

// --- allowed set ---
const sharedSrc = readFileSync(SHARED, "utf8");
const enumStart = sharedSrc.indexOf("applicationErrorCodeSchema = z.enum([");
const enumEnd = sharedSrc.indexOf("]);", enumStart);
const enumBody = sharedSrc.slice(enumStart, enumEnd);
const allowed = new Set([...enumBody.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
console.log(`allowed codes: ${allowed.size}`);

// --- collect used codes ---
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const offenders = new Map(); // code -> [{file, line}]
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, idx) => {
    // KNOWN BLIND SPOT: only the `code: "..."` object-literal form is matched.
    // Codes passed POSITIONALLY -- `new CanvasServiceError("service_unavailable",
    // ...)` -- are invisible here even though they are fed to
    // applicationErrorResponseSchema.parse() at runtime just the same.
    //
    // Widening to `new \w*Error\(\s*"([a-z_]+)"` was tried and REVERTED: the first
    // positional string is not reliably a wire code. It matched
    // GenerationError("replicate", "invalid_input", ...) -- a provider name -- and
    // MarketplaceError's domain codes, producing four false positives. An audit
    // that cries wolf gets ignored, which is worse than the gap.
    //
    // The positional form is covered by an executable check instead:
    // src/features/canvas/canvas-service.test.ts asserts every CanvasErrorCode
    // parses. Do that for a new error class rather than guessing here.
    for (const m of line.matchAll(/\bcode:\s*"([a-z_]+)"/g)) {
      const code = m[1];
      if (allowed.has(code)) continue;
      // unauthenticatedErrorResponseSchema has its own separate enum
      if (code === "unauthorized") continue;
      if (!offenders.has(code)) offenders.set(code, []);
      offenders.get(code).push({
        file: file.replace(ROOT, "").replace(/\\/g, "/"),
        line: idx + 1,
      });
    }
  });
}

if (offenders.size === 0) {
  console.log("\nno offending codes found");
} else {
  console.log(`\n${offenders.size} code(s) not in the enum:\n`);
  for (const [code, hits] of [...offenders].sort()) {
    console.log(`  "${code}"  (${hits.length} site${hits.length > 1 ? "s" : ""})`);
    for (const h of hits) console.log(`      ${h.file}:${h.line}`);
  }
}
console.log("\nAUDIT_END");
