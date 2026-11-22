// tools/build-release-bundle.mjs
//
// Builds an older release of the library from its git tag into e2e/.cache/<tag>/dist, so a
// browser test can load that release next to the current source. The npm registry is never used.
// The tag's own vite.config.ts builds the bundle, with the Vite of this checkout, so the output
// is what the release's build step made. Git ignores e2e/.cache, and a run with a current stamp
// builds nothing.
//
// Run: node tools/build-release-bundle.mjs v1.0.0

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";

const run = promisify(execFile);

const REPO = fileURLToPath(new URL("../", import.meta.url));
const CACHE_DIR = path.join(REPO, "e2e", ".cache");

// The tag's sources go here for the build. The folder is inside the repository, so the tag's
// vite.config.ts finds this checkout's vite. It is inside node_modules, so the page servers
// don't watch it. They reload every page when a tsconfig.json appears in a watched folder.
const STAGING_DIR = path.join(REPO, "node_modules", ".cache", "uiobs-release");

/** The files of the tag that the build reads. The tests and the docs of the tag stay in git. */
const SOURCE_PATHS = ["src", "package.json", "tsconfig.json", "vite.config.ts"];

/** Name of the file that holds the commit of the last good build. */
const STAMP_FILE = ".commit";

/** A release tag has this shape. The check also keeps an option out of the git calls. */
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

/**
 * Runs git in the repository and returns its trimmed output.
 * @param {string[]} args The git arguments.
 * @returns {Promise<string>} The standard output.
 */
async function git(args) {
  const { stdout } = await run("git", args, { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });

  return String(stdout).trim();
}

/**
 * Returns the commit of a tag. A shallow clone, as in CI, has no tags, so a missing tag is
 * fetched from origin with no history.
 * @param {string} tag The release tag.
 * @returns {Promise<string>} The commit hash.
 */
async function resolveTag(tag) {
  const find = () => git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);

  try {
    return await find();
  } catch {
    // A missing tag is the expected answer here. The fetch below is the fallback.
  }

  await git(["fetch", "--depth=1", "origin", "tag", tag]);

  return find();
}

/**
 * Writes the build files of a commit into a folder, with git archive and tar.
 * @param {string} commit The commit hash.
 * @param {string} folder The empty target folder.
 */
async function extract(commit, folder) {
  const { stdout } = await run("git", ["archive", "--format=tar", commit, ...SOURCE_PATHS], {
    cwd: REPO,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });

  await new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-x", "-C", folder], { stdio: ["pipe", "inherit", "inherit"] });
    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`tar exited with code ${String(code)}`));
      }
    });
    tar.stdin.end(stdout);
  });
}

/**
 * Tells whether the folder holds a finished build of the commit.
 * @param {string} folder The cache folder of the tag.
 * @param {string} commit The commit hash.
 * @returns {Promise<boolean>} True when the stamp matches and the bundle exists.
 */
async function isCurrent(folder, commit) {
  try {
    const stamp = await readFile(path.join(folder, STAMP_FILE), "utf8");
    await stat(path.join(folder, "dist", "index.js"));

    return stamp.trim() === commit;
  } catch {
    // No stamp or no bundle means that the folder needs a build.
    return false;
  }
}

/**
 * Builds a release tag into e2e/.cache/<tag>/dist, unless that folder is current.
 * @param {string} tag The release tag, for example v1.0.0.
 * @returns {Promise<string>} The folder that holds the build.
 */
export async function buildReleaseBundle(tag) {
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(`The release tag ${tag} is not of the form v1.2.3.`);
  }

  const commit = await resolveTag(tag);
  const folder = path.join(CACHE_DIR, tag);
  if (await isCurrent(folder, commit)) {
    return folder;
  }

  // A build that stops half way must not look finished, so the stamp goes first.
  await rm(path.join(folder, STAMP_FILE), { force: true });
  const staging = path.join(STAGING_DIR, tag);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await extract(commit, staging);

  await build({
    root: staging,
    configFile: path.join(staging, "vite.config.ts"),
    logLevel: "warn",
    build: { outDir: path.join(folder, "dist"), emptyOutDir: true },
  });
  await rm(staging, { recursive: true, force: true });

  await writeFile(path.join(folder, STAMP_FILE), `${commit}\n`);

  return folder;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag] = process.argv.slice(2);
  const folder = await buildReleaseBundle(tag ?? "");
  console.log(`release ${tag} is in ${path.relative(REPO, folder)}`);
}
