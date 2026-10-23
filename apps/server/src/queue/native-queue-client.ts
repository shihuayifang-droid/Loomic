import type { PgmqClient, PgmqMessage } from "./pgmq-client.js";

/**
 * Native PostgreSQL queue client (ticket 43K).
 *
 * Same interface as the extension-backed client, but backed by the plain
 * tables in `apps/server/db/canonical/0002_queue.sql`. The caller injects a
 * `query` function so both a `pg.Pool` and PGlite can drive it.
 * Queue names are always bound parameters, never spliced into SQL.
 */
export type NativeQueueDeps = {
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: any[] }>;
  end?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

const READ_SQL = `
with picked as (
  select msg_id from hahart_queue.messages
  where queue_name = $1 and vt <= now()
  order by msg_id
  limit $3::integer
  for update skip locked
)
update hahart_queue.messages m
   set read_ct = m.read_ct + 1, vt = now() + make_interval(secs => $2::double precision)
  from picked where m.msg_id = picked.msg_id
returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message`;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function toIso(value: unknown): string {
  return (value instanceof Date ? value : new Date(value as string)).toISOString();
}

export function createNativeQueueClient(deps: NativeQueueDeps): PgmqClient {
  const sleep = deps.sleep ?? defaultSleep;

  async function read<T = Record<string, unknown>>(
    queue: string,
    vt: number,
    qty: number,
  ): Promise<PgmqMessage<T>[]> {
    const { rows } = await deps.query(READ_SQL, [queue, vt, qty]);
    return rows
      .map((row) => ({
        msg_id: Number(row.msg_id),
        read_ct: Number(row.read_ct),
        enqueued_at: toIso(row.enqueued_at),
        vt: toIso(row.vt),
        message: (typeof row.message === "string" ? JSON.parse(row.message) : row.message) as T,
      }))
      .sort((a, b) => a.msg_id - b.msg_id);
  }

  return {
    async send(queue, payload, delay = 0) {
      const { rows } = await deps.query(
        `insert into hahart_queue.messages (queue_name, message, vt)
         values ($1, $2::jsonb, now() + make_interval(secs => $3::double precision))
         returning msg_id`,
        [queue, JSON.stringify(payload), delay],
      );
      return Number(rows[0].msg_id);
    },

    read,

    async readWithPoll<T = Record<string, unknown>>(
      queue: string,
      vt: number,
      qty: number,
      maxPollSeconds = 5,
      pollIntervalMs = 100,
    ) {
      const limitMs = maxPollSeconds * 1000;
      let waitedMs = 0;
      for (;;) {
        const found = await read<T>(queue, vt, qty);
        if (found.length > 0) return found;
        if (waitedMs >= limitMs) return [];
        const step = Math.max(1, Math.min(pollIntervalMs, limitMs - waitedMs));
        await sleep(step);
        waitedMs += step;
      }
    },

    async deleteMsg(queue, msgId) {
      const { rows } = await deps.query(
        `delete from hahart_queue.messages
          where queue_name = $1 and msg_id = $2::bigint
          returning msg_id`,
        [queue, msgId],
      );
      return rows.length > 0;
    },

    async archive(queue, msgId) {
      const { rows } = await deps.query(
        `with moved as (
           delete from hahart_queue.messages
            where queue_name = $1 and msg_id = $2::bigint
            returning msg_id, queue_name, message, read_ct, enqueued_at
         )
         insert into hahart_queue.archive (msg_id, queue_name, message, read_ct, enqueued_at)
         select msg_id, queue_name, message, read_ct, enqueued_at from moved
         returning msg_id`,
        [queue, msgId],
      );
      return rows.length > 0;
    },

    async setVt(queue, msgId, vt) {
      await deps.query(
        `update hahart_queue.messages
            set vt = now() + make_interval(secs => $3::double precision)
          where queue_name = $1 and msg_id = $2::bigint`,
        [queue, msgId, vt],
      );
    },

    async shutdown() {
      if (deps.end) await deps.end();
    },
  };
}
