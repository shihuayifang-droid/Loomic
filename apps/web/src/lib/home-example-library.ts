import type { Database } from "@loomic/shared";

import type { HomeContentExampleCategory } from "./home-content-api";
import {
  fetchHomeExamples,
  resolveHomeContentAccessToken,
} from "./home-content-api";
import type { HomeExampleCategory, InputMention } from "./home-example-seeds";
import { homeExampleSeedCategories } from "./home-example-seeds";

type HomeExampleCategoryRow =
  Database["public"]["Tables"]["home_example_categories"]["Row"];
type HomeExampleExampleRow =
  Database["public"]["Tables"]["home_example_examples"]["Row"];

export function mapHomeExampleRows(
  categories: HomeExampleCategoryRow[],
  examples: HomeExampleExampleRow[],
): HomeExampleCategory[] {
  const examplesByCategory = new Map<string, HomeExampleExampleRow[]>();

  for (const example of examples) {
    const group = examplesByCategory.get(example.category_key) ?? [];
    group.push(example);
    examplesByCategory.set(example.category_key, group);
  }

  return [...categories]
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((category) => ({
      key: category.key,
      label: category.label,
      dataType: category.data_type,
      ...(category.accent === "special"
        ? { accent: "special" as const }
        : {}),
      examples: [...(examplesByCategory.get(category.key) ?? [])]
        .sort((left, right) => left.sort_order - right.sort_order)
        .map((example) => ({
          title: example.title,
          prompt: example.prompt,
          previewImages: example.image_urls,
          inputMentions: (Array.isArray(example.input_mentions) ? example.input_mentions : []) as InputMention[],
        })),
    }));
}

/**
 * 工单45BS: the read API's example categories → the shape the home page renders.
 *
 * Every field lines up except `dataType`: 45BR answers `key` / `label` /
 * `examples` only, while `HomeExampleCategory` requires a `dataType` that no
 * component reads. The seed's own value for the same key is reused instead of
 * inventing a data type per category; a key the seeds do not know gets "".
 * `previewImages` / `inputMentions[].imgSrc` are already signed URLs, so they
 * pass through untouched.
 */
export function mapHomeContentExampleCategories(
  categories: HomeContentExampleCategory[],
): HomeExampleCategory[] {
  return categories.map((category) => {
    const seed = homeExampleSeedCategories.find(
      (candidate) => candidate.key === category.key,
    );

    return {
      key: category.key,
      label: category.label,
      dataType: seed?.dataType ?? "",
      ...(seed?.accent === "special" ? { accent: "special" as const } : {}),
      examples: category.examples.map((example) => ({
        title: example.title,
        prompt: example.prompt,
        previewImages: [...example.previewImages],
        inputMentions: example.inputMentions.map((mention) => ({
          type: mention.type,
          name: mention.name,
          imgSrc: mention.imgSrc,
        })),
      })),
    };
  });
}

/**
 * 工单45BS: the home page's example categories, read from the server.
 *
 * Signed in → `GET /api/home/examples`. Not signed in, the request failed, or
 * the body was not the documented shape → the local seeds, plus one
 * `console.warn` so the fallback is visible instead of looking like an empty
 * home page. The page must never blank out over a flaky read, and keeping the
 * seeds as the fallback is also what makes this switch safe to ship.
 *
 * `accessToken` is optional on purpose: the only caller (`home/page.tsx`) calls
 * this with no argument and that file is outside this ticket, so an omitted
 * token is resolved from the auth session modules — never from a React context.
 */
export async function loadHomeExampleCategories(
  accessToken?: string,
): Promise<HomeExampleCategory[]> {
  const token = accessToken ?? (await resolveHomeContentAccessToken());
  if (!token) {
    console.warn("[home] no access token; showing the local example seeds");
    return homeExampleSeedCategories;
  }

  try {
    const categories = await fetchHomeExamples(token);
    const mapped = mapHomeContentExampleCategories(categories);

    if (mapped.length === 0) {
      console.warn(
        "[home] /api/home/examples returned no categories; showing the local example seeds",
      );
      return homeExampleSeedCategories;
    }

    return mapped;
  } catch (error) {
    console.warn(
      "[home] failed to read examples from the server; showing the local example seeds",
      error,
    );
    return homeExampleSeedCategories;
  }
}
