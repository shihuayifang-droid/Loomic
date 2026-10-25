import type { Database } from "@loomic/shared";

import type { HomeContentDiscoveryCategory } from "./home-content-api";
import {
  fetchHomeDiscovery,
  resolveHomeContentAccessToken,
} from "./home-content-api";
import type { HomeDiscoveryCase, HomeDiscoveryCategory } from "./home-discovery-seeds";
import { homeDiscoverySeedCategories } from "./home-discovery-seeds";

type HomeDiscoveryCategoryRow =
  Database["public"]["Tables"]["home_discovery_categories"]["Row"];
type HomeDiscoveryCaseRow =
  Database["public"]["Tables"]["home_discovery_cases"]["Row"];

export function mapHomeDiscoveryRows(
  categories: HomeDiscoveryCategoryRow[],
  cases: HomeDiscoveryCaseRow[],
): HomeDiscoveryCategory[] {
  const casesByCategory = new Map<string, HomeDiscoveryCaseRow[]>();

  for (const item of cases) {
    const group = casesByCategory.get(item.category_key) ?? [];
    group.push(item);
    casesByCategory.set(item.category_key, group);
  }

  return [...categories]
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((category) => ({
      key: category.key,
      label: category.label,
      cases: [...(casesByCategory.get(category.key) ?? [])]
        .sort((left, right) => left.sort_order - right.sort_order)
        .map((item) => ({
          id: item.id,
          title: item.title,
          coverImageUrl: item.cover_image_url,
          authorName: item.author_name,
          authorAvatarUrl: item.author_avatar_url,
          viewCount: item.view_count,
          likeCount: item.like_count,
          prompt: item.seed_prompt,
        })),
    }));
}

/**
 * 工单45BS: the read API's discovery categories → the shape the home page renders.
 *
 * The names do NOT line up: the read route answers `coverImage` / `authorAvatar`
 * / `seedPrompt` (see `toCase` in apps/server/src/http/home.ts), while
 * `HomeDiscoveryCase` is keyed `coverImageUrl` / `authorAvatarUrl` / `prompt`.
 * Each one is mapped explicitly below. `caseUrl` becomes the optional
 * `sourceUrl` only when the server actually sent one, and both images are
 * already signed URLs, so they pass through untouched.
 */
export function mapHomeContentDiscoveryCategories(
  categories: HomeContentDiscoveryCategory[],
): HomeDiscoveryCategory[] {
  return categories.map((category) => ({
    key: category.key,
    label: category.label,
    cases: category.cases.map((item): HomeDiscoveryCase => ({
      id: item.id,
      title: item.title,
      coverImageUrl: item.coverImage,
      authorName: item.authorName,
      authorAvatarUrl: item.authorAvatar,
      viewCount: item.viewCount,
      likeCount: item.likeCount,
      prompt: item.seedPrompt,
      ...(item.caseUrl !== "" ? { sourceUrl: item.caseUrl } : {}),
    })),
  }));
}

/**
 * 工单45BS: the home page's discovery categories, read from the server.
 *
 * Signed in → `GET /api/home/discovery`. Not signed in, the request failed, or
 * the body was not the documented shape → the local seeds, plus one
 * `console.warn`. The section must not vanish over a flaky read, and the seeds
 * as fallback are what make this switch safe to ship.
 *
 * `accessToken` is optional on purpose: the only caller (`home/page.tsx`) calls
 * this with no argument and that file is outside this ticket, so an omitted
 * token is resolved from the auth session modules — never from a React context.
 */
export async function loadHomeDiscoveryCategories(
  accessToken?: string,
): Promise<HomeDiscoveryCategory[]> {
  const token = accessToken ?? (await resolveHomeContentAccessToken());
  if (!token) {
    console.warn("[home] no access token; showing the local discovery seeds");
    return homeDiscoverySeedCategories;
  }

  try {
    const categories = await fetchHomeDiscovery(token);
    const mapped = mapHomeContentDiscoveryCategories(categories);

    if (mapped.length === 0) {
      console.warn(
        "[home] /api/home/discovery returned no categories; showing the local discovery seeds",
      );
      return homeDiscoverySeedCategories;
    }

    return mapped;
  } catch (error) {
    console.warn(
      "[home] failed to read discovery from the server; showing the local discovery seeds",
      error,
    );
    return homeDiscoverySeedCategories;
  }
}
