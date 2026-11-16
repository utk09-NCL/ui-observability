// tools/check-consumers.mjs
//
// Fails if a strict consumer can't use the published package. It packs the tarball the way a
// publish does, installs it with no optional peer, type-checks a NodeNext ESM, a NodeNext CommonJS
// and a Bundler consumer with skipLibCheck off, and then loads the package with import and require.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const { name: PACKAGE, peerDependencies } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const PEERS = Object.keys(peerDependencies);
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

/** One consumer per resolution mode. Each one has to load only declarations of its extension. */
const CONSUMERS = [
  {
    name: "nodenext-esm",
    type: "module",
    file: "index.ts",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    extension: ".d.ts",
  },
  {
    name: "nodenext-cjs",
    type: "commonjs",
    file: "index.cts",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    extension: ".d.cts",
  },
  {
    name: "bundler",
    type: "module",
    file: "index.ts",
    module: "ESNext",
    moduleResolution: "Bundler",
    extension: ".d.ts",
  },
];

/** Strict options a careful consumer uses. skipLibCheck stays off, so tsc checks our files too. */
const STRICT_OPTIONS = {
  target: "ES2022",
  lib: ["ES2022", "DOM"],
  strict: true,
  skipLibCheck: false,
  noEmit: true,
  types: [],
};

// The NotAny rows fail if an export's type turns into any, which a broken declaration file can
// do without any error. The @ts-expect-error lines fail if a wrong call compiles.
const CONSUMER_SOURCE = `import {
  configure,
  counter,
  getLogger,
  type LossReason,
  type ObservabilityConfig,
} from "${PACKAGE}";

type NotAny<T> = 0 extends 1 & T ? false : true;
type Assert<T extends true> = T;

export type Checks = [
  Assert<NotAny<typeof configure>>,
  Assert<NotAny<ObservabilityConfig>>,
  Assert<NotAny<ReturnType<typeof getLogger>>>,
  Assert<NotAny<LossReason>>,
];

configure({ endpoint: "https://ingest.example/v1/logs", serviceName: "consumer" });
getLogger("consumer.check").info("ready", { step: 1 });
counter("consumer.requests").add(1);
export const reason: LossReason = "partially_rejected";

// @ts-expect-error serviceName is a string.
configure({ serviceName: 42 });

// @ts-expect-error "lost" isn't a LossReason.
export const wrong: LossReason = "lost";

// @ts-expect-error The exports map has one entry point, so a deep import doesn't resolve.
export type { LogRecord } from "${PACKAGE}/dist/index.js";
`;

/** Prints the file that import resolved and the export names it got. */
const ESM_LOADER = `const m = await import("${PACKAGE}");
const file = import.meta.resolve("${PACKAGE}");
console.log(JSON.stringify({ file, keys: Object.keys(m).sort() }));
`;

/** Prints the file that require resolved and the export names it got. */
const CJS_LOADER = `const m = require("${PACKAGE}");
const file = require.resolve("${PACKAGE}");
console.log(JSON.stringify({ file, keys: Object.keys(m).sort() }));
`;

/**
 * Runs a command and captures its output.
 * @param command Program to start.
 * @param args Its arguments.
 * @param cwd Working directory.
 * @returns The spawnSync result. Throws if the program can't start.
 */
function run(command, args, cwd) {
  const options = { cwd, encoding: "utf8" };
  let result;

  if (process.platform === "win32" && command === "pnpm") {
    // pnpm is a .cmd file on Windows, and only a shell can start one. The shell splits on
    // spaces, so each argument is quoted or a temp path under "C:\Users\First Last" breaks.
    const line = [command, ...args.map((arg) => `"${arg}"`)].join(" ");
    result = spawnSync(line, { ...options, shell: true });
  } else {
    result = spawnSync(command, args, options);
  }

  if (result.error) {
    throw result.error;
  }

  return result;
}

/**
 * Packs the package and unpacks it into root/node_modules, the way an install would.
 * @param root Temporary consumer root.
 * @returns True if the package is in place.
 */
function install(root) {
  // pnpm pack runs the prepare script, so the tarball comes from a fresh build, as in a publish.
  const packed = run("pnpm", ["pack", "--pack-destination", root], ROOT);

  if (packed.status !== 0) {
    console.error("consumers: pnpm pack failed.", packed.stdout, packed.stderr);
    return false;
  }

  const tarball = readdirSync(root).find((file) => file.endsWith(".tgz"));
  const target = `node_modules/${PACKAGE}`;
  mkdirSync(join(root, target), { recursive: true });
  // Relative paths, because GNU tar reads the "C:" of an absolute Windows path as a remote host.
  const unpacked = run("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"], root);

  if (unpacked.status !== 0) {
    console.error("consumers: tar can't unpack the tarball.", unpacked.stderr);
    return false;
  }

  return true;
}

/**
 * Type-checks one consumer and checks which declaration files tsc read from the package.
 * @param root Temporary consumer root.
 * @param consumer One entry of CONSUMERS.
 * @returns True if the consumer compiles against the right declarations.
 */
function typeCheck(root, consumer) {
  const dir = join(root, consumer.name);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: consumer.type }));
  writeFileSync(join(dir, consumer.file), CONSUMER_SOURCE);
  const compilerOptions = {
    ...STRICT_OPTIONS,
    module: consumer.module,
    moduleResolution: consumer.moduleResolution,
  };
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions, files: [consumer.file] }),
  );

  const result = run(process.execPath, [TSC, "--project", dir, "--listFiles"], dir);
  const lines = result.stdout.split(/\r?\n/);
  const errors = lines.filter((line) => line.includes("error TS"));
  const loaded = lines.filter((line) => line.includes(`/node_modules/${PACKAGE}/dist/`));
  const wrongFormat = loaded.filter((file) => !file.endsWith(consumer.extension));
  const entry = `index${consumer.extension}`;
  const hasEntry = loaded.some((file) => file.endsWith(`/dist/${entry}`));

  if (result.status === 0 && hasEntry && wrongFormat.length === 0) {
    console.log(
      `consumers: ${consumer.name} compiles against ${loaded.length} ${consumer.extension} files`,
    );
    return true;
  }

  console.error(`consumers: ${consumer.name} fails with ${errors.length} tsc errors.`);
  for (const line of errors) {
    console.error(`  ${line}`);
  }

  if (!hasEntry) {
    console.error(`  tsc didn't load dist/${entry}.`);
  }

  if (wrongFormat.length > 0) {
    console.error(`  tsc loaded ${wrongFormat.length} files that aren't ${consumer.extension}.`);
  }

  return false;
}

/**
 * Checks whether a package resolves from the consumer root.
 * @param root Temporary consumer root.
 * @param name Package name.
 * @returns True if the package is installed there.
 */
function resolves(root, name) {
  try {
    createRequire(join(root, "consumer.js")).resolve(name);
    return true;
  } catch (error) {
    // A package that exists but has no require entry still counts as installed.
    return error.code !== "MODULE_NOT_FOUND";
  }
}

/**
 * Runs one loader script in the consumer root.
 * @param root Temporary consumer root.
 * @param script File name, load.mjs or load.cjs.
 * @param source The script's text.
 * @returns The file the package resolved to and its export names, or undefined if Node failed.
 */
function load(root, script, source) {
  writeFileSync(join(root, script), source);
  const result = run(process.execPath, [script], root);

  if (result.status !== 0) {
    console.error(`consumers: node ${script} can't load the package.`, result.stderr);
    return undefined;
  }

  return JSON.parse(result.stdout);
}

/**
 * Loads the package with import and require, and compares what each one got.
 * @param root Temporary consumer root.
 * @returns True if each format loads its own build with the same exports and no optional peer.
 */
function loadsAtRuntime(root) {
  const installedPeers = PEERS.filter((peer) => resolves(root, peer));

  if (installedPeers.length > 0) {
    console.error(`consumers: the runtime check needs no peer, but found ${installedPeers}.`);
    return false;
  }

  const esm = load(root, "load.mjs", ESM_LOADER);
  const cjs = load(root, "load.cjs", CJS_LOADER);

  if (esm === undefined || cjs === undefined) {
    return false;
  }

  // Node 22.12 and later can require() an ES module, so equal exports don't prove that
  // require gets the CommonJS build. The resolved file names do.
  const esmFile = basename(fileURLToPath(esm.file));
  const cjsFile = basename(cjs.file);

  if (esmFile !== "index.js" || cjsFile !== "index.cjs") {
    console.error(`consumers: import loads ${esmFile} and require loads ${cjsFile}.`);
    return false;
  }

  const esmKeys = JSON.stringify(esm.keys);

  if (esmKeys !== JSON.stringify(cjs.keys) || !esm.keys.includes("configure")) {
    console.error("consumers: import and require give different exports.", esm.keys, cjs.keys);
    return false;
  }

  console.log(
    `consumers: import loads ${esmFile} and require loads ${cjsFile}, ` +
      `each with the same ${esm.keys.length} exports and no peer`,
  );
  return true;
}

const root = mkdtempSync(join(tmpdir(), "uiobs-consumers-"));
let passed = false;

try {
  if (install(root)) {
    const results = [
      ...CONSUMERS.map((consumer) => typeCheck(root, consumer)),
      loadsAtRuntime(root),
    ];
    passed = !results.includes(false);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (!passed) {
  process.exit(1);
}
