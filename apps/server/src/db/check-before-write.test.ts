import { describe, expect, it } from "vitest";

import { createIdentityWriteRepository } from "./identity-write-repository.js";
import { createPoolGrantWriteRepository } from "./pool-grant-write-repository.js";
import type { TransactionPool } from "./transaction.js";

/**
 * Workorder 45CT (OP-21), "look before you write".
 *
 * These are SQL-level tests: a fake pool records every statement the
 * repositories actually send, so "the second call does not write" is asserted
 * on the statements themselves (only SELECTs left) rather than on row counts,
 * which the idempotent SQL functions would keep equal even while writing.
 *
 * The fake answers exactly the statements the two repositories are allowed to
 * send and throws on anything else, so a new statement cannot sneak into a
 * "read-only" path unnoticed.
 */

const USER_ID = "00000000-0000-0000-0000-00000045c001";
const TEAM_WORKSPACE_ID = "00000000-0000-0000-0000-00000045c002";

/** A statement that changes data, or calls a function that does. */
const WRITE_STATEMENT = /insert|update|delete|bootstrap_viewer|grant_daily_credits/i;

type Statement = { sql: string; params?: readonly unknown[] };

type FakeState = {
  /** Does the user already have profile + personal workspace + owner membership? */
  foundationExists: boolean;
  /** Does the wallet already carry today's `daily_date`? */
  dailyGrantedToday: boolean;
  /** Every statement the repositories sent, in order. */
  statements: Statement[];
};

function createState(): FakeState {
  return { foundationExists: false, dailyGrantedToday: false, statements: [] };
}

function createFakePool(state: FakeState): TransactionPool {
  return {
    async connect() {
      return {
        async query(sql: string, params?: readonly unknown[]) {
          state.statements.push(params === undefined ? { sql } : { sql, params });

          const text = sql.toLowerCase();

          if (text === "begin" || text === "commit" || text === "rollback") {
            return { rows: [] };
          }
          if (text.includes("set_config")) return { rows: [] };

          if (text.includes("public.bootstrap_viewer")) {
            state.foundationExists = true;
            return { rows: [{ v: USER_ID }] };
          }
          if (text.includes("public.grant_daily_credits")) {
            state.dailyGrantedToday = true;
            return { rows: [{ granted: true }] };
          }

          // The two existence probes, answered from the flags above.
          if (text.includes("from public.profiles")) {
            return { rows: state.foundationExists ? [{ "?column?": 1 }] : [] };
          }
          if (text.includes("from public.user_credit_wallets")) {
            return {
              rows: state.dailyGrantedToday ? [{ "?column?": 1 }] : [],
            };
          }

          throw new Error(`unexpected statement: ${sql}`);
        },
        release() {
          // Nothing to release on a fake.
        },
      };
    },
  };
}

function statementsMatching(
  statements: readonly Statement[],
  pattern: RegExp,
): string[] {
  return statements
    .filter((statement) => pattern.test(statement.sql))
    .map((statement) => statement.sql);
}

describe("identity write repository: look before you write (45CT)", () => {
  it("creates the foundation once, then answers with a read only", async () => {
    const state = createState();
    const repository = createIdentityWriteRepository({
      getTransactionPool: () => createFakePool(state),
    });
    const input = {
      userId: USER_ID,
      email: "look-before-write@hahart.test",
      userMeta: { full_name: "Look Before Write" },
    };

    await repository.bootstrapViewer(input);

    // First visit: the probe misses and the write happens.
    expect(state.foundationExists).toBe(true);
    expect(
      statementsMatching(state.statements, /bootstrap_viewer/i),
    ).toHaveLength(1);

    state.statements.length = 0;
    await repository.bootstrapViewer(input);

    const secondCall = state.statements.slice();
    expect(secondCall.length).toBeGreaterThan(0);
    expect(statementsMatching(secondCall, WRITE_STATEMENT)).toEqual([]);
    // The probe is `select 1 ... limit 1`, not `select *`.
    expect(
      secondCall.some((statement) => /select 1\s/i.test(statement.sql)),
    ).toBe(true);
  });

  it("still writes when the foundation is missing, so a new user is created", async () => {
    const state = createState();
    state.foundationExists = false;
    const repository = createIdentityWriteRepository({
      getTransactionPool: () => createFakePool(state),
    });

    await repository.bootstrapViewer({
      userId: USER_ID,
      email: null,
      userMeta: undefined,
    });

    expect(
      statementsMatching(state.statements, /bootstrap_viewer/i),
    ).toHaveLength(1);
  });
});

describe("pool grant write repository: look before you write (45CT)", () => {
  it("grants today once, then answers false without writing", async () => {
    const state = createState();
    const repository = createPoolGrantWriteRepository({
      getTransactionPool: () => createFakePool(state),
    });
    const input = { userId: USER_ID, workspaceId: TEAM_WORKSPACE_ID };

    await expect(repository.grantDailyCredits(input)).resolves.toBe(true);
    expect(
      statementsMatching(state.statements, /grant_daily_credits/i),
    ).toHaveLength(1);

    state.statements.length = 0;
    await expect(repository.grantDailyCredits(input)).resolves.toBe(false);

    const secondCall = state.statements.slice();
    expect(secondCall.length).toBeGreaterThan(0);
    expect(statementsMatching(secondCall, WRITE_STATEMENT)).toEqual([]);
    expect(
      secondCall.some((statement) => /select 1\s/i.test(statement.sql)),
    ).toBe(true);
  });

  it("still grants when the wallet has no grant for today", async () => {
    const state = createState();
    state.dailyGrantedToday = false;
    const repository = createPoolGrantWriteRepository({
      getTransactionPool: () => createFakePool(state),
    });

    await expect(
      repository.grantDailyCredits({
        userId: USER_ID,
        workspaceId: TEAM_WORKSPACE_ID,
      }),
    ).resolves.toBe(true);

    expect(
      statementsMatching(state.statements, /grant_daily_credits/i),
    ).toHaveLength(1);
  });
});
