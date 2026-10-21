import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * 工单37W - BL-01 step 2: cap templates and "a cap set by hand is not overwritten".
 *
 * Migration `20261021000010_hahart_member_cap_settings.sql`. A member's cap lives in
 * `member_cap_settings` across months; `apply_cap_template` skips people set by hand.
 * Real SQL on PGlite.
 */

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";
const NEXT_MONTH_SQL = `(${MONTH_SQL} + interval '1 month')::date`;
const TODAY_SQL = "(now() at time zone 'Asia/Shanghai')::date";

let db: PGlite;
let userSeq = 0;

type Actor = { userId: string; workspaceId: string };

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

async function sqlCode(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return "no-error";
}

/** One new user per case: signup creates the personal workspace, so nothing is shared. */
async function newActor(): Promise<Actor> {
  userSeq += 1;
  const userId = `00000000-0000-0000-0000-000000037e${String(userSeq).padStart(2, "0")}`;
  await createUser(db, userId, `user-37w-${userSeq}@hahart.test`);

  const row = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1::uuid and type = 'personal'",
        [userId],
      )
    ).rows,
  );
  return { userId, workspaceId: row.id };
}

async function newTemplate(workspaceId: string, name: string, cap: number): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.credit_cap_templates (workspace_id, name, cap)
         values ($1::uuid, $2::text, $3::integer) returning id`,
        [workspaceId, name, cap],
      )
    ).rows,
  ).id;
}

async function applyTemplate(
  workspaceId: string,
  templateId: string,
  userIds: string[],
): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        "select public.apply_cap_template($1::uuid, $2::uuid, $3::uuid[]) as n",
        [workspaceId, templateId, userIds],
      )
    ).rows,
  ).n;
}

async function effectiveCap(workspaceId: string, userId: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ cap: number }>("select public.member_personal_cap($1::uuid, $2::uuid) as cap", [
        workspaceId,
        userId,
      ])
    ).rows,
  ).cap;
}

async function setCap(actor: Actor, cap: number): Promise<void> {
  await db.query("select public.set_personal_cap($1::uuid, $2::uuid, $3::integer)", [
    actor.workspaceId,
    actor.userId,
    cap,
  ]);
}

async function settingSource(actor: Actor): Promise<string | undefined> {
  const rows = (
    await db.query<{ source: string }>(
      "select source from public.member_cap_settings where workspace_id = $1::uuid and user_id = $2::uuid",
      [actor.workspaceId, actor.userId],
    )
  ).rows;
  return rows[0]?.source;
}

async function thisMonthCap(actor: Actor): Promise<number | undefined> {
  const rows = (
    await db.query<{ personal_cap: number }>(
      `select personal_cap from public.member_team_usage
       where workspace_id = $1::uuid and user_id = $2::uuid and period_month = ${MONTH_SQL}`,
      [actor.workspaceId, actor.userId],
    )
  ).rows;
  return rows[0]?.personal_cap;
}

async function setPool(actor: Actor, limit: number, used: number): Promise<void> {
  await db.query(
    `insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used)
     values ($1::uuid, ${MONTH_SQL}, $2::integer, $3::integer)`,
    [actor.workspaceId, limit, used],
  );
}

async function setWallet(actor: Actor, daily: number, topup: number): Promise<void> {
  await db.query(
    `insert into public.user_credit_wallets (user_id, daily_date, daily_balance, topup_balance)
     values ($1::uuid, ${TODAY_SQL}, $2::integer, $3::integer)
     on conflict (user_id) do update
       set daily_date = excluded.daily_date,
           daily_balance = excluded.daily_balance,
           topup_balance = excluded.topup_balance`,
    [actor.userId, daily, topup],
  );
}

async function deduct(actor: Actor, amount: number): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "select public.deduct_from_pools($1::uuid, $2::uuid, $3::integer, null, 'test') as id",
        [actor.workspaceId, actor.userId, amount],
      )
    ).rows,
  ).id;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("cap templates and member cap settings (37W)", () => {
  it("BL-01: applying 实习 10000 sets the cap", async () => {
    const actor = await newActor();
    const tpl = await newTemplate(actor.workspaceId, "实习", 10000);

    const applied = await applyTemplate(actor.workspaceId, tpl, [actor.userId]);

    expect(applied).toBe(1);
    expect(await effectiveCap(actor.workspaceId, actor.userId)).toBe(10000);
    expect(await thisMonthCap(actor)).toBe(10000);
  });

  it("BL-01: a cap set by hand is not overwritten by a template", async () => {
    const actor = await newActor();
    const tpl = await newTemplate(actor.workspaceId, "实习", 10000);
    await setCap(actor, 15000);

    const applied = await applyTemplate(actor.workspaceId, tpl, [actor.userId]);

    expect(applied).toBe(0);
    expect(await effectiveCap(actor.workspaceId, actor.userId)).toBe(15000);
    expect(await settingSource(actor)).toBe("manual");
    expect(await thisMonthCap(actor)).toBe(15000);
  });

  it("BL-01: the template reaches only those who were not set by hand", async () => {
    const a = await newActor();
    const b = await newActor();
    const tpl = await newTemplate(a.workspaceId, "实习", 10000);
    await setCap(a, 15000);

    const applied = await applyTemplate(a.workspaceId, tpl, [a.userId, b.userId]);

    expect(applied).toBe(1);
    expect(await effectiveCap(a.workspaceId, b.userId)).toBe(10000);
    expect(await effectiveCap(a.workspaceId, a.userId)).toBe(15000);
  });

  it("BL-01: the cap survives into next month", async () => {
    const actor = await newActor();
    const tpl = await newTemplate(actor.workspaceId, "实习", 10000);
    await applyTemplate(actor.workspaceId, tpl, [actor.userId]);

    await db.query(
      `insert into public.member_team_usage (workspace_id, user_id, period_month)
       values ($1::uuid, $2::uuid, ${NEXT_MONTH_SQL})`,
      [actor.workspaceId, actor.userId],
    );

    const row = firstRow(
      (
        await db.query<{ personal_cap: number }>(
          `select personal_cap from public.member_team_usage
           where workspace_id = $1::uuid and user_id = $2::uuid and period_month = ${NEXT_MONTH_SQL}`,
          [actor.workspaceId, actor.userId],
        )
      ).rows,
    );
    expect(row.personal_cap).toBe(10000);
  });

  it("BL-01: the charge function uses the member's setting when this month has no row", async () => {
    const actor = await newActor();
    await setPool(actor, 60000, 0);
    await db.query(
      `insert into public.member_cap_settings (workspace_id, user_id, cap, source)
       values ($1::uuid, $2::uuid, 10, 'manual')`,
      [actor.workspaceId, actor.userId],
    );

    expect(await sqlCode(deduct(actor, 11))).toBe("P0403");

    await deduct(actor, 10);
    expect(await thisMonthCap(actor)).toBe(10);
  });

  it("BL-01: a member with no setting keeps the default 20000", async () => {
    const actor = await newActor();

    expect(await effectiveCap(actor.workspaceId, actor.userId)).toBe(20000);
  });

  it("BL-01: a template from another workspace is refused", async () => {
    const a = await newActor();
    const b = await newActor();
    const foreign = await newTemplate(b.workspaceId, "实习", 10000);

    const code = await sqlCode(applyTemplate(a.workspaceId, foreign, [a.userId]));

    expect(code).toBe("22023");
    expect(await settingSource(a)).toBeUndefined();
  });

  it("BL-01: an explicit cap in an insert is kept", async () => {
    const actor = await newActor();
    const tpl = await newTemplate(actor.workspaceId, "实习", 10000);
    await applyTemplate(actor.workspaceId, tpl, [actor.userId]);
    await db.query(
      "delete from public.member_team_usage where workspace_id = $1::uuid and user_id = $2::uuid",
      [actor.workspaceId, actor.userId],
    );

    await db.query(
      `insert into public.member_team_usage (workspace_id, user_id, period_month, personal_cap)
       values ($1::uuid, $2::uuid, ${MONTH_SQL}, 5)`,
      [actor.workspaceId, actor.userId],
    );

    expect(await thisMonthCap(actor)).toBe(5);
  });

  it("37N regression: deduct_from_pools still charges daily, then team, then top-up", async () => {
    const actor = await newActor();
    await setPool(actor, 100, 0);
    await setWallet(actor, 10, 50);

    const id = await deduct(actor, 130);

    const tx = firstRow(
      (
        await db.query<{ pool: string | null; pool_breakdown: Record<string, number> }>(
          "select pool, pool_breakdown from public.credit_transactions where id = $1::uuid",
          [id],
        )
      ).rows,
    );
    expect(tx.pool).toBeNull();
    expect(tx.pool_breakdown).toEqual({ daily: 10, team: 100, topup: 20 });
  });

  it("security: only the service role may call them", async () => {
    const actor = await newActor();
    const tpl = await newTemplate(actor.workspaceId, "实习", 10000);

    const applyCall = await sqlCode(
      asUser(db, actor.userId, (tx) =>
        tx.query("select public.apply_cap_template($1::uuid, $2::uuid, $3::uuid[])", [
          actor.workspaceId,
          tpl,
          [actor.userId],
        ]),
      ),
    );
    const capCall = await sqlCode(
      asUser(db, actor.userId, (tx) =>
        tx.query("select public.member_personal_cap($1::uuid, $2::uuid)", [
          actor.workspaceId,
          actor.userId,
        ]),
      ),
    );

    expect(applyCall).toBe("42501");
    expect(capCall).toBe("42501");
  });
});
