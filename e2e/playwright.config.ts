// e2e/playwright.config.ts
//
// Runs the browser tests in Chromium, Firefox and WebKit against the library's source.
// `pnpm run test:e2e` uses this file. It is separate from `pnpm run verify`.

import { defineConfig, devices } from "@playwright/test";
import {
  CROSS_ORIGIN,
  CROSS_ORIGIN_PORT,
  INGEST_ORIGIN,
  INGEST_PORT,
  PAGE_ORIGIN,
  PAGE_PATH,
  PAGE_PORT,
} from "./fixtures/ingest";

// vite.cross-origin.config.ts is the plain source server: it defines the version constant,
// sets strictPort and opens no browser tab. vite.config.ts opens the playground on every run.
const VITE = "pnpm exec vite --config vite.cross-origin.config.ts --port";

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  // All three browsers post to one mock server, and each test resets it. A second worker
  // would wipe the batches that the first one is about to assert.
  workers: 1,
  forbidOnly: true,
  reporter: "list",
  timeout: 30_000,
  use: { baseURL: PAGE_ORIGIN },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  // A server that is already on one of these ports could be an older build, so a run never
  // reuses it. The run fails with "port in use" instead.
  webServer: [
    {
      command: "node tools/mock-ingest-server.mjs",
      // Without UIOBS_MOCK_RECORD the server keeps no request, and /__received stays empty.
      env: { UIOBS_MOCK_PORT: String(INGEST_PORT), UIOBS_MOCK_RECORD: "1" },
      url: `${INGEST_ORIGIN}/__received`,
      cwd: "..",
      reuseExistingServer: false,
    },
    {
      command: `${VITE} ${String(PAGE_PORT)}`,
      url: `${PAGE_ORIGIN}${PAGE_PATH}`,
      cwd: "..",
      reuseExistingServer: false,
    },
    {
      command: `${VITE} ${String(CROSS_ORIGIN_PORT)}`,
      url: `${CROSS_ORIGIN}${PAGE_PATH}`,
      cwd: "..",
      reuseExistingServer: false,
    },
  ],
});
