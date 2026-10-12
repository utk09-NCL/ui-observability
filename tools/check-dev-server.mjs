// tools/check-dev-server.mjs
//
// Fails if the Vite dev server cannot load the library without the optional peers. It starts Vite on
// playground/console-only and transforms each module that the app reaches, dynamic imports included.
// The playground plugin "forbid-optional-peers" fails a transform that imports a peer by name.
// The production build does not run that analysis. Only this check finds the fault.

import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = fileURLToPath(new URL("../playground/console-only/", import.meta.url));
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const ENTRY = "/src/main.ts";

/**
 * Tests whether a module belongs to the app or to the library build. Other modules, such as the
 * Vite client, are outside the scope of this check.
 * @param file Absolute file path of the module, or null.
 * @returns True if the check must transform the module.
 */
function inScope(file) {
  return file !== null && (file.startsWith(ROOT) || file.startsWith(DIST));
}

const server = await createServer({
  root: ROOT,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true, hmr: false },
});

const client = server.environments.client;
const seen = new Set();
const queue = [ENTRY];
let failed = false;

try {
  while (queue.length > 0) {
    const url = queue.shift();

    if (seen.has(url)) {
      continue;
    }

    seen.add(url);
    await client.transformRequest(url);

    const node = await client.moduleGraph.getModuleByUrl(url);

    for (const imported of node?.importedModules ?? []) {
      if (inScope(imported.file)) {
        queue.push(imported.url);
      }
    }
  }

  console.log(`dev: ${seen.size} modules load in the Vite dev server with no optional peer`);
} catch (error) {
  failed = true;
  console.error("dev: the Vite dev server cannot load the library.", error);
} finally {
  await server.close();
}

if (failed) {
  process.exit(1);
}
