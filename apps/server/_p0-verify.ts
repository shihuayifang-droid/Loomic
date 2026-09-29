// P0-1 verification: the unbilled direct path must no longer be reachable by
// accident, and the intentional escape hatch must still work.
//
// Run: node --import tsx _p0-verify.ts
import { createVideoGenerateTool } from "./src/agent/tools/video-generate.js";
import { createImageGenerateTool } from "./src/agent/tools/image-generate.js";

let failures = 0;
function check(label: string, fn: () => void, expectThrow: boolean) {
  let threw = false;
  let message = "";
  try {
    fn();
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  const ok = threw === expectThrow;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label} -> ${threw ? "threw" : "constructed"}` +
      (threw ? `\n       ${message.slice(0, 110)}...` : ""),
  );
}

const fakeSubmitVideo = async () => ({ jobId: "j1" });
const fakeSubmitImage = async () => ({ jobId: "j1" });

console.log("=== video ===");
check("no args (was the live leak via sub-agents.ts)", () => {
  createVideoGenerateTool();
}, true);
check("empty deps object", () => {
  createVideoGenerateTool({});
}, true);
check("only availableModels, no job channel", () => {
  createVideoGenerateTool({ availableModels: [] });
}, true);
check("with submitVideoJob", () => {
  createVideoGenerateTool({ submitVideoJob: fakeSubmitVideo as never });
}, false);
check("explicit allowUnbilledDirect (test escape hatch)", () => {
  createVideoGenerateTool({ allowUnbilledDirect: true });
}, false);

console.log("\n=== image ===");
check("no args", () => {
  createImageGenerateTool();
}, true);
check("only persistImage, no job channel", () => {
  createImageGenerateTool({ persistImage: (async () => "u") as never });
}, true);
check("with submitImageJob", () => {
  createImageGenerateTool({ submitImageJob: fakeSubmitImage as never });
}, false);
check("explicit allowUnbilledDirect", () => {
  createImageGenerateTool({ allowUnbilledDirect: true });
}, false);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
