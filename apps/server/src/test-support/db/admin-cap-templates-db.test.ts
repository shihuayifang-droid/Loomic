import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAdminCreditWriteRepository,
  type AdminCreditWriteRepository,
} from "../../db/admin-credit-write-repository.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";
import type { TransactionPool } from "../../db/transaction.js";

/**
 * 工单37Y - BL-01 step 3: the cap-template repository against real SQL.
 *
 * `credit_cap_templates` and `apply_cap_template` come from
 * `20261021000010_hahart_member_cap_settings.sql` (37W). The acceptance case is
 * the requirement's own sentence: apply 「实习 10000」, then set one member to
 * 15000 by hand, then apply the template again — that member keeps 15000.
 * Real SQL on PGlite through the repository the routes actually call.
 */

let db: PGlite;
let pool: TransactionPool;
let repository: AdminCreditWriteRepository;
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
  const userId = `00000000-0000-0000-0000-000000037f${String(userSeq).padStart(2, "0")}`;
  await createUser(db, userId, `user-37y-${userSeq}@hahart.test`);

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

/** The effective cap the charge function reads. */
async function effectiveCap(workspaceId: string, userId: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ cap: number }>(
        "select public.member_personal_cap($1::uuid, $2::uuid) as cap",
        [workspaceId, userId],
      )
    ).rows,
  ).cap;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createAdminCreditWriteRepository({ getTransactionPool: () => pool });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("credit cap template repository (37Y)", () => {
  it("BL-01: 实习 10000 applies, and a cap set by hand afterwards survives", async () => {
    const actor = await newActor();

    const template = await repository.createCapTemplate({
      workspaceId: actor.workspaceId,
      name: "实习",
      cap: 10000,
    });
    expect(template.name).toBe("实习");
    expect(template.cap).toBe(10000);

    const first = await repository.applyCapTemplate({
      workspaceId: actor.workspaceId,
      templateId: template.id,
      userIds: [actor.userId],
    });
    expect(first).toBe(1);
    expect(await effectiveCap(actor.workspaceId, actor.userId)).toBe(10000);

    const stored = await repository.setPersonalCap({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      cap: 15000,
    });
    expect(stored).toBe(15000);

    const second = await repository.applyCapTemplate({
      workspaceId: actor.workspaceId,
      templateId: template.id,
      userIds: [actor.userId],
    });
    expect(second).toBe(0);
    expect(await effectiveCap(actor.workspaceId, actor.userId)).toBe(15000);
  });

  it("BL-01: the list orders by cap descending", async () => {
    const actor = await newActor();

    for (const [name, cap] of [
      ["实习", 10000],
      ["主美", 40000],
      ["美术", 20000],
    ] as const) {
      await repository.createCapTemplate({
        workspaceId: actor.workspaceId,
        name,
        cap,
      });
    }

    const templates = await repository.listCapTemplates({
      workspaceId: actor.workspaceId,
    });

    expect(templates.map((template) => template.name)).toEqual([
      "主美",
      "美术",
      "实习",
    ]);
  });

  it("BL-01: a duplicate name raises 23505", async () => {
    const actor = await newActor();

    await repository.createCapTemplate({
      workspaceId: actor.workspaceId,
      name: "实习",
      cap: 10000,
    });

    const code = await sqlCode(
      repository.createCapTemplate({
        workspaceId: actor.workspaceId,
        name: "实习",
        cap: 20000,
      }),
    );

    expect(code).toBe("23505");
  });

  it("BL-01: a template from another workspace raises 22023", async () => {
    const a = await newActor();
    const b = await newActor();
    const foreign = await repository.createCapTemplate({
      workspaceId: b.workspaceId,
      name: "实习",
      cap: 10000,
    });

    const code = await sqlCode(
      repository.applyCapTemplate({
        workspaceId: a.workspaceId,
        templateId: foreign.id,
        userIds: [a.userId],
      }),
    );

    expect(code).toBe("22023");
    expect(await effectiveCap(a.workspaceId, a.userId)).toBe(20000);
  });
});
