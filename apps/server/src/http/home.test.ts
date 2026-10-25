// 工单45BR / T-128 (OP-04 second slice): the two home read routes, exercised
// against a Fastify instance that registers nothing but these routes and a fake
// `pg` pool, so every status and every body here comes from the route itself.
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import type { ObjectStore } from "../features/storage/object-store.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { registerHomeRoutes } from "./home.js";

const BUCKET = "home-seeds";
/** The workorder pins the TTL at one week; the test pins it too. */
const EXPECTED_TTL_SECONDS = 7 * 24 * 3600;

type Row = Record<string, unknown>;

type Tables = {
  exampleCategories?: Row[];
  examples?: Row[];
  discoveryCategories?: Row[];
  discoveryCases?: Row[];
};

/** Answers each statement by the table it names; records the SQL it was asked. */
function fakePool(tables: Tables = {}): { pool: Pool; statements: string[] } {
  const statements: string[] = [];

  const query = async (sql: string) => {
    statements.push(sql);
    if (sql.includes("home_example_categories")) {
      return { rows: tables.exampleCategories ?? [] };
    }
    if (sql.includes("home_example_examples")) {
      return { rows: tables.examples ?? [] };
    }
    if (sql.includes("home_discovery_categories")) {
      return { rows: tables.discoveryCategories ?? [] };
    }
    if (sql.includes("home_discovery_cases")) {
      return { rows: tables.discoveryCases ?? [] };
    }
    return { rows: [] };
  };

  return { pool: { query } as unknown as Pool, statements };
}

type SignCall = { bucket: string; key: string; ttlSeconds: number };

/**
 * A store that signs `https://files.test/<bucket>/<key>?exp=1&sig=2` for every
 * key, except the ones `fails` rejects - those throw, which is what a backend
 * outage looks like from the route's side.
 */
function fakeStore(fails: (key: string) => boolean = () => false): {
  store: ObjectStore;
  calls: SignCall[];
} {
  const calls: SignCall[] = [];

  const signedReadUrl = async (
    ref: { bucket: string; key: string },
    options: { ttlSeconds: number },
  ) => {
    calls.push({ bucket: ref.bucket, key: ref.key, ttlSeconds: options.ttlSeconds });
    if (fails(ref.key)) throw new Error("storage backend said no");
    return `https://files.test/${ref.bucket}/${ref.key}?exp=1&sig=2`;
  };

  return { store: { signedReadUrl } as unknown as ObjectStore, calls };
}

function fakeAuth(signedIn: boolean): RequestAuthenticator {
  return {
    authenticate: async () =>
      signedIn
        ? {
            accessToken: "token",
            email: "member@example.test",
            id: "11111111-1111-1111-1111-111111111111",
            userMetadata: {},
          }
        : null,
  };
}

let app: FastifyInstance | undefined;

async function build(
  options: Parameters<typeof registerHomeRoutes>[1],
): Promise<FastifyInstance> {
  const instance = Fastify();
  registerHomeRoutes(instance, options);
  await instance.ready();
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /api/home/examples", () => {
  it("answers 401 without a signed-in caller", async () => {
    const { pool } = fakePool();
    const { store } = fakeStore();
    const instance = await build({ auth: fakeAuth(false), pool: () => pool, store });

    const response = await instance.inject({ method: "GET", url: "/api/home/examples" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    });
  });

  it("returns empty arrays when the tables are empty", async () => {
    const { pool } = fakePool();
    const { store } = fakeStore();
    const instance = await build({ auth: fakeAuth(true), pool: () => pool, store });

    const response = await instance.inject({ method: "GET", url: "/api/home/examples" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ categories: [] });
  });

  it("groups examples under their category, in the order the rows arrived", async () => {
    const { pool } = fakePool({
      exampleCategories: [
        { key: "image", label: "Image" },
        { key: "video", label: "Video" },
      ],
      examples: [
        { category_key: "video", title: "V1", prompt: "p1", image_urls: [], input_mentions: [] },
        { category_key: "image", title: "I1", prompt: "p2", image_urls: [], input_mentions: [] },
        { category_key: "image", title: "I2", prompt: "p3", image_urls: [], input_mentions: [] },
      ],
    });
    const { store } = fakeStore();
    const instance = await build({ auth: fakeAuth(true), pool: () => pool, store });

    const response = await instance.inject({ method: "GET", url: "/api/home/examples" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      categories: { key: string; label: string; examples: { title: string }[] }[];
    };
    expect(body.categories.map((category) => category.key)).toEqual(["image", "video"]);
    expect(body.categories[0]?.examples.map((entry) => entry.title)).toEqual(["I1", "I2"]);
    expect(body.categories[1]?.examples.map((entry) => entry.title)).toEqual(["V1"]);
  });

  it("replaces image_urls keys and input_mentions imgSrc with signed links", async () => {
    const { pool } = fakePool({
      exampleCategories: [{ key: "image", label: "Image" }],
      examples: [
        {
          category_key: "image",
          title: "I1",
          prompt: "p1",
          image_urls: ["examples/a.webp", "https://cdn.example.test/b.webp"],
          input_mentions: [
            { type: "image", name: "reference", imgSrc: "icons/i.svg" },
            { type: "text", name: "note" },
          ],
        },
      ],
    });
    const { store, calls } = fakeStore();
    const instance = await build({ auth: fakeAuth(true), pool: () => pool, store });

    const response = await instance.inject({ method: "GET", url: "/api/home/examples" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      categories: {
        examples: {
          previewImages: string[];
          inputMentions: { type: string; imgSrc?: string }[];
        }[];
      }[];
    };
    const example = body.categories[0]?.examples[0];

    // Keys are signed; a value that is already a URL is left alone.
    expect(example?.previewImages).toEqual([
      `https://files.test/${BUCKET}/examples/a.webp?exp=1&sig=2`,
      "https://cdn.example.test/b.webp",
    ]);
    // Only the mention that carries an imgSrc is rewritten; extra fields stay.
    expect(example?.inputMentions).toEqual([
      {
        type: "image",
        name: "reference",
        imgSrc: `https://files.test/${BUCKET}/icons/i.svg?exp=1&sig=2`,
      },
      { type: "text", name: "note" },
    ]);
    // Every signature goes to `home-seeds` with the week-long TTL.
    expect(calls).toEqual([
      { bucket: BUCKET, key: "examples/a.webp", ttlSeconds: EXPECTED_TTL_SECONDS },
      { bucket: BUCKET, key: "icons/i.svg", ttlSeconds: EXPECTED_TTL_SECONDS },
    ]);
  });

  it("keeps the stored value when a signature fails", async () => {
    const { pool } = fakePool({
      exampleCategories: [{ key: "image", label: "Image" }],
      examples: [
        {
          category_key: "image",
          title: "I1",
          prompt: "p1",
          image_urls: ["examples/broken.webp", "examples/ok.webp"],
          input_mentions: [{ type: "image", name: "reference", imgSrc: "icons/broken.svg" }],
        },
      ],
    });
    const { store } = fakeStore((key) => key.includes("broken"));
    const instance = await build({ auth: fakeAuth(true), pool: () => pool, store });

    const response = await instance.inject({ method: "GET", url: "/api/home/examples" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      categories: {
        examples: {
          previewImages: string[];
          inputMentions: { imgSrc: string }[];
        }[];
      }[];
    };
    const example = body.categories[0]?.examples[0];

    expect(example?.previewImages).toEqual([
      "examples/broken.webp",
      `https://files.test/${BUCKET}/examples/ok.webp?exp=1&sig=2`,
    ]);
    expect(example?.inputMentions[0]?.imgSrc).toBe("icons/broken.svg");
  });

  it("only reads active rows, ordered by sort_order", async () => {
    const { pool, statements } = fakePool();
    const { store } = fakeStore();
    const instance = await build({ auth: fakeAuth(true), pool: () => pool, store });

    await instance.inject({ method: "GET", url: "/api/home/examples" });

    expect(statements).toHaveLength(2);
    for (const sql of statements) {
      expect(sql).toContain("is_active = true");
      expect(sql).toContain("order by sort_order");
    }
  });
});

describe("GET /api/home/discovery", () => {
  it("answers 401 without a signed-in caller", async () => {
    const { pool } = fakePool();
    const { store } = fakeStore();
    const instance = await build({ auth: fakeAuth(false), pool: () => pool, store });

    const response = await instance.inject({ method: "GET", url: "/api/home/discovery" });

    expect(response.statusCode).toBe(401);
  });

  it("returns empty arrays when the tables are empty", async () => {
    const { pool } = fakePool();
    const { store } = fakeStore();
    const instance = await build({ auth: fakeAuth(true), pool: () => pool, store });

    const response = await instance.inject({ method: "GET", url: "/api/home/discovery" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ categories: [] });
  });

  it("signs the cover and the avatar and maps every column to its output name", async () => {
    const { pool } = fakePool({
      discoveryCategories: [
        { key: "branding", label: "Branding" },
        { key: "empty", label: "Empty" },
      ],
      discoveryCases: [
        {
          category_key: "branding",
          id: "case-1",
          title: "Case 1",
          cover_image_url: "discovery/cover.webp",
          author_name: "Ada",
          author_avatar_url: "https://cdn.example.test/ada.png",
          view_count: 12,
          like_count: 3,
          case_url: "https://cases.example.test/case-1",
          seed_prompt: "make a logo",
        },
      ],
    });
    const { store } = fakeStore();
    const instance = await build({ auth: fakeAuth(true), pool: () => pool, store });

    const response = await instance.inject({ method: "GET", url: "/api/home/discovery" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      categories: {
        key: string;
        label: string;
        cases: Record<string, unknown>[];
      }[];
    };

    expect(body.categories.map((category) => category.key)).toEqual(["branding", "empty"]);
    // A category with no active case is still listed, with an empty list.
    expect(body.categories[1]?.cases).toEqual([]);
    expect(body.categories[0]?.cases).toEqual([
      {
        id: "case-1",
        title: "Case 1",
        coverImage: `https://files.test/${BUCKET}/discovery/cover.webp?exp=1&sig=2`,
        authorName: "Ada",
        authorAvatar: "https://cdn.example.test/ada.png",
        viewCount: 12,
        likeCount: 3,
        caseUrl: "https://cases.example.test/case-1",
        seedPrompt: "make a logo",
      },
    ]);
  });

  it("keeps the stored cover when its signature fails", async () => {
    const { pool } = fakePool({
      discoveryCategories: [{ key: "branding", label: "Branding" }],
      discoveryCases: [
        {
          category_key: "branding",
          id: "case-1",
          title: "Case 1",
          cover_image_url: "discovery/broken.webp",
          author_name: "Ada",
          author_avatar_url: "discovery/avatar.webp",
          view_count: 0,
          like_count: 0,
          case_url: "https://cases.example.test/case-1",
          seed_prompt: "",
        },
      ],
    });
    const { store } = fakeStore((key) => key.includes("broken"));
    const instance = await build({ auth: fakeAuth(true), pool: () => pool, store });

    const response = await instance.inject({ method: "GET", url: "/api/home/discovery" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      categories: { cases: { coverImage: string; authorAvatar: string }[] }[];
    };

    expect(body.categories[0]?.cases[0]?.coverImage).toBe("discovery/broken.webp");
    expect(body.categories[0]?.cases[0]?.authorAvatar).toBe(
      `https://files.test/${BUCKET}/discovery/avatar.webp?exp=1&sig=2`,
    );
  });
});
