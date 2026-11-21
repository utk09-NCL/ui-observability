import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// loadEnv also reads the variables of the shell, so the smoke test can move the servers to
// other ports. Without a variable, each server uses the port of the dev command.
const env = loadEnv("development", ".", "UIOBS_");
const appApi = `http://localhost:${env.UIOBS_APP_API_PORT || "8790"}`;
const ingest = `http://localhost:${env.UIOBS_MOCK_PORT || "8787"}`;

// With both headers the page is cross-origin isolated. performance.now() then has a step of
// 5 microseconds and not 100, which the cost meter needs. The library needs neither header, so
// a production app that copies the folders leaves them out.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5185,
    strictPort: true,
    headers: isolation,
    // The app calls its API and its log backend on its own origin, as a production app behind a
    // reverse proxy does. The library then reports a relative endpoint, see the README.
    proxy: {
      "/api": { target: appApi, ws: true },
      "/uilogs": { target: ingest },
      "/telemetry": { target: ingest, rewrite: (path) => path.replace(/^\/telemetry/, "") },
    },
  },
  preview: { headers: isolation },
  // The worker is created with type "module", so the build keeps it as a module. It doesn't
  // share chunks with the page, so it is a second copy of the library core, 113 kB and 35 kB gzip.
  worker: { format: "es" },
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
