import { describe, expect, it } from "vitest";

import {
  createSpendGuard,
  InvalidCreditAmountError,
  SpendGuard,
  TASK_CREDIT_LIMIT,
} from "./spend-guard.js";

describe("spend-guard: the task credit budget (QA-15)", () => {
  it("exports the 200-credit task limit and uses it by default", () => {
    expect(TASK_CREDIT_LIMIT).toBe(200);
    expect(createSpendGuard().limit).toBe(200);
  });

  it("allows charges that stay under the limit", () => {
    const guard = createSpendGuard();

    const first = guard.charge(50);
    expect(first).toMatchObject({ allowed: true, charged: 50, spent: 50, limit: 200 });
    expect(first.code).toBeUndefined();

    const second = guard.charge(100);
    expect(second).toMatchObject({ allowed: true, charged: 100, spent: 150 });
    expect(guard.spent).toBe(150);
    expect(guard.remaining).toBe(50);
    expect(guard.blocked).toBe(false);
  });

  it("allows a charge that lands exactly on the limit", () => {
    const guard = createSpendGuard();

    expect(guard.charge(150).allowed).toBe(true);
    expect(guard.wouldExceed(50)).toBe(false);

    const exact = guard.charge(50);
    expect(exact).toMatchObject({ allowed: true, charged: 50, spent: 200 });
    expect(exact.code).toBeUndefined();
    expect(guard.spent).toBe(200);
    expect(guard.remaining).toBe(0);
  });

  it("refuses the charge that would exceed the limit by one credit, with the right code", () => {
    const guard = createSpendGuard();
    guard.charge(200);

    expect(guard.wouldExceed(1)).toBe(true);

    const refused = guard.charge(1);
    expect(refused.allowed).toBe(false);
    expect(refused.code).toBe("task_budget_exceeded");
    expect(refused.charged).toBe(0);
    expect(refused.spent).toBe(200);
    expect(guard.spent).toBe(200);
  });

  it("keeps refusing after the first refusal and never moves the total", () => {
    let clock = 1_000;
    const guard = createSpendGuard({ now: () => (clock += 1) });

    guard.charge(190);
    const refusal = guard.charge(20);
    expect(refusal).toMatchObject({ allowed: false, code: "task_budget_exceeded", spent: 190 });

    // A later, affordable amount is still refused: a budget stop ends the task.
    const later = guard.charge(1);
    expect(later.allowed).toBe(false);
    expect(later.code).toBe("task_budget_exceeded");
    expect(later.charged).toBe(0);
    expect(guard.spent).toBe(190);

    // The total is the sum of the allowed charges only.
    expect(guard.charge(5).spent).toBe(190);
    expect(guard.wouldExceed(0)).toBe(true);
    expect(guard.blocked).toBe(true);
    expect(guard.blockedAt).not.toBeNull();
  });

  it("starts a fresh count after reset()", () => {
    const guard = createSpendGuard();
    guard.charge(200);
    expect(guard.charge(1).allowed).toBe(false);
    expect(guard.blocked).toBe(true);

    guard.reset();

    expect(guard.spent).toBe(0);
    expect(guard.remaining).toBe(200);
    expect(guard.blocked).toBe(false);
    expect(guard.blockedAt).toBeNull();
    expect(guard.wouldExceed(200)).toBe(false);
    expect(guard.charge(200)).toMatchObject({ allowed: true, charged: 200, spent: 200 });
  });

  it("throws on a negative or non-finite amount instead of silently ignoring it", () => {
    const guard = createSpendGuard();

    expect(() => guard.charge(-1)).toThrow(InvalidCreditAmountError);
    expect(() => guard.charge(-1)).toThrow(/finite number >= 0/);
    expect(() => guard.charge(Number.NaN)).toThrow(InvalidCreditAmountError);
    expect(() => guard.charge(Number.POSITIVE_INFINITY)).toThrow(InvalidCreditAmountError);
    expect(() => guard.wouldExceed(-5)).toThrow(InvalidCreditAmountError);
    expect(() => guard.wouldExceed(Number.NaN)).toThrow(InvalidCreditAmountError);

    // The bad calls were programming errors, not charges: nothing was spent.
    expect(guard.spent).toBe(0);
    expect(guard.blocked).toBe(false);
  });

  it("honours an explicit limit and exposes the same behaviour through the class", () => {
    const guard = new SpendGuard({ limit: 10 });
    const viaFactory = createSpendGuard({ limit: 10 });

    for (const candidate of [guard, viaFactory]) {
      expect(candidate.charge(4).allowed).toBe(true);
      expect(candidate.charge(7).allowed).toBe(false);
      expect(candidate.spent).toBe(4);
    }
    expect(() => createSpendGuard({ limit: -1 })).toThrow(InvalidCreditAmountError);
  });
});
