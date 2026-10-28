// tools/check-size.mjs
//
// Fails if the main chunk graph of the build is larger than the gzip budget. The main graph is
// dist/index.js and each file that it imports statically. A dynamic import loads on demand.
// It is not part of the startup cost. This check does not follow it.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

/**
 * Gzip budget of the main graph, in bytes. It is the 0.6.0 size (16,008 B) plus 10 percent,
 * raised to 18,200 B in 0.8.0 for the custom transport, the memory transport and remote sampling.
 * In 0.9.0 it is the 0.9.0 size (21,496 B) plus 10 percent, for the config checks and the
 * hardening of capture, record building and delivery. Raise it only in a reviewed commit.
 */
const SIZE_BUDGET_GZIP_BYTES = 23_700;

const DIST = new URL("../dist/", import.meta.url);
const ENTRY = "index.js";

/** Matches a static import or re-export of a relative file. It does not match import(). */
const STATIC_IMPORT =
  /(?:^|[;\n])\s*(?:import|export)\s*(?:[^;"'()]*?\sfrom\s*)?["'](\.\/[^"']+)["']/g;

/**
 * Collects the entry and each file that it reaches through static imports.
 * @param entry File name inside dist/.
 * @returns File names of the main graph.
 */
function mainGraph(entry) {
  const seen = new Set();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift();

    if (seen.has(file)) {
      continue;
    }

    seen.add(file);
    const source = readFileSync(new URL(file, DIST), "utf8");

    for (const match of source.matchAll(STATIC_IMPORT)) {
      queue.push(match[1].slice(2));
    }
  }

  return [...seen];
}

let files;

try {
  files = mainGraph(ENTRY);
} catch (error) {
  console.error(`size: The script cannot read dist/${ENTRY}. Run the build first.`, error);
  process.exit(1);
}

let total = 0;

for (const file of files) {
  const bytes = gzipSync(readFileSync(new URL(file, DIST))).length;
  total += bytes;
  console.log(`size: ${String(bytes).padStart(7)} B gzip  ${file}`);
}

console.log(
  `size: ${String(total).padStart(7)} B gzip  main graph, budget ${SIZE_BUDGET_GZIP_BYTES} B`,
);

if (total > SIZE_BUDGET_GZIP_BYTES) {
  console.error(
    `size: the main graph is ${total - SIZE_BUDGET_GZIP_BYTES} B over the budget. ` +
      "Move the new code behind a dynamic import, or raise the budget in a reviewed commit.",
  );
  process.exit(1);
}
