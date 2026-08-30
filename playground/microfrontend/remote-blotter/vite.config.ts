import { federation } from "@module-federation/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    federation({
      name: "blotter",
      filename: "remoteEntry.js",
      exposes: { "./mount": "./src/mount.ts" },
      shared: { "ui-observability": { singleton: true } },
      // The host declares these types by hand, so nothing consumes the
      // generated archive this would publish.
      dts: false,
    }),
  ],
  // The host imports this origin's modules across a port boundary. Without
  // `origin`, the dev server emits relative asset URLs that resolve against
  // 5191 and 404, and without `cors` the browser rejects the import.
  server: { port: 5192, strictPort: true, origin: "http://localhost:5192", cors: true },
  build: { target: "esnext" },
});
