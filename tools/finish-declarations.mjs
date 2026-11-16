// tools/finish-declarations.mjs
//
// Makes the declarations that tsc writes into dist/ usable under NodeNext. tsc copies the
// extensionless imports of src/ into each .d.ts, and NodeNext rejects them with TS2834. This adds
// .js to each relative import, and writes a .d.cts twin with .cjs imports for the require entry.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const EXTENSIONS = [".js", ".cjs", ".mjs", ".ts"];

/**
 * Lists the relative specifiers a declaration file imports. TypeScript's own scanner finds them,
 * so a path inside a JSDoc example or a string type isn't taken for an import.
 * @param source Text of a declaration file.
 * @returns Each relative specifier once.
 */
function relativeImports(source) {
  const imported = ts.preProcessFile(source, true, true).importedFiles;
  const names = imported.map((file) => file.fileName).filter((name) => name.startsWith("."));
  return [...new Set(names)];
}

/**
 * Finds the declaration file that a relative specifier points at.
 * @param file Declaration file that holds the import.
 * @param specifier Specifier as tsc wrote it, with no extension.
 * @returns The specifier of that file, still with no extension.
 */
function targetOf(file, specifier) {
  if (EXTENSIONS.some((extension) => specifier.endsWith(extension))) {
    throw new Error(
      `${file} imports "${specifier}", which already has an extension. Imports in src/ have ` +
        "none, so dist/ is probably already finished. Run pnpm run build, which empties it.",
    );
  }

  // "." and ".." always name a folder. Testing "<folder>.d.ts" for them would find the
  // folder's sibling file, and tsc writes import(".") on its own for a type from an index.
  const isFolder = specifier === "." || specifier === "..";
  const base = join(dirname(file), specifier);

  if (!isFolder && existsSync(`${base}.d.ts`)) {
    return specifier;
  }

  if (existsSync(join(base, "index.d.ts"))) {
    return `${specifier}/index`;
  }

  throw new Error(`${file} imports "${specifier}", and no declaration file matches it.`);
}

/**
 * Replaces a specifier in the two forms tsc writes, `from "x"` and `import("x")`. A string type
 * with the same text stays as it is, so the ESM and CJS types can't drift apart.
 * @param source Text of a declaration file.
 * @param specifier Specifier to replace.
 * @param replacement Specifier with its extension.
 * @returns The new text.
 */
function rewrite(source, specifier, replacement) {
  return source
    .replaceAll(`from "${specifier}"`, `from "${replacement}"`)
    .replaceAll(`import("${specifier}")`, `import("${replacement}")`);
}

/**
 * Rewrites one declaration file and writes its .d.cts twin.
 * @param file Absolute path of a .d.ts file.
 */
function finish(file) {
  const source = readFileSync(file, "utf8");
  let esm = source;
  let cjs = source;

  for (const specifier of relativeImports(source)) {
    const target = targetOf(file, specifier);
    esm = rewrite(esm, specifier, `${target}.js`);
    cjs = rewrite(cjs, specifier, `${target}.cjs`);
  }

  // rewrite() knows two forms with double quotes, so anything else tsc writes fails here.
  const missed = [
    ...relativeImports(esm).filter((specifier) => !specifier.endsWith(".js")),
    ...relativeImports(cjs).filter((specifier) => !specifier.endsWith(".cjs")),
  ];

  if (missed.length > 0) {
    throw new Error(`${file} still has imports with no extension: ${missed.join(", ")}`);
  }

  writeFileSync(file, esm);
  writeFileSync(file.replace(/\.d\.ts$/, ".d.cts"), cjs);
}

const files = readdirSync(DIST, { recursive: true }).filter((name) => name.endsWith(".d.ts"));

for (const name of files) {
  finish(join(DIST, name));
}

console.log(`declarations: added extensions to ${files.length} files and wrote their .d.cts twins`);
