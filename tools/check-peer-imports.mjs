// tools/check-peer-imports.mjs
//
// Fails if a built file imports an optional peer by name. The Vite dev server resolves
// each string-literal import. A consumer without the peer then gets an error.
// Peers load only through the loaders that the consumer supplies.

import { readdirSync, readFileSync } from "node:fs";

const PEERS = Object.keys(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).peerDependencies,
);
const DIST = new URL("../dist/", import.meta.url);

const files = readdirSync(DIST, { recursive: true }).filter((name) => /\.(js|cjs)$/.test(name));

if (files.length === 0) {
  console.error("peer-imports: dist/ holds no built files. Run the build first.");
  process.exit(1);
}

const found = [];

for (const file of files) {
  const source = readFileSync(new URL(file, DIST), "utf8");

  for (const peer of PEERS) {
    const quoted = `["'\`]${peer.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["'\`]`;
    const dynamic = `import\\s*\\((\\s|/\\*.*?\\*/)*${quoted}`;
    const pattern = new RegExp(`${dynamic}|from\\s*${quoted}|require\\(\\s*${quoted}`, "s");

    if (pattern.test(source)) {
      found.push(`${file}: ${peer}`);
    }
  }
}

if (found.length > 0) {
  console.error("peer-imports: optional peers imported by name:");

  for (const line of found) {
    console.error(`  ${line}`);
  }

  process.exit(1);
}

console.log(`peer-imports: ${files.length} files, no peer imported by name`);
