import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { applicationErrorResponseSchema } from "@loomic/shared";

import { validationErrorBody } from "./validation-error.js";

describe("validation error body", () => {
  it("X-40: the validation body carries error.code invalid_request and the shared message", () => {
    expect(validationErrorBody([{ path: ["a"] }])).toEqual({
      error: { code: "invalid_request", message: "Invalid request body" },
      issues: [{ path: ["a"] }],
      message: "Invalid request body",
    });
  });

  it("X-40: the body parses as an application error response", () => {
    expect(() =>
      applicationErrorResponseSchema.parse(validationErrorBody([])),
    ).not.toThrow();
  });

  it("X-40: no route in this batch answers a bare { issues, message } any more", () => {
    const routeFiles = [
      "./brand-kits.ts",
      "./skills.ts",
      "./jobs.ts",
      "./projects.ts",
    ];

    for (const routeFile of routeFiles) {
      const source = readFileSync(new URL(routeFile, import.meta.url), "utf8");
      const matches = source.match(/send\(\s*\{\s*issues:/g) ?? [];
      expect(matches, routeFile).toHaveLength(0);
    }
  });
});
