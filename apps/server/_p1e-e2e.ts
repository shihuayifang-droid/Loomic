// P1-e end-to-end: does the gateway actually HONOUR the inpaint mask?
//
// WHAT WAS ALREADY PROVEN WITHOUT SPENDING ANYTHING
//   - the catalog declares operation:"inpaint" for kwjm/gpt-image-2-inpaint
//   - both guards are hard errors (inpaint without mask, mask without inpaint)
//   - the mask must be a PNG, because a JPEG has no alpha and the whole frame
//     would become editable
//
// WHAT ONLY REAL MONEY CAN PROVE
//   Whether the gateway reads the alpha channel at all. If it ignores the mask it
//   returns a full regeneration — which LOOKS like a successful local edit and
//   would pass every check above. That is the failure this script exists to catch.
//
// METHOD
//   Source: 1024x1024, left half solid blue, right half solid red. Solid fields
//   make any repaint measurable: there is no texture to hide a change in.
//   Mask:   opaque everywhere EXCEPT one 300x300 transparent window inside the
//           LEFT half. Transparent = "repaint here".
//   Then compare mean per-pixel difference in three zones:
//     A  inside the window        -> must change a lot
//     B  left half, outside it    -> must stay put
//     C  right half (far away)    -> must stay put
//
// NOTE ON WHAT "STAY PUT" CAN MEAN
//   /images/edits re-encodes the entire frame, so untouched areas are NOT
//   bit-identical even when the mask is respected. The discriminating signal is
//   therefore the RATIO between zone A and zones B/C, not absolute equality. A
//   gateway that ignores the mask makes all three roughly equal.
//
// Run:
//   node --env-file=../../.env.local --import tsx _p1e-e2e.ts
import { readFileSync, writeFileSync } from "node:fs";

import sharp from "sharp";

import { OpenAIImageProvider } from "./src/generation/providers/openai-image.js";

const OUT = "d:\\AnimalMafia_ArtResource\\Kiro-AnimalMafia\\scripts\\temp";
const N = 1024;
// Window inside the LEFT half. Kept clear of the centre seam so a model that
// repaints "around the middle" cannot accidentally look like a hit.
const WIN = { x0: 100, y0: 350, x1: 400, y1: 650 };

const BLUE = { r: 30, g: 60, b: 200 };
const RED = { r: 200, g: 40, b: 40 };

// PROMPT DESIGN, learned by getting it wrong once.
//
// The first attempt asked for "a yellow star ON A WHITE BACKGROUND". The model
// obliged globally and returned a white frame with a star — which is exactly what
// "mask ignored" looks like. A prompt that can produce the failure signature on
// its own is a confounder, not a test. So: never name a background, and say
// nothing about the rest of the frame that the model could apply everywhere.
const MASKED_PROMPT = "Put a small bright yellow five-pointed star here.";

// The control must not ask for any change at all: anything it repaints is
// indistinguishable from the source being discarded.
const CONTROL_PROMPT = "Return this image unchanged.";

async function buildSource(): Promise<Buffer> {
  const px = Buffer.alloc(N * N * 3);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = x < N / 2 ? BLUE : RED;
      const i = (y * N + x) * 3;
      px[i] = c.r;
      px[i + 1] = c.g;
      px[i + 2] = c.b;
    }
  }
  return sharp(px, { raw: { width: N, height: N, channels: 3 } })
    .png()
    .toBuffer();
}

/**
 * Alpha 0 inside the window, 255 outside.
 *
 * `rgb` decides what the OPAQUE-and-transparent pixels carry in their colour
 * channels, which turned out to matter: the first successful run used black and
 * the repainted window came back with a BLACK background behind the star instead
 * of the surrounding blue. So the gateway does not merely read alpha — the mask's
 * RGB reaches the output. Both variants are measured below to pin the rule the
 * frontend eraser will have to follow.
 */
async function buildMask(rgb: "black" | "source"): Promise<Buffer> {
  const px = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const inside = x >= WIN.x0 && x < WIN.x1 && y >= WIN.y0 && y < WIN.y1;
      const c = rgb === "source" ? (x < N / 2 ? BLUE : RED) : { r: 0, g: 0, b: 0 };
      px[i] = c.r;
      px[i + 1] = c.g;
      px[i + 2] = c.b;
      px[i + 3] = inside ? 0 : 255;
    }
  }
  return sharp(px, { raw: { width: N, height: N, channels: 4 } })
    .png()
    .toBuffer();
}

type Zone = { name: string; test: (x: number, y: number) => boolean };

const ZONES: Zone[] = [
  {
    name: "A inside-window (should CHANGE)",
    test: (x, y) => x >= WIN.x0 && x < WIN.x1 && y >= WIN.y0 && y < WIN.y1,
  },
  {
    name: "B left-half outside-window (should HOLD)",
    test: (x, y) =>
      x < N / 2 && !(x >= WIN.x0 && x < WIN.x1 && y >= WIN.y0 && y < WIN.y1),
  },
  { name: "C right-half (should HOLD)", test: (x) => x >= N / 2 },
];

function meanDiff(
  a: Buffer,
  b: Buffer,
  zone: Zone,
): { mean: number; count: number } {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!zone.test(x, y)) continue;
      const i = (y * N + x) * 3;
      sum +=
        Math.abs(a[i]! - b[i]!) +
        Math.abs(a[i + 1]! - b[i + 1]!) +
        Math.abs(a[i + 2]! - b[i + 2]!);
      count++;
    }
  }
  // Per-channel mean so the number is on a 0-255 scale and easy to reason about.
  return { mean: count === 0 ? 0 : sum / (count * 3), count };
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_API_BASE;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  // MASK_RGB=source is the variant that mirrors what a real eraser produces:
  // a copy of the artwork with the erased stroke punched out to alpha 0.
  const maskRgb = (process.env.MASK_RGB === "black" ? "black" : "source") as
    | "black"
    | "source";
  const srcPng = await buildSource();
  const maskPng = await buildMask(maskRgb);
  console.log(`mask rgb variant: ${maskRgb}`);
  writeFileSync(`${OUT}\\p1e-source.png`, srcPng);
  writeFileSync(`${OUT}\\p1e-mask-${maskRgb}.png`, maskPng);
  console.log(
    `built source=${srcPng.length}B mask=${maskPng.length}B ` +
      `window=${WIN.x0},${WIN.y0}-${WIN.x1},${WIN.y1}`,
  );

  const provider = new OpenAIImageProvider(apiKey, baseURL);

  async function bytesOf(result: unknown): Promise<Buffer> {
    const url = (result as { url?: string }).url ?? "";
    if (url.startsWith("data:")) return Buffer.from(url.split(",")[1]!, "base64");
    if (url) return Buffer.from(await (await fetch(url)).arrayBuffer());
    console.log("RESULT SHAPE:", JSON.stringify(result).slice(0, 400));
    throw new Error("could not locate image bytes in provider result");
  }

  // ---------------------------------------------------------------- control
  // Same source through /images/edits with NO mask, using the plain generate
  // model. Its job is to separate two very different diagnoses that the masked
  // call alone cannot tell apart:
  //
  //   control preserves the source  ->  edits works; a discarded source is the
  //                                     MASK path's fault
  //   control also discards it      ->  this gateway's /images/edits does not
  //                                     edit at all; it just generates, and the
  //                                     mask is irrelevant
  //
  // Without this, "mask ignored" would be a guess.
  // SKIP_CONTROL reuses the control image from a previous run. The control's only
  // job is to prove this endpoint preserves an unmasked source, which does not
  // change between runs — so re-running it on every variant just burns credits.
  let controlBuf: Buffer;
  if (process.env.SKIP_CONTROL === "1") {
    controlBuf = readFileSync(`${OUT}\\p1e-control.png`);
    console.log(`control: REUSED from disk (${controlBuf.length}B), not re-called`);
  } else {
    console.log("control: kwjm/gpt-image-2 through /images/edits, NO mask ...");
    const tC = Date.now();
    const control = await provider.generate({
      model: "kwjm/gpt-image-2",
      prompt: CONTROL_PROMPT,
      aspectRatio: "1:1",
      quality: "standard",
      inputImages: [`data:image/png;base64,${srcPng.toString("base64")}`],
    } as Parameters<typeof provider.generate>[0]);
    controlBuf = await bytesOf(control);
    writeFileSync(`${OUT}\\p1e-control.png`, controlBuf);
    console.log(`  control returned in ${Date.now() - tC}ms ${controlBuf.length}B`);
  }

  // ---------------------------------------------------------------- masked
  console.log("masked: kwjm/gpt-image-2-inpaint WITH mask ...");
  const t0 = Date.now();
  const result = await provider.generate({
    model: "kwjm/gpt-image-2-inpaint",
    prompt: MASKED_PROMPT,
    aspectRatio: "1:1",
    // standard -> 1024x1024, matching the source, so zones line up without
    // resampling. It is also the cheapest tier.
    quality: "standard",
    inputImages: [`data:image/png;base64,${srcPng.toString("base64")}`],
    mask: `data:image/png;base64,${maskPng.toString("base64")}`,
  } as Parameters<typeof provider.generate>[0]);
  console.log(`  masked returned in ${Date.now() - t0}ms`);

  const outBuf = await bytesOf(result);
  writeFileSync(`${OUT}\\p1e-result.png`, outBuf);

  const meta = await sharp(outBuf).metadata();
  console.log(`result: ${meta.width}x${meta.height} ${meta.format} ${outBuf.length}B`);

  if (meta.width !== N || meta.height !== N) {
    console.log(
      `NOTE: result is ${meta.width}x${meta.height}, resizing to ${N}x${N} to ` +
        `compare zones. Interpolation adds noise to every zone equally, so the ` +
        `A-vs-B/C ratio is still meaningful.`,
    );
  }

  const srcRaw = await sharp(srcPng).removeAlpha().raw().toBuffer();
  const norm = (b: Buffer) =>
    sharp(b).resize(N, N, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const outRaw = await norm(outBuf);
  const ctlRaw = await norm(controlBuf);

  const measure = (raw: Buffer) =>
    ZONES.map((z) => ({ zone: z, ...meanDiff(srcRaw, raw, z) }));

  console.log("\nmasked call vs source:");
  const masked = measure(outRaw);
  for (const r of masked) {
    console.log(
      `  ${r.zone.name.padEnd(42)} meanDiff=${r.mean.toFixed(1).padStart(6)} px=${r.count}`,
    );
  }

  console.log("\ncontrol call (no mask, 'return unchanged') vs source:");
  const ctl = measure(ctlRaw);
  for (const r of ctl) {
    console.log(
      `  ${r.zone.name.padEnd(42)} meanDiff=${r.mean.toFixed(1).padStart(6)} px=${r.count}`,
    );
  }

  const A = masked[0]!.mean;
  const B = masked[1]!.mean;
  const C = masked[2]!.mean;
  const holdMax = Math.max(B, C);
  const ratio = holdMax === 0 ? Infinity : A / holdMax;
  // How well the control held the source. If this is high, the endpoint is not
  // preserving inputs at all and the mask never had a chance.
  const ctlHold = Math.max(ctl[1]!.mean, ctl[2]!.mean);

  console.log("");
  console.log(`  masked  A/max(B,C) ratio = ${ratio.toFixed(2)}`);
  console.log(`  control max hold-zone diff = ${ctlHold.toFixed(1)}`);

  // Three outcomes, deliberately distinguished. Reporting all three as one
  // "mask not honoured" line was the mistake in the first version of this script:
  // it would have blamed the mask for an endpoint that does not edit at all.
  //
  // Thresholds:
  //   A > 30   the window must visibly differ (blue -> yellow star moves >100)
  //   ratio>=3 the local-edit signature; mask ignored puts all zones together
  //   ctlHold<40 the endpoint demonstrably preserves an unmasked source
  const HOLD_OK = 40;
  console.log("");
  let verdict: string;
  const notes: string[] = [];
  if (ctlHold >= HOLD_OK) {
    verdict = "EDITS-ENDPOINT-DOES-NOT-EDIT";
    notes.push(
      `the control asked for the image back unchanged and still came back ` +
        `${ctlHold.toFixed(1)} away from it, so this gateway's /images/edits ` +
        `regenerates rather than edits`,
    );
    notes.push(
      "the mask question is therefore MOOT here — no mask can constrain an " +
        "endpoint that discards the source",
    );
  } else if (A > 30 && ratio >= 3) {
    verdict = "MASK-HONOURED";
    notes.push("the window was repainted and the rest of the frame held");
  } else if (A <= 30) {
    verdict = "MASK-WINDOW-NOT-PAINTED";
    notes.push(
      `zone A barely moved (${A.toFixed(1)}) while the control preserved the ` +
        `source — the mask was accepted but nothing was painted into it`,
    );
  } else {
    verdict = "MASK-IGNORED";
    notes.push(
      `the control preserved the source (${ctlHold.toFixed(1)}) but the masked ` +
        `call moved every zone about equally (ratio ${ratio.toFixed(2)}), so the ` +
        `alpha channel is not being read`,
    );
  }

  console.log(`VERDICT: ${verdict}`);
  for (const n of notes) console.log(`  - ${n}`);
  console.log(`\nMASK_USABLE: ${verdict === "MASK-HONOURED" ? "yes" : "no"}`);
  // Does the repainted window sit on the surrounding colour, or on whatever the
  // mask carried in RGB? Sampled just inside the window edge, away from the star
  // in the middle. This is the rule the frontend eraser depends on.
  const inWin = (dx: number, dy: number) => {
    const x = WIN.x0 + dx;
    const y = WIN.y0 + dy;
    const i = (y * N + x) * 3;
    return `rgb(${outRaw[i]},${outRaw[i + 1]},${outRaw[i + 2]})`;
  };
  console.log("");
  console.log(`  window corner samples (expect ~rgb(30,60,200) if it blends`);
  console.log(`  with the surrounding blue, ~rgb(0,0,0) if mask RGB leaked):`);
  console.log(`    top-left  +6,+6   ${inWin(6, 6)}`);
  console.log(`    bot-right +293,+293 ${inWin(293, 293)}`);

  console.log("");
  console.log(
    `artifacts: ${OUT}\\p1e-{source,mask-${maskRgb},control,result}.png`,
  );
}

main().catch((e) => {
  console.log("SCRIPT ERROR:", e?.message ?? String(e));
  if (e?.code) console.log("  code:", e.code);
  if (e?.providerName) console.log("  provider:", e.providerName);
  process.exit(1);
});
