// Standalone check for mergeFilesForSave (apps/web/src/lib/canvas-files.ts).
// The web app has no test runner, so this strips the types off the real source
// rather than re-implementing the logic.
// Run: node scripts/check-merge-files-for-save.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, "../apps/web/src/lib/canvas-files.ts"),
  "utf8",
);

const start = src.indexOf("const documentFiles");
if (start < 0) throw new Error("documentFiles not found in source");
const body = src
  .slice(start)
  // Generic arguments on constructors first: stripping ": CanvasFileMap" before
  // this would eat the inside of `new Map<string, CanvasFileMap>()`.
  .replace(/new Map<[^>]*>\(\)/g, "new Map()")
  .replace(/\): Record<string, unknown> \{/g, ") {")
  .replace(/\): CanvasFileMap \{/g, ") {")
  .replace(/\): void \{/g, ") {")
  .replace(/: CanvasFileMap/g, "")
  .replace(/: Record<string, unknown>/g, "")
  .replace(/: Set<string>/g, "")
  .replace(/: string/g, "")
  .replace(/^export /gm, "");

const mod = new Function(
  `${body}; return { rememberDocumentFiles, mergeFilesForSave };`,
)();
const { rememberDocumentFiles, mergeFilesForSave } = mod;

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "[OK]  " : "[FAIL]"} ${label}`);
  if (!cond) failures++;
}

const CANVAS = "c1";
const bigBase64 = "data:image/png;base64," + "A".repeat(50_000);

// The server's view: two stored images (markers) and their read-time storageUrl.
rememberDocumentFiles(CANVAS, {
  img1: {
    id: "img1",
    dataURL: "oss://project-assets/ws/canvas-files/c1/img1.png",
    storageUrl: "https://example.test/img1.png",
    mimeType: "image/png",
    created: 1,
  },
  img2: {
    id: "img2",
    dataURL: "oss://project-assets/ws/canvas-files/c1/img2.png",
    storageUrl: "https://example.test/img2.png",
    mimeType: "image/png",
    created: 2,
  },
});

// The browser's view after fetching: fat base64 for img1, img2 failed to load,
// plus a brand-new image the user just pasted.
const live = {
  img1: { id: "img1", dataURL: bigBase64, mimeType: "image/png", created: 1 },
  fresh: { id: "fresh", dataURL: bigBase64, mimeType: "image/png", created: 3 },
};
const referenced = new Set(["img1", "img2", "fresh"]);

const out = mergeFilesForSave(CANVAS, live, referenced);

check(
  "stored image is saved as a marker, not bytes",
  out.img1.dataURL.startsWith("oss://"),
);
check(
  "read-time storageUrl is not written back",
  !("storageUrl" in out.img1),
);
check(
  "unloaded but referenced image is preserved",
  out.img2 && out.img2.dataURL.startsWith("oss://"),
);
check(
  "a brand-new image still carries its bytes once",
  out.fresh.dataURL === bigBase64,
);

const payloadBytes = JSON.stringify(out).length;
check(
  `payload stays small: ${payloadBytes} bytes (only the new image's bytes)`,
  payloadBytes < bigBase64.length + 2000,
);

// Unreferenced dead records must not be resurrected.
rememberDocumentFiles(CANVAS, {
  dead: { id: "dead", dataURL: "oss://project-assets/ws/x/dead.png", mimeType: "image/png", created: 9 },
});
const out2 = mergeFilesForSave(CANVAS, {}, new Set());
check("unreferenced dead record is pruned", Object.keys(out2).length === 0);

// No server record yet (first ever load) -> pass the live map straight through.
const out3 = mergeFilesForSave("unknown-canvas", live, referenced);
check("unknown canvas falls back to the live map", out3 === live);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
