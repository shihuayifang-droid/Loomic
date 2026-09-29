// Standalone check for focusGeneratingSlots (apps/web/src/lib/canvas-elements.ts).
// The web app has no test runner and its tsc run has pre-existing errors, so this
// re-implements nothing: it imports the real source through a tiny TS strip.
// Run: node scripts/check-focus-generating-slots.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, "../apps/web/src/lib/canvas-elements.ts"),
  "utf8",
);

// Extract just the two functions under test and drop type annotations, so we
// exercise the shipped source without pulling in React/Excalidraw imports.
const start = src.indexOf("export function findGeneratingElements");
if (start < 0) throw new Error("findGeneratingElements not found in source");
const body = src
  .slice(start)
  // Return types first — otherwise the bare `: any` rule mangles `): any[] {`.
  .replace(/\): any\[\] \{/g, ") {")
  .replace(/\): boolean \{/g, ") {")
  .replace(/: readonly any\[\]/g, "")
  .replace(/: Set<string>/g, "")
  .replace(/: any\b/g, "")
  .replace(/^export /gm, "");

const mod = new Function(`${body}; return { findGeneratingElements, focusGeneratingSlots };`)();
const { focusGeneratingSlots } = mod;

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "[OK]  " : "[FAIL]"} ${label}`);
  if (!cond) failures++;
}

function stubApi() {
  const calls = [];
  return { calls, scrollToContent: (target, opts) => calls.push({ target, opts }) };
}

const slot = { id: "slot-1", x: 900, y: 40, width: 512, height: 512, customData: { generating: true } };
const plain = { id: "img-1", x: 0, y: 0, width: 512, height: 512, customData: {} };
const filled = { id: "slot-1", x: 900, y: 40, width: 512, height: 512, customData: {} };
const deleted = { id: "slot-2", isDeleted: true, customData: { generating: true } };

// 1. Focuses a fresh slot.
{
  const api = stubApi();
  const seen = new Set();
  const moved = focusGeneratingSlots(api, [plain, slot], seen);
  check("focuses a new generating slot", moved === true && api.calls.length === 1);
  check("targets only the generating slot", api.calls[0]?.target.length === 1 && api.calls[0].target[0].id === "slot-1");
  check("records the slot as seen", seen.has("slot-1"));
  const o = api.calls[0]?.opts ?? {};
  check("uses fitToViewport with headroom", o.fitToViewport === true && o.viewportZoomFactor === 0.6);
  check("caps zoom at 1:1", o.maxZoom === 1);
  check("animates", o.animate === true);
}

// 2. Does not re-focus the same slot on a later sync.
{
  const api = stubApi();
  const seen = new Set(["slot-1"]);
  const moved = focusGeneratingSlots(api, [plain, slot], seen);
  check("skips an already-focused slot", moved === false && api.calls.length === 0);
}

// 3. A second slot appearing mid-batch still focuses, and both get framed.
{
  const api = stubApi();
  const seen = new Set(["slot-1"]);
  const slot2 = { ...slot, id: "slot-9", x: 1500 };
  const moved = focusGeneratingSlots(api, [slot, slot2], seen);
  check("focuses when a new slot joins a batch", moved === true && api.calls[0].target.length === 2);
  check("marks the new slot seen", seen.has("slot-9"));
}

// 4. No generating slots -> viewport untouched.
{
  const api = stubApi();
  check("no-op when nothing is generating", focusGeneratingSlots(api, [plain, filled], new Set()) === false && api.calls.length === 0);
}

// 5. Deleted placeholders are ignored.
{
  const api = stubApi();
  check("ignores deleted slots", focusGeneratingSlots(api, [deleted], new Set()) === false);
}

// 6. Missing/immature api must not throw.
{
  check("tolerates a missing api", focusGeneratingSlots(null, [slot], new Set()) === false);
  check("tolerates api without scrollToContent", focusGeneratingSlots({}, [slot], new Set()) === false);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
