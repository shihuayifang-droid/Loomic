// X-52 prep (T3): the static fallbacks must not point at the user asset bucket.
//
// The home page renders these arrays when the database returns nothing, which is
// exactly the case for an anonymous visitor. If a fallback still names
// `project-assets`, making that bucket private (X-52) breaks the home page for
// everyone who is not signed in — the failure would only show up after the
// cutover, so it is pinned here instead.
//
// Two layers are checked: the projection function itself (pure), and the arrays
// the UI actually consumes — the second is what would catch a seed literal that
// was added without going through the helper.
import { describe, expect, it } from "vitest";

import {
  homeExampleSeedCategories,
  legacySeed,
  toHomeSeedsPublicUrl,
} from "./home-example-seeds";
import { homeDiscoverySeedCategories } from "./home-discovery-seeds";

const OLD_PREFIX = "/storage/v1/object/public/project-assets/home-seeds/";
const NEW_PREFIX = "/storage/v1/object/public/home-seeds/";

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
});
