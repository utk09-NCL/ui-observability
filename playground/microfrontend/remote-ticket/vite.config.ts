import { federation } from "@module-federation/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // No @vitejs/plugin-react here. Its Fast Refresh transform expects a preamble
  // that the host document does not carry, because the shell is a plain
  // TypeScript Vite server, and the remote then throws "can't detect preamble"
  // on mount. Vite reads jsx from tsconfig.json and compiles .tsx without it.
  plugins: [
    federation({
      name: "ticket",
      filename: "remoteEntry.js",
      exposes: { "./mount": "./src/mount.tsx" },
      shared: { "@utk09/ui-observability": { singleton: true } },
      // The host declares these types by hand, so nothing consumes the
      // generated archive this would publish.
      dts: false,
    }),
  ],
  server: { port: 5193, strictPort: true, origin: "http://localhost:5193", cors: true },
  build: { target: "esnext" },
});
