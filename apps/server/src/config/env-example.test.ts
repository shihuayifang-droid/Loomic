import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * OP-13 guard: the repo-root `.env.example` must document every environment
 * variable `src/config/env.ts` reads, carry no real secret, and not repeat a key.
 */
const ENV_SOURCE = readFileSync(new URL("./env.ts", import.meta.url), "utf8");
const ENV_EXAMPLE = readFileSync(
  new URL("../../../../.env.example", import.meta.url),
  "utf8",
);

const SOURCE_KEY_PATTERN = /source\.([A-Z][A-Z0-9_]+)/g;
const EXAMPLE_KEY_PATTERN = /^#?\s*([A-Z][A-Z0-9_]+)=(.*)$/gm;
const SECRET_NAME_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD)/;

/**
 * Placeholder spellings already used by `.env.example` itself: an empty value,
 * a `your-…` / `<…>` / `...` stub, or one of the literal example payloads below.
 */
const PLACEHOLDER_PREFIXES = ["your-", "<", "..."];
const PLACEHOLDER_LITERALS = [
  '{"x":"...","y":"...","alg":"ES256","crv":"P-256","kty":"EC","key_ops":["verify"]}',
];

type ExampleEntry = { key: string; value: string };

function readServerSourceKeys(): string[] {
  const keys = new Set<string>();
  for (const match of ENV_SOURCE.matchAll(SOURCE_KEY_PATTERN)) {
    const key = match[1];
    if (key) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

function readExampleEntries(): ExampleEntry[] {
  const entries: ExampleEntry[] = [];
  for (const match of ENV_EXAMPLE.matchAll(EXAMPLE_KEY_PATTERN)) {
    const key = match[1];
    if (!key) {
      continue;
    }
    const rawValue = match[2] ?? "";
    const withoutComment = rawValue.split("#")[0] ?? "";
    entries.push({ key, value: withoutComment.trim() });
  }
  return entries;
}

function isPlaceholder(value: string): boolean {
  if (value === "") {
    return true;
  }
  if (PLACEHOLDER_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return true;
  }
  return PLACEHOLDER_LITERALS.includes(value);
}

describe("OP-13 .env.example", () => {
  it("OP-13: every key the server reads is listed in .env.example", () => {
    const serverKeys = readServerSourceKeys();
    const exampleKeys = new Set(readExampleEntries().map((entry) => entry.key));
    const missing = serverKeys.filter((key) => !exampleKeys.has(key));

    expect(
      missing,
      `keys read by src/config/env.ts but missing from .env.example: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("OP-13: .env.example carries no real secret", () => {
    const offenders = readExampleEntries()
      .filter((entry) => SECRET_NAME_PATTERN.test(entry.key))
      .filter((entry) => !isPlaceholder(entry.value))
      .map((entry) => `${entry.key}=${entry.value}`);

    expect(
      offenders,
      `secret-looking keys with a non-placeholder value: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("OP-13: no key appears twice", () => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const entry of readExampleEntries()) {
      if (seen.has(entry.key)) {
        duplicates.add(entry.key);
      }
      seen.add(entry.key);
    }

    const duplicated = [...duplicates].sort();
    expect(
      duplicated,
      `keys listed more than once in .env.example: ${duplicated.join(", ")}`,
    ).toEqual([]);
  });
});
