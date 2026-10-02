// X-52 prep (T2): what the seed migration must never do is the interesting part.
//
// The copy itself is trivial; every way this tool can hurt the product is a
// REFUSAL, and each one is pinned here:
//
//   - a dry run must write nothing at all (storage or database);
//   - a second apply must be a no-op (idempotent), or "run it again" becomes a
//     dangerous thing to say;
//   - a target key that exists with a different size must NOT be overwritten;
//   - only the exact public seed prefix may be rewritten — a URL in the same
//     bucket under another prefix, or prose that merely mentions `home-seeds`,
//     must come out byte-for-byte unchanged;
//   - the report must not contain a single URL.
//
// And one positive rule that is easy to get wrong: the copied object is keyed
// `discovery/x.webp` in the new bucket, NOT `home-seeds/discovery/x.webp` — the
// leading `home-seeds/` belongs to the old bucket's key. Case 2 asserts the
// rewritten URL and the uploaded key actually line up.
import { describe, expect, it } from "vitest";

import type { AdminSupabaseClient } from "../supabase/admin.js";
import {
  parseHomeSeedsArgs,
  projectSeedUrl,
  runHomeSeedsMigration,
} from "./hahart-home-seeds-migrate.js";

const HOST = "https://seeds.test";
const OLD_PREFIX = `${HOST}/storage/v1/object/public/project-assets/home-seeds/`;
const NEW_PREFIX = `${HOST}/storage/v1/object/public/home-seeds/`;

const COVER_KEY_SOURCE = "home-seeds/discovery/branding/cover.webp";
const COVER_KEY_TARGET = "discovery/branding/cover.webp";
const ICON_KEY_SOURCE = "home-seeds/icons/imagen-3.svg";
const ICON_KEY_TARGET = "icons/imagen-3.svg";

type Row = Record<string, unknown>;

type StubOptions = {
  /** bucket -> object key -> size */
  storage?: Record<string, Record<string, number>>;
  exampleRows?: Row[];
  discoveryRows?: Row[];
};

/**
 * A Supabase-shaped stub covering exactly what the CLI touches: paged `list` per
 * folder, `download`, `upload`, and paged `select` / `update` on the two seed
 * tables. Nothing here talks to a database — the CLI under test cannot reach the
 * real one even by accident.
 */
function makeStub(options: StubOptions = {}) {
  const storage: Record<string, Map<string, { data: unknown; size: number }>> = {};
  for (const [bucket, objects] of Object.entries(options.storage ?? {})) {
    storage[bucket] = new Map(
      Object.entries(objects).map(([key, size]) => [
        key,
        { data: { key, size }, size },
      ]),
    );
  }

  const uploads: Array<{ bucket: string; key: string; size: number }> = [];
  const updates: Array<{ table: string; id: string; patch: Row }> = [];

  const tables: Record<string, Row[]> = {
    home_example_examples: options.exampleRows ?? [],
    home_discovery_cases: options.discoveryRows ?? [],
  };

  function listChildren(store: Map<string, { size: number }>, prefix: string) {
    const files: Array<{ name: string; id: string | null; metadata: unknown }> = [];
    const folders = new Set<string>();

    for (const key of store.keys()) {
      if (prefix && !key.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? key.slice(prefix.length + 1) : key;
      if (rest.length === 0) continue;

      const slash = rest.indexOf("/");
      if (slash === -1) {
        files.push({ name: rest, id: key, metadata: { size: store.get(key)!.size } });
      } else {
        folders.add(rest.slice(0, slash));
      }
    }

    return [
      ...[...folders].map((name) => ({ name, id: null, metadata: null })),
      ...files,
    ];
  }

  const client = {
    storage: {
      from(bucket: string) {
        const store = (storage[bucket] ??= new Map());
        return {
          list: async (prefix: string) => ({
            data: listChildren(store, prefix),
            error: null,
          }),
          download: async (key: string) => {
            const found = store.get(key);
            if (!found) return { data: null, error: { message: "not found" } };
            return { data: found.data, error: null };
          },
          upload: async (key: string, data: unknown, opts?: { upsert?: boolean }) => {
            const exists = store.has(key);
            if (exists && !opts?.upsert) {
              return { data: null, error: { message: "already exists" } };
            }
            const size = typeof (data as { size?: number })?.size === "number"
              ? (data as { size: number }).size
              : -1;
            store.set(key, { data, size });
            uploads.push({ bucket, key, size });
            return { data: { path: key }, error: null };
          },
        };
      },
    },
    from(table: string) {
      const state = {
        mode: "select" as "select" | "update",
        patch: {} as Row,
        filters: [] as Array<[string, unknown]>,
      };

      const resolve = async () => {
        const rows = tables[table] ?? [];
        if (state.mode === "select") {
          return { data: rows.map((row) => ({ ...row })), error: null };
        }
        const id = String(state.filters.find(([column]) => column === "id")?.[1] ?? "");
        const row = rows.find((candidate) => String(candidate.id) === id);
        if (row) Object.assign(row, state.patch);
        updates.push({ table, id, patch: state.patch });
        return { data: null, error: null };
      };

      const chain: any = {
        select: () => chain,
        update: (patch: Row) => {
          state.mode = "update";
          state.patch = patch;
          return chain;
        },
        eq: (column: string, value: unknown) => {
          state.filters.push([column, value]);
          return chain;
        },
        range: () => chain,
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      };

      return chain;
    },
  };

  return {
    client: client as unknown as AdminSupabaseClient,
    uploads,
    updates,
    tables,
    storage,
  };
}

function baseStub(overrides: StubOptions = {}) {
  return makeStub({
    storage: {
      "project-assets": {
        [COVER_KEY_SOURCE]: 1000,
        [ICON_KEY_SOURCE]: 200,
        // Not a seed: the walk must never look outside `home-seeds/`.
        "workspace-1/project/canvas.png": 5000,
      },
      "home-seeds": {},
    },
    exampleRows: [
      {
        id: "ex-1",
        image_urls: [`${OLD_PREFIX}discovery/branding/cover.webp`],
        input_mentions: [
          { type: "tool", name: "Nano Banana", imgSrc: `${OLD_PREFIX}${ICON_KEY_TARGET}` },
        ],
      },
    ],
    discoveryRows: [
      {
        id: "dc-1",
        cover_image_url: `${OLD_PREFIX}discovery/branding/cover.webp`,
        author_avatar_url: `${OLD_PREFIX}discovery/branding/avatar.svg`,
      },
    ],
    ...overrides,
  });
}

describe("X-52 home seed migration", () => {
  it("case 1: a dry run reports the change and writes nothing", async () => {
    const stub = baseStub();

    const report = await runHomeSeedsMigration(stub.client, { apply: false });

    expect(stub.uploads).toHaveLength(0);
    expect(stub.updates).toHaveLength(0);
    expect(report).toMatchObject({
      sourceObjects: 2,
      targetCreated: 2,
      targetAlreadyPresent: 0,
      targetConflicts: [],
      exampleRowsUpdated: 1,
      discoveryRowsUpdated: 1,
      unmatchedSeedUrls: [],
      apply: false,
    });
    // The database still holds the old URLs: nothing was written.
    expect(stub.tables.home_example_examples?.[0]?.image_urls).toEqual([
      `${OLD_PREFIX}discovery/branding/cover.webp`,
    ]);
    // And no URL leaked into the report.
    expect(JSON.stringify(report)).not.toContain("http");
  });

  it("case 2: apply copies to the de-prefixed key and rewrites only the prefix", async () => {
    const stub = baseStub();

    const report = await runHomeSeedsMigration(stub.client, { apply: true });

    expect(report.targetCreated).toBe(2);
    expect(stub.uploads.map((entry) => `${entry.bucket}:${entry.key}`).sort()).toEqual([
      `home-seeds:${COVER_KEY_TARGET}`,
      `home-seeds:${ICON_KEY_TARGET}`,
    ]);

    // The arithmetic that keeps the home page working: the new public URL is
    // bucket + key, so the copied key must NOT repeat the `home-seeds/` segment.
    const copied = stub.storage["home-seeds"]?.get(COVER_KEY_TARGET);
    expect(copied).toBeDefined();
    expect(`${NEW_PREFIX}${COVER_KEY_TARGET}`).toBe(
      projectSeedUrl(`${OLD_PREFIX}${COVER_KEY_TARGET}`),
    );

    const example = stub.tables.home_example_examples?.[0];
    expect(example?.image_urls).toEqual([`${NEW_PREFIX}discovery/branding/cover.webp`]);
    expect(
      (example?.input_mentions as Array<{ imgSrc: string }>)[0]?.imgSrc,
    ).toBe(`${NEW_PREFIX}${ICON_KEY_TARGET}`);

    const discovery = stub.tables.home_discovery_cases?.[0];
    expect(discovery?.cover_image_url).toBe(`${NEW_PREFIX}discovery/branding/cover.webp`);
    expect(discovery?.author_avatar_url).toBe(
      `${NEW_PREFIX}discovery/branding/avatar.svg`,
    );
  });

  it("case 3: a second apply is a no-op", async () => {
    const stub = baseStub();
    await runHomeSeedsMigration(stub.client, { apply: true });
    const uploadsAfterFirst = stub.uploads.length;
    const updatesAfterFirst = stub.updates.length;

    const second = await runHomeSeedsMigration(stub.client, { apply: true });

    expect(second).toMatchObject({
      sourceObjects: 2,
      targetCreated: 0,
      targetAlreadyPresent: 2,
      targetConflicts: [],
      exampleRowsUpdated: 0,
      discoveryRowsUpdated: 0,
      unmatchedSeedUrls: [],
    });
    expect(stub.uploads).toHaveLength(uploadsAfterFirst);
    expect(stub.updates).toHaveLength(updatesAfterFirst);
  });

  it("case 4: a target key with a different size is a conflict, never overwritten", async () => {
    const stub = baseStub({
      storage: {
        "project-assets": { [COVER_KEY_SOURCE]: 1000, [ICON_KEY_SOURCE]: 200 },
        // Same key, different bytes: somebody published a different icon.
        "home-seeds": { [ICON_KEY_TARGET]: 999 },
      },
    });

    const report = await runHomeSeedsMigration(stub.client, { apply: true });

    expect(report.targetConflicts).toEqual([ICON_KEY_TARGET]);
    expect(stub.uploads.map((entry) => entry.key)).toEqual([COVER_KEY_TARGET]);
    expect(stub.storage["home-seeds"]?.get(ICON_KEY_TARGET)?.size).toBe(999);
  });

  it("case 5: same bucket, other prefix — and prose mentioning home-seeds — are untouched", async () => {
    const otherUrl = `${HOST}/storage/v1/object/public/project-assets/other/user.png`;
    const prose = "see the home-seeds/ folder for icons";

    const stub = baseStub({
      exampleRows: [
        {
          id: "ex-2",
          image_urls: [otherUrl],
          input_mentions: [{ type: "text", value: prose }],
        },
      ],
      discoveryRows: [],
    });

    const report = await runHomeSeedsMigration(stub.client, { apply: true });

    expect(report.exampleRowsUpdated).toBe(0);
    // Neither one is a seeded public URL, so neither is "unmatched" either.
    expect(report.unmatchedSeedUrls).toEqual([]);
    expect(stub.tables.home_example_examples?.[0]?.image_urls).toEqual([otherUrl]);
    expect(
      (stub.tables.home_example_examples?.[0]?.input_mentions as Array<{ value: string }>)[0]
        ?.value,
    ).toBe(prose);
  });

  it("case 6: a seed-looking URL this tool may not rewrite is reported for a human", async () => {
    const oddUrl = "https://cdn.other.test/home-seeds/discovery/x.webp";

    const stub = baseStub({
      exampleRows: [{ id: "ex-3", image_urls: [oddUrl], input_mentions: [] }],
      discoveryRows: [],
    });

    const report = await runHomeSeedsMigration(stub.client, { apply: true });

    expect(report.exampleRowsUpdated).toBe(0);
    expect(report.unmatchedSeedUrls).toEqual(["<redacted>"]);
    expect(stub.tables.home_example_examples?.[0]?.image_urls).toEqual([oddUrl]);
    expect(JSON.stringify(report)).not.toContain("http");
  });

  it("case 7: defaults to a dry run", () => {
    expect(parseHomeSeedsArgs([])).toEqual({ apply: false });
    expect(parseHomeSeedsArgs(["--apply"])).toEqual({ apply: true });
  });
});
