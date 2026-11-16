// vite.cross-origin.config.ts
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  // This server loads src/ directly, like vite.config.ts does. Without the version define, the
  // child frame fails with a ReferenceError before the library starts.
  define: { __UIOBS_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5174, strictPort: true },
});
