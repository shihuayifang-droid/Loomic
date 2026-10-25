import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // ~85 suites under src/test-support/db need a real Postgres; they run via `test:db`.
    exclude: ["**/node_modules/**", "**/dist/**", "src/test-support/db/**"],
    // backup/restore suites shell out to bash and pg_dump; the 5s default is too tight.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
