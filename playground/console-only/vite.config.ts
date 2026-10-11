import { defineConfig, type Plugin } from "vite";

/** Optional peers of the library. This app installs neither. */
const OPTIONAL_PEERS = ["web-vitals", "@opentelemetry/api"];

/**
 * Fails each resolve of an optional peer by name.
 * The repo root installs both peers. This plugin stands in for a consumer that does not.
 * @returns Vite plugin.
 */
const forbidOptionalPeers = (): Plugin => ({
  name: "forbid-optional-peers",
  enforce: "pre",
  resolveId(source, importer) {
    const peer = OPTIONAL_PEERS.find((name) => source === name || source.startsWith(`${name}/`));

    if (peer) {
      this.error(
        `"${importer ?? "unknown"}" imports the optional peer "${peer}" by name. ` +
          "The library must not import an optional peer by name.",
      );
    }

    return null;
  },
});

export default defineConfig({
  plugins: [forbidOptionalPeers()],
  // Serve the library as source. This makes the plugin see each import in dist/index.js.
  optimizeDeps: { exclude: ["@utk09/ui-observability"] },
  server: { port: 5195, strictPort: true },
});
