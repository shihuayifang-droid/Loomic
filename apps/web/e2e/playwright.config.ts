import { defineConfig } from "@playwright/test";

// Edge (channel "msedge") is used so no browser download is needed on this machine.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: {
    channel: "msedge",
    headless: true,
    baseURL: "http://127.0.0.1:4317",
  },
  webServer: {
    command: "node static-server.mjs",
    url: "http://127.0.0.1:4317/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

