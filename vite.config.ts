// vite.config.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  // Bakes the package version into the build. vitest.config.ts defines the same value.
  define: { __UIOBS_VERSION__: JSON.stringify(pkg.version) },
  build: {
    lib: {
      // Use fileURLToPath, because on Windows URL.pathname returns "/C:/..." and the build fails.
      // The doctor entry is there for bin/uiobs.mjs. The package's exports map doesn't list it.
      entry: {
        index: fileURLToPath(new URL("src/index.ts", import.meta.url)),
        doctor: fileURLToPath(new URL("src/doctor.ts", import.meta.url)),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) => `${entryName}.${format === "es" ? "js" : "cjs"}`,
    },
    rollupOptions: {
      // Every entry here is either a real dependency or the one optional peer.
      // If a framework name ever appears in this array, something under src/
      // has started importing one, and the fix is in src/ rather than here.
      external: ["@opentelemetry/api", "@rrweb/record", "web-vitals"],
    },
    sourcemap: true,
    target: "es2022",
    // The build script runs `tsc --project tsconfig.build.json` first, which
    // emits the declarations into dist/. Vite empties outDir by default, so
    // leaving this true deletes index.d.ts a moment after tsc writes it.
    // `rimraf dist` at the head of the build script does the cleaning instead.
    emptyOutDir: false,
  },
  server: { port: 5173, open: "/playground/vanilla/index.html" },
});
