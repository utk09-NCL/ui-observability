// tools/check-size.mjs
//
// Fails if the build's main chunk graph is over the gzip budget. The main graph is dist/index.js
// plus every file it imports statically. A dynamic import loads on demand and isn't part of the
// startup cost, so this check doesn't follow it.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

/**
 * Gzip budget for the main graph, in bytes. The rule is the measured size at release plus
 * 10 percent. Only raise it in a reviewed commit.
 *
 * - 0.6.0: 16,008 B measured, plus 10 percent.
 * - 0.8.0: raised to 18,200 B for the custom transport, the memory transport and remote sampling.
 * - 0.9.0: 21,496 B plus 10 percent. Config checks, and hardening of capture, record building
 *   and delivery.
 * - 0.9.1: 24,041 B plus 10 percent. Config tunables, the onDrop report and the action caps.
 * - 0.9.2: 26,055 B plus 10 percent. Counter, histogram and the OTLP metrics export.
 * - 0.9.3: 26,513 B plus 10 percent, after the cleanup's shared helpers.
 * - 0.9.4: 29,216 B plus 10 percent. Spans, plugins, processors, stats and the forwarder redact.
 * - The operational controls took the main graph to 33,831 B. The 36,000 B budget covers the
 *   delivery, capture and correlation settings and the storage controls.
 * - 0.10.0: 39,532 B plus 10 percent. Debug buffer, diagnostic records, worker entry, startMeasure.
 * - Profiler P1: 44,350 B, the measured size with no margin. Self time, async spans, time()
 *   (named wrap() back then) and endAfterPaint(). Approved by the maintainer on 2026-11-15.
 * - Session replay R1: 45,287 B plus 10 percent. The replay config section, the error hook and
 *   the consent functions. The maintainer approved this rule on 2026-11-16.
 * - 0.12.0: 45,448 B plus 10 percent. The replay capture's own install key and the renamed
 *   options. Approved by the maintainer on 2026-11-16.
 */
const SIZE_BUDGET_GZIP_BYTES = 49_993;

const DIST = new URL("../dist/", import.meta.url);
const ENTRY = "index.js";

/** Matches a static import or re-export of a relative file. Doesn't match import(). */
const STATIC_IMPORT =
  /(?:^|[;\n])\s*(?:import|export)\s*(?:[^;"'()]*?\sfrom\s*)?["'](\.\/[^"']+)["']/g;

/**
 * Collects the entry and every file it reaches through static imports.
 * @param entry File name inside dist/.
 * @returns File names in the main graph.
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
