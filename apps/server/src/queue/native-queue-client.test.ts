import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createNativeQueueClient } from "./native-queue-client.js";
import type { PgmqClient } from "./pgmq-client.js";

/** `src/queue` -> `apps/server` is two levels up. */
const HERE = dirname(fileURLToPath(import.meta.url));
const QUEUE_SQL_FILE = join(HERE, "..", "..", "db", "canonical", "0002_queue.sql");
const QUEUE_SQL = readFileSync(QUEUE_SQL_FILE, "utf8");

let db: PGlite;
let sleepCalls: number[];
let onSleep: ((totalMs: number) => Promise<void>) | undefined;
let client: PgmqClient;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(QUEUE_SQL);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("truncate hahart_queue.messages, hahart_queue.archive");
  sleepCalls = [];
  onSleep = undefined;
  client = createNativeQueueClient({
    query: (sql, params) => db.query(sql, params as unknown[] | undefined) as Promise<{ rows: any[] }>,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      const total = sleepCalls.reduce((a, b) => a + b, 0);
      if (onSleep) await onSleep(total);
    },
  });
});

describe("native queue client", () => {
  it("send returns increasing ids; read takes all once with read_ct = 1", async () => {
    const a = await client.send("q", { n: 1 });
    const b = await client.send("q", { n: 2 });
    expect(typeof a).toBe("number");
    expect(b).toBeGreaterThan(a);

    const got = await client.read<{ n: number }>("q", 30, 10);
    expect(got.map((m) => m.msg_id)).toEqual([a, b]);
    expect(got.map((m) => m.message.n)).toEqual([1, 2]);
    expect(got.every((m) => m.read_ct === 1)).toBe(true);
    expect(Number.isNaN(Date.parse(got[0]!.vt))).toBe(false);
    expect(Number.isNaN(Date.parse(got[0]!.enqueued_at))).toBe(false);

    // Invisible while the visibility timeout runs: another worker gets nothing.
    expect(await client.read("q", 30, 10)).toEqual([]);
  });

  it("queues are isolated from each other", async () => {
    await client.send("q1", { a: 1 });
    expect(await client.read("q2", 30, 10)).toEqual([]);
    expect(await client.read("q1", 30, 10)).toHaveLength(1);
  });

  it("qty limits how many messages one read takes", async () => {
    await client.send("q", { n: 1 });
    await client.send("q", { n: 2 });
    await client.send("q", { n: 3 });
    expect(await client.read("q", 30, 2)).toHaveLength(2);
    const rest = await client.read<{ n: number }>("q", 30, 2);
    expect(rest).toHaveLength(1);
    expect(rest[0]!.message.n).toBe(3);
  });

  it("a delayed message is not readable immediately", async () => {
    await client.send("q", { n: 1 }, 60);
    expect(await client.read("q", 30, 10)).toEqual([]);
  });

  it("visibility timeout of 0 makes the message re-deliverable with read_ct = 2", async () => {
    const id = await client.send("q", { n: 1 });
    const first = await client.read("q", 0, 1);
    expect(first[0]!.msg_id).toBe(id);
    expect(first[0]!.read_ct).toBe(1);
    const second = await client.read("q", 0, 1);
    expect(second[0]!.msg_id).toBe(id);
    expect(second[0]!.read_ct).toBe(2);
  });

  it("setVt(0) makes a claimed message readable again; a longer setVt hides it", async () => {
    const id = await client.send("q", { n: 1 });
    await client.read("q", 300, 1);
    expect(await client.read("q", 300, 1)).toEqual([]);

    await client.setVt("q", id, 0);
    const again = await client.read("q", 300, 1);
    expect(again.map((m) => m.msg_id)).toEqual([id]);
    expect(again[0]!.read_ct).toBe(2);

    await client.setVt("q", id, 600);
    expect(await client.read("q", 300, 1)).toEqual([]);
  });

  it("archive moves the row to the archive table and keeps read_ct", async () => {
    const id = await client.send("q", { n: 1 });
    await client.read("q", 30, 1);
    expect(await client.archive("q", id)).toBe(true);

    const main = await db.query("select count(*)::int as c from hahart_queue.messages");
    expect((main.rows[0] as { c: number }).c).toBe(0);
    const arch = await db.query("select msg_id, queue_name, read_ct, message from hahart_queue.archive");
    expect(arch.rows).toHaveLength(1);
    const row = arch.rows[0] as { msg_id: number | string; queue_name: string; read_ct: number };
    expect(Number(row.msg_id)).toBe(id);
    expect(row.queue_name).toBe("q");
    expect(row.read_ct).toBe(1);

    expect(await client.archive("q", id)).toBe(false);
    expect(await client.archive("q", 999999)).toBe(false);
  });

  it("deleteMsg removes the row and reports whether it deleted anything", async () => {
    const id = await client.send("q", { n: 1 });
    expect(await client.deleteMsg("q", id)).toBe(true);
    expect(await client.deleteMsg("q", id)).toBe(false);
    expect(await client.deleteMsg("q", 999999)).toBe(false);
    const arch = await db.query("select count(*)::int as c from hahart_queue.archive");
    expect((arch.rows[0] as { c: number }).c).toBe(0);
  });

  it("readWithPoll returns a message that arrives while polling", async () => {
    onSleep = async (total) => {
      if (total >= 300) await client.send("q", { n: 7 });
    };
    const got = await client.readWithPoll<{ n: number }>("q", 30, 1, 5, 100);
    expect(got).toHaveLength(1);
    expect(got[0]!.message.n).toBe(7);
    expect(sleepCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("readWithPoll returns [] at the time limit without really sleeping", async () => {
    const got = await client.readWithPoll("q", 30, 1, 2, 500);
    expect(got).toEqual([]);
    expect(sleepCalls.reduce((a, b) => a + b, 0)).toBe(2000);
  });

  it("shutdown calls the injected end function", async () => {
    let ended = 0;
    const c = createNativeQueueClient({
      query: async () => ({ rows: [] }),
      end: async () => {
        ended += 1;
      },
    });
    await c.shutdown();
    expect(ended).toBe(1);
  });

  it("the SQL file mentions neither pgmq nor auth.", () => {
    expect(QUEUE_SQL.toLowerCase()).not.toContain("pgmq");
    expect(QUEUE_SQL).not.toContain("auth.");
  });
});
