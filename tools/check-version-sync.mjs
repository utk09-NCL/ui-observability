// tools/check-version-sync.mjs
//
// Fails when TELEMETRY_SDK_VERSION does not match the package version. The constant
// ships in every batch as scope.version and the telemetry.sdk.version resource
// attribute, so a stale one makes every record misreport what produced it.

import { readFileSync } from "node:fs";

const PATTERN = /export const TELEMETRY_SDK_VERSION = "([^"]+)";/;

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../src/constants.ts", import.meta.url), "utf8");
const found = PATTERN.exec(source);

if (found === null) {
  console.error("version-sync: no TELEMETRY_SDK_VERSION declaration in src/constants.ts");
  process.exit(1);
}

if (found[1] !== pkg.version) {
  console.error(
    `version-sync: TELEMETRY_SDK_VERSION is "${found[1]}", package.json is "${pkg.version}"`,
  );
  console.error("version-sync: set the constant to the package version before releasing");
  process.exit(1);
}

console.log(`version-sync: ${pkg.version}`);
