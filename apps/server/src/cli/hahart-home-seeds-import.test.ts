// T-128 slice 1: what the seed import must guarantee is what is pinned here.
//
//   - a dry run writes nothing: no `put`, no insert, and the counters still
//     describe the whole plan (otherwise the report is useless as a preview);
//   - a second `--apply` is a no-op: the natural keys of 0012 and the existing
//     object keys keep it from growing, so "run it again" stays safe;
//   - a URL that fails is reported and does not stop the rest of the run;
//   - the rows carry object KEYS, never a remote URL.
//
// Everything is a fake: a Map-backed store, an in-memory repository and a
// fetch that answers from the plan itself. Nothing here touches a database, the
// volume or the network.
import { describe, expect, it } from "vitest";

import {
  buildSeedPlan,
  legacySeedUrlCandidates,
  runHomeSeedsImport,
  extensionOf,
  type DiscoveryCaseRow,
  type DiscoveryCategoryRow,
  type ExampleCategoryRow,
  type ExampleRow,
  type HomeSeedSources,
  type HomeSeedsRepository,
  type SeedPlan,
} from "./hahart-home-seeds-import.js";
import type {
  ObjectRef,
  ObjectStore,
} from "../features/storage/object-store.js";

const IMAGE = "https://example.test/storage/v1/object/public/home-seeds";

function sources(): HomeSeedSources {
  return {
    exampleCategories: [
      {
        key: "image",
        label: "Image",
        dataType: "image",
        examples: [
          {
            title: "First",
            prompt: "do a thing",
            previewImages: [`${IMAGE}/examples/image/a1.webp`],
            inputMentions: [
              {
                type: "image",
                name: "Ref",
                imgSrc: `${IMAGE}/inputs/image/a1-input.webp`,
              },
              {
                type: "tool",
                name: "Sora",
                imgSrc: `${IMAGE}/icons/sora.svg`,
              },
            ],
          },
        ],
      },
      {
        key: "video",
        label: "Video",
        dataType: "video",
        examples: [
          {
            title: "Second",
            prompt: "do another",
            previewImages: [`${IMAGE}/examples/video/b1.webp`],
            inputMentions: [],
          },
        ],
      },
    ],
    discoveryCategories: [
      {
        key: "design",
        label: "Design",
        cases: [
          {
            id: "case-1",
            title: "A case",
            coverImageUrl: `${IMAGE}/discovery/cover.webp`,
            authorName: "Ann",
            authorAvatarUrl: `${IMAGE}/discovery/avatar.svg`,
            viewCount: 3,
            likeCount: 4,
            prompt: "seed prompt",
          },
        ],
      },
    ],
  };
}

class FakeStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];

  private keyOf(ref: ObjectRef): string {
    return `${ref.bucket}/${ref.key}`;
  }

  async put(
    ref: ObjectRef,
    body: Buffer,
    _options: { contentType: string; upsert?: boolean },
  ): Promise<void> {
    this.objects.set(this.keyOf(ref), body);
    this.puts.push(ref.key);
  }

  async get(ref: ObjectRef): Promise<{
    body: Buffer;
    size: number;
    contentType: string;
  }> {
    const body = this.objects.get(this.keyOf(ref));
    if (!body) throw new Error("not found");
    return { body, size: body.length, contentType: "image/webp" };
  }

  async head(ref: ObjectRef): Promise<{ size: number; contentType: string } | null> {
    const body = this.objects.get(this.keyOf(ref));
    if (!body) return null;
    return { size: body.length, contentType: "image/webp" };
  }

  async delete(): Promise<void> {}

  async copy(): Promise<void> {}

  async signedReadUrl(): Promise<string> {
    throw new Error("unused");
  }

  async signedReadUrls(): Promise<Map<string, string>> {
    return new Map();
  }
}

class FakeRepository implements HomeSeedsRepository {
  readonly exampleCategories = new Map<string, ExampleCategoryRow>();
  readonly examples = new Map<string, ExampleRow>();
  readonly discoveryCategories = new Map<string, DiscoveryCategoryRow>();
  readonly discoveryCases = new Map<string, DiscoveryCaseRow>();

  async hasExampleCategory(key: string): Promise<boolean> {
    return this.exampleCategories.has(key);
  }

  async insertExampleCategory(row: ExampleCategoryRow): Promise<void> {
    this.exampleCategories.set(row.key, row);
  }

  async hasExample(categoryKey: string, sortOrder: number): Promise<boolean> {
    return this.examples.has(`${categoryKey}/${sortOrder}`);
  }

  async insertExample(row: ExampleRow): Promise<void> {
    this.examples.set(`${row.categoryKey}/${row.sortOrder}`, row);
  }

  async hasDiscoveryCategory(key: string): Promise<boolean> {
    return this.discoveryCategories.has(key);
  }

  async insertDiscoveryCategory(row: DiscoveryCategoryRow): Promise<void> {
    this.discoveryCategories.set(row.key, row);
  }

  async hasDiscoveryCase(id: string): Promise<boolean> {
    return this.discoveryCases.has(id);
  }

  async insertDiscoveryCase(row: DiscoveryCaseRow): Promise<void> {
    this.discoveryCases.set(row.id, row);
  }

  get rowCount(): number {
    return (
      this.exampleCategories.size +
      this.examples.size +
      this.discoveryCategories.size +
      this.discoveryCases.size
    );
  }
}

function fakeFetch(failing: readonly string[] = []): {
  fetchBytes: (url: string) => Promise<Buffer>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetchBytes: async (url: string): Promise<Buffer> => {
      calls.push(url);
      if (failing.includes(url)) throw new Error("HTTP 404");
      return Buffer.from(`bytes of ${url}`, "utf8");
    },
  };
}

function totals(plan: SeedPlan): {
  categories: number;
  examples: number;
  discoveryCategories: number;
  discoveryCases: number;
  objects: number;
} {
  return {
    categories: plan.exampleCategories.length,
    examples: plan.examples.length,
    discoveryCategories: plan.discoveryCategories.length,
    discoveryCases: plan.discoveryCases.length,
    objects: plan.objects.length,
  };
}

describe("home seeds import", () => {
  it("a dry run plans everything and writes nothing", async () => {
    const plan = buildSeedPlan(sources());
    const store = new FakeStore();
    const repository = new FakeRepository();
    const fetch = fakeFetch();
    const log: string[] = [];

    const summary = await runHomeSeedsImport({
      plan,
      store,
      repository,
      fetchBytes: fetch.fetchBytes,
      apply: false,
      log: (line) => log.push(line),
    });

    const expected = totals(plan);

    expect(expected.categories).toBe(2);
    expect(expected.examples).toBe(2);
    expect(expected.discoveryCategories).toBe(1);
    expect(expected.discoveryCases).toBe(1);
    expect(expected.objects).toBe(6);

    expect(summary.categories).toBe(expected.categories);
    expect(summary.examples).toBe(expected.examples);
    expect(summary.discoveryCategories).toBe(expected.discoveryCategories);
    expect(summary.discoveryCases).toBe(expected.discoveryCases);
    expect(summary.objects).toBe(expected.objects);
    expect(summary.fetchedBytes).toBeGreaterThan(0);
    expect(summary.failures).toEqual([]);

    // Nothing was written: no object, no row.
    expect(store.puts).toEqual([]);
    expect(store.objects.size).toBe(0);
    expect(repository.rowCount).toBe(0);

    expect(log[0]).toMatch(
      /^categories=2 examples=2 discovery_categories=1 discovery_cases=1 objects=6 fetched_bytes=\d+$/,
    );
    expect(log).toContain("failed=0");
  });

  it("a second apply is a no-op", async () => {
    const plan = buildSeedPlan(sources());
    const store = new FakeStore();
    const repository = new FakeRepository();

    const first = await runHomeSeedsImport({
      plan,
      store,
      repository,
      fetchBytes: fakeFetch().fetchBytes,
      apply: true,
      log: () => {},
    });

    expect(first.uploaded).toBe(plan.objects.length);
    expect(first.rowsInserted).toBe(6);
    expect(first.failures).toEqual([]);
    expect(store.objects.size).toBe(plan.objects.length);
    expect(repository.rowCount).toBe(6);

    const second = await runHomeSeedsImport({
      plan,
      store,
      repository,
      fetchBytes: fakeFetch().fetchBytes,
      apply: true,
      log: () => {},
    });

    expect(second.uploaded).toBe(0);
    expect(second.fetchedBytes).toBe(0);
    expect(second.skippedExisting).toBe(plan.objects.length);
    expect(second.rowsInserted).toBe(0);
    expect(store.objects.size).toBe(plan.objects.length);
    expect(repository.rowCount).toBe(6);
  });

  it("rows carry object keys and never a remote URL", async () => {
    const plan = buildSeedPlan(sources());

    for (const row of plan.examples) {
      for (const key of row.imageUrls) {
        expect(key.startsWith("examples/")).toBe(true);
        expect(key).not.toContain("://");
      }
      for (const mention of row.inputMentions) {
        expect(mention.imgSrc.startsWith("examples/")).toBe(true);
      }
    }

    for (const row of plan.discoveryCases) {
      expect(row.coverImageUrl.startsWith("discovery/")).toBe(true);
      expect(row.authorAvatarUrl.startsWith("discovery/")).toBe(true);
    }

    expect(plan.exampleCategories[0]?.sortOrder).toBe(0);
    expect(plan.examples[0]?.sortOrder).toBe(0);
    expect(plan.discoveryCases[0]?.sortOrder).toBe(0);
  });

  it("a failing download is reported and does not stop the run", async () => {
    const plan = buildSeedPlan(sources());
    const store = new FakeStore();
    const broken = plan.objects[0];
    if (!broken) throw new Error("plan is empty");

    const summary = await runHomeSeedsImport({
      plan,
      store,
      repository: new FakeRepository(),
      fetchBytes: fakeFetch([broken.url]).fetchBytes,
      apply: true,
      log: () => {},
    });

    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.url).toBe(broken.url);
    expect(summary.uploaded).toBe(plan.objects.length - 1);
  });
});

describe("seed URL helpers", () => {
  it("maps a projected seed URL onto the legacy location of the same key", () => {
    expect(
      legacySeedUrlCandidates(
        "https://project.test/storage/v1/object/public/home-seeds/examples/a/b.webp",
      ),
    ).toEqual([
      "https://project.test/storage/v1/object/public/project-assets/home-seeds/examples/a/b.webp",
    ]);

    // A third-party link is not a seed URL and must not be rewritten.
    expect(legacySeedUrlCandidates("https://elsewhere.test/a/b.webp")).toEqual(
      [],
    );
  });

  it("reads the extension without the query string", () => {
    expect(extensionOf("https://x.test/a/b.WEBP?token=1")).toBe("webp");
    expect(extensionOf("https://x.test/a/b")).toBe("bin");
  });
});
