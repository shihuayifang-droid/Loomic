// @vitest-environment node
//
// The environment pragma above exists for case 4 only, which reads a source file
// off disk. Under the project-wide `jsdom` environment `import.meta.url` is an
// `http://localhost/...` URL, so `readFileSync(new URL(...))` fails with
// ERR_INVALID_URL_SCHEME; in the node environment it is a real `file:` URL.
// The other cases are pure data and strings and do not care which one runs them.
//
// X-52 prep (T3): the static fallbacks must not point at the user asset bucket.
//
// The home page renders these arrays when the database returns nothing, which is
// exactly the case for an anonymous visitor. If a fallback still names
// `project-assets`, making that bucket private (X-52) breaks the home page for
// everyone who is not signed in — the failure would only show up after the
// cutover, so it is pinned here instead.
//
// Three layers are checked: the projection function itself (pure), the arrays the
// UI actually consumes — which is what would catch a seed literal added without
// going through the helper — and the helper module's own dependency edges.
//
// The third layer is the odd one out: it reads a FILE rather than calling code,
// because "this module imports nothing" is the invariant that keeps the discovery
// page from pulling the 185-example library into its bundle. It held only because
// someone checked by hand once; the next `import` added here would silently undo
// the split, and no behavioural test would notice.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { homeExampleSeedCategories } from "./home-example-seeds";
import { homeDiscoverySeedCategories } from "./home-discovery-seeds";
import { legacySeed, toHomeSeedsPublicUrl } from "./home-seeds-url";

const OLD_PREFIX = "/storage/v1/object/public/project-assets/home-seeds/";
const NEW_PREFIX = "/storage/v1/object/public/home-seeds/";

/**
 * Blank out comments and string/template literals while preserving offsets and
 * line breaks.
 *
 * The assertions below are about what the file DOES, so prose that merely says
 * the word "import" must not count, and neither must a URL's `//` looking like
 * the start of a line comment.
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let index = 0;
  let quote: '"' | "'" | "`" | null = null;

  while (index < source.length) {
    const char = source[index];

    if (quote !== null) {
      if (char === "\\") {
        out += "  ";
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
        out += " ";
        index += 1;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    const next = source[index + 1];

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        out += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      out += "  ";
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += " ";
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/** Every spelling of a dependency edge, with the name to report it under. */
const DEPENDENCY_EDGE_PATTERNS: Array<[string, RegExp]> = [
  ["static import", /^\s*import\b/gm], // import x from "y" / import "y"
  ["dynamic import", /\bimport\s*\(/g], // import("y")
  ["re-export", /^\s*export\b[^;\n]*\bfrom\b/gm], // export … from "y"
  ["require", /\brequire\s*\(/g], // require("y")
];

/** The names of the dependency edges a source file contains; empty means none. */
function findDependencyEdges(source: string): string[] {
  const code = stripCommentsAndStrings(source);
  return DEPENDENCY_EDGE_PATTERNS.filter(([, pattern]) => code.match(pattern) !== null).map(
    ([label]) => label,
  );
}

describe("home seed URL projection (X-52 prep)", () => {
  it("case 1: a seed URL moves to the seed bucket", () => {
    const key = "discovery/branding-design/cover.webp";

    expect(toHomeSeedsPublicUrl(legacySeed(key))).toBe(
      `https://jmcrxgenontlkxktpihl.supabase.co${NEW_PREFIX}${key}`,
    );
    // The path after the bucket is unchanged, so the object key still matches.
    expect(toHomeSeedsPublicUrl(legacySeed(key))).toContain(`/${key}`);
  });

  it("case 2: anything that is not a seed URL is returned unchanged", () => {
    const untouched = [
      "https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/workspace-1/p.png",
      "https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/user-avatars/a.png",
      "https://example.test/home-seeds/cover.webp",
      "https://cdn.test/storage/v1/object/public/project-assets/home-seeds/x.webp",
      "not a url at all, just text mentioning home-seeds/",
      "",
    ];

    for (const url of untouched) {
      expect(toHomeSeedsPublicUrl(url)).toBe(url);
    }
  });

  it("case 3: every URL the UI can render points at the seed bucket", () => {
    const urls = [
      ...homeExampleSeedCategories.flatMap((category) =>
        category.examples.flatMap((example) => [
          ...example.previewImages,
          ...example.inputMentions.map((mention) => mention.imgSrc),
        ]),
      ),
      ...homeDiscoverySeedCategories.flatMap((category) =>
        category.cases.flatMap((entry) => [
          entry.coverImageUrl,
          entry.authorAvatarUrl,
          ...(entry.sourceUrl ? [entry.sourceUrl] : []),
        ]),
      ),
    ];

    // 201 static fallback URLs originally hard-coded the old prefix.
    expect(urls.length).toBeGreaterThanOrEqual(201);
    expect(urls.some((url) => url.includes(OLD_PREFIX))).toBe(false);
    expect(urls.filter((url) => url.includes(NEW_PREFIX)).length).toBeGreaterThanOrEqual(201);
  });

  it("case 4: the helper module has no dependency edge at all", () => {
    const source = readFileSync(new URL("./home-seeds-url.ts", import.meta.url), "utf8");

    expect(findDependencyEdges(source)).toEqual([]);

    // The assertion above is only worth something if it CAN fail, so feed the same
    // detector the four spellings of an edge, one at a time.
    const controls: Array<[string, string]> = [
      ["static import", 'import { x } from "./x";'],
      ["dynamic import", 'const x = await import("./x");'],
      ["re-export", 'export { x } from "./x";'],
      ["require", 'const x = require("./x");'],
    ];
    for (const [label, snippet] of controls) {
      expect(findDependencyEdges(snippet), `${label} must be detected`).toEqual([label]);
    }

    // Prose and URLs must NOT be mistaken for edges — that is what the stripping
    // is for, and a helper whose header mentions importing is not a violation.
    expect(
      findDependencyEdges(
        '// this module imports nothing on purpose\nconst u = "https://x.test/a";',
      ),
    ).toEqual([]);

    // And it is still the module we think it is: without this, an empty file or a
    // path that resolved elsewhere would satisfy everything above.
    expect(source).toContain("export function legacySeed(");
    expect(source).toContain("export function toHomeSeedsPublicUrl(");
  });
});
