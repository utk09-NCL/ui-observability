import { federation } from "@module-federation/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    federation({
      name: "host",
      remotes: {
        blotter: { type: "module", name: "blotter", entry: "http://localhost:5192/remoteEntry.js" },
        ticket: { type: "module", name: "ticket", entry: "http://localhost:5193/remoteEntry.js" },
      },
      // Sharing saves the bytes and keeps one module instance. It is not what
      // makes this correct: the runtime is pinned to a symbol on globalThis, so
      // three unshared copies of the library would still find one runtime.
      shared: { "ui-observability": { singleton: true } },
      // src/remotes.d.ts declares what the remotes export. Left on, the DTS
      // plugin writes a generated @mf-types tree into the workspace and the
      // host races the remotes for it at startup.
      dts: false,
    }),
  ],
  server: { port: 5191, strictPort: true },
  build: { target: "esnext" },
});
