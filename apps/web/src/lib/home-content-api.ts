/**
 * 工单45BS / T-128 (OP-04, third slice): the browser side of the home read API.
 *
 * `GET /api/home/examples` and `GET /api/home/discovery` (45BR) answer the seed
 * content the home page shows, with every object key already exchanged for a
 * signed URL. Both require a bearer token; an anonymous request is a 401.
 *
 * Why the shape is checked here and not trusted
 * The response is content, not a contract type: the read routes are served from
 * four plain tables, so a renamed column shows up as `undefined` rather than as
 * a compile error. A card mapped out of a half-valid body would render an empty
 * home page that looks like "the seeds are gone". The readers below keep only
 * the fields the page needs and answer `null` when the body does not look like
 * the documented shape, which the libraries turn into their local-seed fallback.
 *
 * No React here on purpose: the two `load*Categories()` loaders are plain
 * modules, so a token is either handed in by the caller or read from the auth
 * session module (`self-auth-client` / the Supabase browser client) — exactly
 * what `auth-context` itself reads. Nothing in this file touches a React context.
 */
import { getServerBaseUrl } from "./env";
import * as selfAuth from "./self-auth-client";
import { getSupabaseBrowserClient } from "./supabase-browser";

/** One `@mention` capsule of an example card, as the read API sends it. */
export type HomeContentExampleMention = {
  /** "image" = an input reference; "tool" = a model/tool capsule. */
  type: "image" | "tool";
  name: string;
  /** Already a signed URL: never re-resolved in the browser. */
  imgSrc: string;
};

export type HomeContentExampleCard = {
  title: string;
  prompt: string;
  previewImages: string[];
  inputMentions: HomeContentExampleMention[];
};

export type HomeContentExampleCategory = {
  key: string;
  label: string;
  examples: HomeContentExampleCard[];
};

/**
 * One discovery case. The server names the images `coverImage` /
 * `authorAvatar` (see `toCase` in apps/server/src/http/home.ts), which is NOT
 * what `HomeDiscoveryCase` calls them — the mapping is the caller's job.
 */
export type HomeContentDiscoveryCase = {
  id: string;
  title: string;
  coverImage: string;
  authorName: string;
  authorAvatar: string;
  viewCount: number;
  likeCount: number;
  caseUrl: string;
  seedPrompt: string;
};

export type HomeContentDiscoveryCategory = {
  key: string;
  label: string;
  cases: HomeContentDiscoveryCase[];
};

// --- Shape readers ---------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(
  source: Record<string, unknown>,
  key: string,
): string[] | null {
  const value = source[key];
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    strings.push(item);
  }
  return strings;
}

function readMention(value: unknown): HomeContentExampleMention | null {
  if (!isRecord(value)) return null;
  const type = value["type"];
  if (type !== "image" && type !== "tool") return null;
  const name = readString(value, "name");
  const imgSrc = readString(value, "imgSrc");
  if (name === null || imgSrc === null) return null;
  return { type, name, imgSrc };
}

function readExampleCard(value: unknown): HomeContentExampleCard | null {
  if (!isRecord(value)) return null;
  const title = readString(value, "title");
  const prompt = readString(value, "prompt");
  const previewImages = readStringArray(value, "previewImages");
  const rawMentions = value["inputMentions"];
  if (title === null || prompt === null || previewImages === null) return null;
  if (!Array.isArray(rawMentions)) return null;

  const inputMentions: HomeContentExampleMention[] = [];
  for (const raw of rawMentions) {
    const mention = readMention(raw);
    if (mention === null) return null;
    inputMentions.push(mention);
  }

  return { title, prompt, previewImages, inputMentions };
}

function readExampleCategory(value: unknown): HomeContentExampleCategory | null {
  if (!isRecord(value)) return null;
  const key = readString(value, "key");
  const label = readString(value, "label");
  const rawExamples = value["examples"];
  if (key === null || label === null || !Array.isArray(rawExamples)) return null;

  const examples: HomeContentExampleCard[] = [];
  for (const raw of rawExamples) {
    const example = readExampleCard(raw);
    if (example === null) return null;
    examples.push(example);
  }

  return { key, label, examples };
}

function readDiscoveryCase(value: unknown): HomeContentDiscoveryCase | null {
  if (!isRecord(value)) return null;
  const id = readString(value, "id");
  const title = readString(value, "title");
  const coverImage = readString(value, "coverImage");
  const authorName = readString(value, "authorName");
  const authorAvatar = readString(value, "authorAvatar");
  const viewCount = readNumber(value, "viewCount");
  const likeCount = readNumber(value, "likeCount");
  const caseUrl = readString(value, "caseUrl");
  const seedPrompt = readString(value, "seedPrompt");
  if (
    id === null
    || title === null
    || coverImage === null
    || authorName === null
    || authorAvatar === null
    || viewCount === null
    || likeCount === null
    || caseUrl === null
    || seedPrompt === null
  ) {
    return null;
  }
  return {
    id,
    title,
    coverImage,
    authorName,
    authorAvatar,
    viewCount,
    likeCount,
    caseUrl,
    seedPrompt,
  };
}

function readDiscoveryCategory(
  value: unknown,
): HomeContentDiscoveryCategory | null {
  if (!isRecord(value)) return null;
  const key = readString(value, "key");
  const label = readString(value, "label");
  const rawCases = value["cases"];
  if (key === null || label === null || !Array.isArray(rawCases)) return null;

  const cases: HomeContentDiscoveryCase[] = [];
  for (const raw of rawCases) {
    const item = readDiscoveryCase(raw);
    if (item === null) return null;
    cases.push(item);
  }

  return { key, label, cases };
}

/** `{ categories: [...] }` with every entry read by `read`; `null` if any entry is off. */
function readCategories<T>(
  body: unknown,
  read: (value: unknown) => T | null,
): T[] | null {
  if (!isRecord(body)) return null;
  const raw = body["categories"];
  if (!Array.isArray(raw)) return null;

  const categories: T[] = [];
  for (const item of raw) {
    const category = read(item);
    if (category === null) return null;
    categories.push(category);
  }
  return categories;
}

// --- Requests --------------------------------------------------------------

async function fetchHomeJson(
  accessToken: string,
  path: string,
): Promise<unknown> {
  const response = await fetch(`${getServerBaseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed with status ${response.status}`);
  }
  return response.json();
}

/**
 * `GET /api/home/examples` — every active example category with its cards.
 *
 * Throws when the request fails (401 included) or the body is not the
 * documented shape; both are "use the local seeds" for the caller.
 */
export async function fetchHomeExamples(
  accessToken: string,
): Promise<HomeContentExampleCategory[]> {
  const body = await fetchHomeJson(accessToken, "/api/home/examples");
  const categories = readCategories(body, readExampleCategory);
  if (categories === null) {
    throw new Error("GET /api/home/examples returned an unexpected shape");
  }
  return categories;
}

/** `GET /api/home/discovery` — every active discovery category with its cases. */
export async function fetchHomeDiscovery(
  accessToken: string,
): Promise<HomeContentDiscoveryCategory[]> {
  const body = await fetchHomeJson(accessToken, "/api/home/discovery");
  const categories = readCategories(body, readDiscoveryCategory);
  if (categories === null) {
    throw new Error("GET /api/home/discovery returned an unexpected shape");
  }
  return categories;
}

/**
 * The bearer token of the signed-in reader, or `null` when there is none.
 *
 * Mirrors `auth-context`'s own session source: with `NEXT_PUBLIC_HAHART_AUTH_PROVIDER=self`
 * the token lives in `self-auth-client`, otherwise in the Supabase browser
 * client. Both are plain modules, so this works without a React context — the
 * home loaders are called from inside a component but are not components.
 */
export async function resolveHomeContentAccessToken(): Promise<string | null> {
  try {
    if (selfAuth.authProvider() === "self") {
      return selfAuth.getSession()?.access_token ?? null;
    }
    const { data } = await getSupabaseBrowserClient().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    // No configured client / storage unavailable: identical to "not signed in".
    return null;
  }
}
