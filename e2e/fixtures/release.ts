// e2e/fixtures/release.ts
//
// Builds an older release of the library for the cross-version specs, and names the page that
// loads it. The build step caches its output, so only the first run of a checkout pays for it.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The release that the cross-version specs load next to the current source. */
export const RELEASE_TAG = "v1.0.0";

/** The version string that the release's build baked in. */
export const RELEASE_VERSION = "1.0.0";

/** Path of the page that loads the release bundle. It reads the tag from `?release=`. */
export const RELEASE_PAGE_PATH = "/e2e/fixtures/release-page.html";

/** The page's address for a tag, with extra query parameters that the page ignores. */
export function releasePage(tag: string, query = ""): string {
  return `${RELEASE_PAGE_PATH}?release=${tag}${query === "" ? "" : `&${query}`}`;
}

/**
 * Builds the release bundle from its git tag, unless the cache already has it. A first build
 * needs the tag in git, and it fetches the tag from origin when a shallow clone lacks it.
 * @param tag A release tag such as `v1.0.0`.
 */
export async function buildRelease(tag: string): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));

  await run("node", ["tools/build-release-bundle.mjs", tag], { cwd: root });
}
