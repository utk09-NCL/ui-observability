// e2e/playground/playwright.config.ts
//
// Runs the smoke test of each playground app in Chromium. `pnpm run test:playground` uses this
// file. It is separate from `pnpm run verify` and from `pnpm run test:e2e`, and a smoke test has
// the suffix .smoke.ts, so the e2e config doesn't pick it up.

import { defineConfig, devices } from "@playwright/test";
import {
  APP_API_ORIGIN,
  APP_API_PORT,
  APP_ORIGIN,
  APP_PORT,
  INGEST_ORIGIN,
  INGEST_PORT,
} from "./ports";

// The app dev server reads these two variables for its proxy, so it calls the test servers.
const proxyTargets = {
  UIOBS_APP_API_PORT: String(APP_API_PORT),
  UIOBS_MOCK_PORT: String(INGEST_PORT),
};

export default defineConfig({
  testDir: ".",
  testMatch: "*.smoke.ts",
  // Each test resets the servers, so two workers would wipe each other's records.
  workers: 1,
  forbidOnly: true,
  reporter: "list",
  timeout: 60_000,
  use: { baseURL: APP_ORIGIN },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // A server that is already on one of these ports could be an older build, so a run never
  // reuses it. The run fails with "port in use" instead.
  webServer: [
    {
      command: "node tools/mock-ingest-server.mjs",
      // Without UIOBS_MOCK_RECORD the server keeps no request, and /__received stays empty.
      env: { UIOBS_MOCK_PORT: String(INGEST_PORT), UIOBS_MOCK_RECORD: "1" },
      url: `${INGEST_ORIGIN}/__received`,
      cwd: "../..",
      reuseExistingServer: false,
    },
    {
      command: "node tools/mock-app-api.mjs",
      env: { UIOBS_APP_API_PORT: String(APP_API_PORT) },
      url: `${APP_API_ORIGIN}/api/__fault`,
      cwd: "../..",
      reuseExistingServer: false,
    },
    {
      command: `pnpm --filter @example/react-custom-backend exec vite --port ${String(APP_PORT)} --strictPort`,
      env: proxyTargets,
      url: APP_ORIGIN,
      cwd: "../..",
      reuseExistingServer: false,
    },
  ],
});
