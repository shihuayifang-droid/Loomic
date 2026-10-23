import { describe, expect, it } from "vitest";

import { batchSlotBounds } from "../src/lib/batch-slots";

const SOURCE = { x: 100, y: 50, width: 300, height: 200 };

describe("AG-07: batchSlotBounds", () => {
  it("count 1 returns no extra slots", () => {
    expect(batchSlotBounds(SOURCE, 1)).toEqual([]);
  });

  it("count 3 returns two slots to the right, 24 apart", () => {
    const slots = batchSlotBounds(SOURCE, 3);
    expect(slots).toHaveLength(2);
    expect(slots[0]).toEqual({ x: 100 + 324, y: 50, width: 300, height: 200 });
    expect(slots[1]).toEqual({ x: 100 + 2 * 324, y: 50, width: 300, height: 200 });
  });

  it("count 10 returns nine slots and wraps to a second row after five", () => {
    const slots = batchSlotBounds(SOURCE, 10);
    expect(slots).toHaveLength(9);
    // slots[3] is the 5th overall (source + 4) -> still row one
    expect(slots[3]?.y).toBe(50);
    // slots[4] is the 6th overall -> second row, back at the source x
    expect(slots[4]?.x).toBe(SOURCE.x);
    expect(slots[4]?.y).toBe(50 + 200 + 24);
    expect(slots[8]?.x).toBe(100 + 4 * 324);
    expect(slots[8]?.y).toBe(50 + 200 + 24);
  });
});