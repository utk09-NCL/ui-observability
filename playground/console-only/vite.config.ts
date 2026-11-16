import { defineConfig, type Plugin } from "vite";

/** The library's optional peers. This app installs neither. */
const OPTIONAL_PEERS = ["web-vitals", "@opentelemetry/api"];

/**
 * Fails any attempt to resolve an optional peer by name.
 * The repo root installs both peers, so this plugin stands in for a consumer that doesn't.
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
  // Serve the library as source, so the plugin sees every import in dist/index.js.
  optimizeDeps: { exclude: ["@utk09/ui-observability"] },
  server: { port: 5195, strictPort: true },
});
