import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCanonicalDb, createCanonicalUser } from "../test-support/db/canonical-db.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "../test-support/db/pglite-db.js";
import {
  createCreditLedgerFunctionRepository,
  type CreditLedgerFunctionRepository,
} from "./credit-ledger-function-repository.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Workorder 44J: the credit ledger function repository, run on the same set of
 * cases against the retired supabase migration chain ("legacy") and against the
 * canonical schema ("canonical"). Both must behave the same.
 */

const USER_ID = "00000000-0000-0000-0000-0000000044a1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Fixture = {
  db: PGlite;
  repository: CreditLedgerFunctionRepository;
  workspaceId: string;
};

async function setupLegacy(): Promise<Fixture> {
  const { db } = await createMigratedDb();
  await createUser(db, USER_ID, "u-44j@hahart.test");
  return finishSetup(db);
}

async function setupCanonical(): Promise<Fixture> {
  const { db } = await createCanonicalDb();
  await createCanonicalUser(db, USER_ID, "u-44j@hahart.test");
  return finishSetup(db);
}

async function finishSetup(db: PGlite): Promise<Fixture> {
  const workspace = await db.query<{ id: string }>(
    "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
    [USER_ID],
  );
  const workspaceRow = workspace.rows[0];
  if (workspaceRow === undefined) throw new Error("no personal workspace");

  // Make sure a balance row exists, whichever way the schema created it.
  await db.query(
    `insert into public.credit_balances (workspace_id, balance)
     values ($1, 0)
     on conflict (workspace_id) do nothing`,
    [workspaceRow.id],
  );

  const pool = createPGliteTransactionPool(db);
  return {
    db,
    repository: createCreditLedgerFunctionRepository({ getTransactionPool: () => pool }),
    workspaceId: workspaceRow.id,
  };
}

async function setBalance(fx: Fixture, balance: number): Promise<void> {
  await fx.db.query("update public.credit_balances set balance = $2 where workspace_id = $1", [
    fx.workspaceId,
    balance,
  ]);
}

async function balanceOf(fx: Fixture): Promise<number> {
  const result = await fx.db.query<{ balance: number }>(
    "select balance from public.credit_balances where workspace_id = $1",
    [fx.workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("no balance row");
  return Number(row.balance);
}

async function insertJob(fx: Fixture, jobId: string): Promise<void> {
  await fx.db.query(
    `insert into public.background_jobs (id, workspace_id, queue_name, job_type, created_by)
     values ($1, $2, 'image', 'image_generation', $3)`,
    [jobId, fx.workspaceId, USER_ID],
  );
}

async function capture(fn: () => Promise<unknown>): Promise<{ code?: unknown; message: string }> {
  try {
    await fn();
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    return { code: e.code, message: String(e.message) };
  }
  throw new Error("expected the call to throw");
}

type Outcome = {
  deductDelta: number;
  deductIsUuid: boolean;
  shortCode: unknown;
  shortBalanceKept: boolean;
  refundDelta: number;
  refundRepeatSameId: boolean;
  refundRepeatDelta: number;
  claimFirst: boolean;
  claimSecond: boolean;
  grantBalanceDelta: number;
  grantPlan: string;
  badPlanCode: unknown;
};

const outcomes = new Map<string, Outcome>();

describe.each([
  ["legacy", setupLegacy],
  ["canonical", setupCanonical],
] as const)("credit ledger function repository on the %s schema", (name, setup) => {
  let fx: Fixture;
  const outcome: Partial<Outcome> = {};

  beforeAll(async () => {
    fx = await setup();
  }, 120_000);

  afterAll(async () => {
    await fx.db.close();
  });

  it("deducts credits: returns a ledger id and lowers the balance", async () => {
    await setBalance(fx, 100);

    const id = await fx.repository.deductCredits({
      workspaceId: fx.workspaceId,
      userId: USER_ID,
      amount: 30,
      description: "44j deduct",
    });

    expect(id).toMatch(UUID_PATTERN);
    expect(await balanceOf(fx)).toBe(70);

    const ledger = await fx.db.query<{ amount: number; transaction_type: string }>(
      "select amount, transaction_type from public.credit_transactions where id = $1",
      [id],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(Number(ledger.rows[0]!.amount)).toBe(-30);
    expect(ledger.rows[0]!.transaction_type).toBe("generation_deduct");

    outcome.deductDelta = 100 - (await balanceOf(fx));
    outcome.deductIsUuid = UUID_PATTERN.test(id);
  });

  it("refuses an overdraft with P0402 and leaves the balance alone", async () => {
    await setBalance(fx, 10);

    const failure = await capture(() =>
      fx.repository.deductCredits({
        workspaceId: fx.workspaceId,
        userId: USER_ID,
        amount: 50,
      }),
    );

    expect(failure.code).toBe("P0402");
    expect(failure.message).toContain("INSUFFICIENT_CREDITS");
    expect(await balanceOf(fx)).toBe(10);

    outcome.shortCode = failure.code;
    outcome.shortBalanceKept = (await balanceOf(fx)) === 10;
  });

  it("refunds a charged job once: a repeat returns the same id and adds nothing", async () => {
    const jobId = "cccc0000-0000-4000-8000-0000000044a1";
    await insertJob(fx, jobId);
    await setBalance(fx, 100);

    await fx.repository.deductCredits({
      workspaceId: fx.workspaceId,
      userId: USER_ID,
      amount: 40,
      jobId,
    });
    expect(await balanceOf(fx)).toBe(60);

    const first = await fx.repository.refundCredits({
      workspaceId: fx.workspaceId,
      userId: USER_ID,
      amount: 40,
      jobId,
      description: "44j refund",
    });
    expect(first).toMatch(UUID_PATTERN);
    expect(await balanceOf(fx)).toBe(100);
    const afterFirst = await balanceOf(fx);

    const second = await fx.repository.refundCredits({
      workspaceId: fx.workspaceId,
      userId: USER_ID,
      amount: 40,
      jobId,
    });
    expect(second).toBe(first);
    expect(await balanceOf(fx)).toBe(100);

    outcome.refundDelta = afterFirst - 60;
    outcome.refundRepeatSameId = second === first;
    outcome.refundRepeatDelta = (await balanceOf(fx)) - afterFirst;
  });

  it("claims the daily credits once per day", async () => {
    await setBalance(fx, 0);

    const first = await fx.repository.claimDailyCredits({
      workspaceId: fx.workspaceId,
      amount: 25,
    });
    const second = await fx.repository.claimDailyCredits({
      workspaceId: fx.workspaceId,
      amount: 25,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await balanceOf(fx)).toBe(25);

    outcome.claimFirst = first;
    outcome.claimSecond = second;
  });

  it("changes the plan and grants its credits; an unknown plan carries a code", async () => {
    await setBalance(fx, 5);

    const balance = await fx.repository.grantPlanCredits({
      workspaceId: fx.workspaceId,
      plan: "pro",
      credits: 300,
    });

    expect(typeof balance).toBe("number");
    expect(balance).toBe(305);
    expect(await balanceOf(fx)).toBe(305);

    const subscription = await fx.db.query<{ plan: string }>(
      "select plan from public.subscriptions where workspace_id = $1",
      [fx.workspaceId],
    );
    expect(subscription.rows[0]!.plan).toBe("pro");

    const failure = await capture(() =>
      fx.repository.grantPlanCredits({
        workspaceId: fx.workspaceId,
        plan: "no-such-plan",
        credits: 10,
      }),
    );
    expect(failure.code).toBe("22P02");
    expect(await balanceOf(fx)).toBe(305);

    outcome.grantBalanceDelta = balance - 5;
    outcome.grantPlan = subscription.rows[0]!.plan;
    outcome.badPlanCode = failure.code;
  });

  it("records the outcome of this schema", () => {
    outcomes.set(name, outcome as Outcome);
    expect(Object.keys(outcome)).toHaveLength(12);
  });
});

describe("credit ledger function repository: both schemas agree", () => {
  it("gives the same results on legacy and canonical", () => {
    const legacy = outcomes.get("legacy");
    const canonical = outcomes.get("canonical");
    expect(legacy).toBeDefined();
    expect(canonical).toBeDefined();
    expect(canonical).toEqual(legacy);
  });
});
