import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// loadEnv also reads the variables of the shell, so the smoke test can move the servers to
// other ports. Without a variable, each server uses the port of the dev command.
const env = loadEnv("development", ".", "UIOBS_");
const appApi = `http://localhost:${env.UIOBS_APP_API_PORT || "8790"}`;
const ingest = `http://localhost:${env.UIOBS_MOCK_PORT || "8787"}`;

// This app sends no COOP and no COEP header. A cross-origin iframe and a popout window need the
// page to stay open to other origins and windows, and "require-corp" would block both. The cost
// meter still works, but the clock of a page that is not cross-origin isolated has a coarse
// step, so the blocks of the meter are longer. See the README.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // The app calls its API and its log backend on its own origin, as a production app behind a
    // reverse proxy does. The WebSocket of the price stream goes through the same proxy.
    proxy: {
      "/api": { target: appApi, ws: true },
      "/telemetry": { target: ingest, rewrite: (path) => path.replace(/^\/telemetry/, "") },
    },
  },
  // The build has four pages: the workspace, the two frames of the Research and the Untrusted
  // panels, and the window of one panel. The dev server serves each of them from the project root.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        research: fileURLToPath(new URL("research.html", import.meta.url)),
        untrusted: fileURLToPath(new URL("untrusted.html", import.meta.url)),
        panel: fileURLToPath(new URL("panel.html", import.meta.url)),
      },
    },
  },
  // The workers are created with type "module", so the build keeps them as modules. A worker
  // doesn't share chunks with the page, so each one is its own copy of the library core.
  worker: { format: "es" },
  test: {
    environment: "happy-dom",
    // The specs build URLs on the origin of the page, and the default about:blank has none.
    environmentOptions: { happyDOM: { url: "http://localhost:5180/" } },
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
