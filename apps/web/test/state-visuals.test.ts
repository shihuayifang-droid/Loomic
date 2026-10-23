import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { formatPrice, type PriceState } from "../src/lib/price-display";
import {
  BADGE_VISUALS,
  PRICE_STATE_VISUALS,
  SLOT_STATE_VISUALS,
  TRANSPARENT_CHECKERBOARD_STYLE,
} from "../src/lib/state-visuals";

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.resolve(here, "../../../docs/design/state-visuals.md");
const barPath = path.resolve(here, "../src/components/canvas-bottom-bar.tsx");

// PriceState["status"] has no runtime array; listed literally from price-display.ts.
const PRICE_STATUSES: PriceState["status"][] = [
  "estimating",
  "priced",
  "free",
  "pending",
  "error",
];
// job-status.ts only exports TERMINAL_JOB_STATUSES (3 of 6); the six public
// statuses are listed literally from its header comment.
const SLOT_STATUSES = [
  "queued",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "canceled",
];

describe("state-visuals", () => {
  it("price states cover every PriceState status", () => {
    expect(Object.keys(PRICE_STATE_VISUALS).sort()).toEqual(
      [...PRICE_STATUSES].sort(),
    );
  });

  it("slot states cover the six public job statuses", () => {
    expect(Object.keys(SLOT_STATE_VISUALS).sort()).toEqual(
      [...SLOT_STATUSES].sort(),
    );
  });

  it("price labels match formatPrice (priced excluded)", () => {
    const states: PriceState[] = [
      { status: "estimating" },
      { status: "free" },
      { status: "pending" },
      { status: "error" },
    ];
    for (const s of states) {
      expect(formatPrice(s, "plain")).toBe(PRICE_STATE_VISUALS[s.status].label);
    }
  });

  it("failed is distinguishable from queued and retrying", () => {
    const { failed, queued, retrying } = SLOT_STATE_VISUALS;
    expect(failed.tone).not.toBe(queued.tone);
    expect(failed.icon).not.toBe(queued.icon);
    expect(failed.label).not.toBe(queued.label);
    expect(failed.tone).not.toBe(retrying.tone);
  });

  it("spec doc mentions every label", () => {
    const doc = fs.readFileSync(specPath, "utf8");
    const all = [
      ...Object.values(PRICE_STATE_VISUALS),
      ...Object.values(SLOT_STATE_VISUALS),
      ...Object.values(BADGE_VISUALS),
    ];
    for (const v of all) {
      if (v.label === "") continue; // priced: the number comes from the quote
      expect(doc, `label ${v.label}`).toContain(v.label);
    }
  });

  it("canvas-bottom-bar uses the shared checkerboard", () => {
    const src = fs.readFileSync(barPath, "utf8");
    expect(src).not.toContain("45deg");
    expect(src).toContain("TRANSPARENT_CHECKERBOARD_STYLE");
    expect(TRANSPARENT_CHECKERBOARD_STYLE.backgroundImage).toContain("45deg");
  });
});
