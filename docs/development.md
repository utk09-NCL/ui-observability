# Development

This document tells how to work on the library in this repository.

Use Node 22.22.3 or later and pnpm 12.21.0. `.nvmrc` selects the minimum Node version. `devEngines` in `package.json` stops `pnpm install` on an older Node version. The `packageManager` field pins pnpm. See the [pnpm installation instructions](https://pnpm.io/installation). Angular supports Node `^22.22.3 || ^24.15.0 || >=26.0.0`. Use one of these Node versions for the complete workspace.

Install from the repository root. The first pnpm install creates `pnpm-lock.yaml`. Commit that file with dependency changes. Use `pnpm install --frozen-lockfile` for later installs that must keep the resolved versions.

`pnpm-workspace.yaml` holds separate catalogs for `library`, `vanilla`, `react`, `react-custom-backend`, `angular`, `console-only`, `mf-host`, `mf-blotter` and `mf-ticket`. Each manifest uses its named catalog for external dependencies. The consumer playgrounds use `workspace:*` for the local library. The vanilla playground loads the library source. Change versions in the relevant catalog, then run `pnpm install`.

Dependency versions use the current stable releases checked on 2026-11-07. TypeScript uses 6.0.3 because Angular 22 and typescript-eslint require TypeScript below 6.1. The workspace enables install scripts for `@parcel/watcher`, `esbuild`, `fsevents`, `lmdb` and `msgpackr-extract`.

```bash
pnpm install
pnpm run dev      # Playground, mock ingest server and iframe host
pnpm run verify   # Format check, typecheck, build, lint, peer, size, dev-server and consumer checks, tests
```

These release checks are not part of `verify`. Run them before a release.

```bash
pnpm run test:e2e        # Browser tests in Chromium, Firefox and WebKit. See e2e/README.md.
pnpm run test:collector  # Sends records to a pinned OpenTelemetry Collector. See e2e/collector/README.md.
pnpm run bench:release   # Latency, throughput, heap, outage and replay checks. See docs/performance.md.
pnpm run test:playground # Smoke test of each playground app in Chromium. See e2e/README.md.
```

- Vanilla playground: `http://localhost:5173/playground/vanilla/index.html`. Add `?worker=1` to send through the transport worker.
- Mock ingest server: `http://localhost:8787`. It accepts `/v1/logs`, `/v1/metrics`, `/v1/traces`, `/v1/replay` and `/uilogs`. It prints one line for each record, metric point, span and replay segment.
- Cross-origin child frame: `http://localhost:5174`. The vanilla playground registers it and its same-origin child frame before they load.
- `/uilogs` is the example custom backend of the react-custom-backend example. It takes the JSON of that serializer and answers `400` for a record over its limits.
- Mock app API: `http://localhost:8790`. It serves the business data of the react-custom-backend example. See the [playground guide](../playground/README.md#start-the-mock-app-api).
- The React example sends its counter, histogram and HTTP duration points to `/v1/metrics`.
- After a build, run `node bin/uiobs.mjs doctor http://localhost:8787/v1/logs --origin http://localhost:5173` to test the command line tool on the mock server.

After dependency changes, run these checks:

```bash
pnpm run lint:fix
pnpm run format
pnpm run verify
pnpm --filter './playground/**' --if-present run build
```

`verify` checks the library. The last command builds each consumer playground that has a build script. `pnpm --filter './playground/**' --if-present run test` runs the Vitest specs of the playgrounds. Check the vanilla frames, React and Angular in a browser before a release. To clear the React dependency cache, run `pnpm --filter @example/react run dev --force`.

Prettier prints each Markdown table in the compact form, with one space on each side of a cell. Prettier aligns a table only when it is narrower than `printWidth`, so the Markdown override in `.prettierrc.json` sets `printWidth` to 1. Because of this override, Prettier does not format the code blocks in Markdown files. Format a code block by hand before you commit it.

## Continuous Integration

`.github/workflows/ci.yml` runs on each pull request and on each push to `main`. It has two jobs.

- `verify` runs on the Node version in `.nvmrc` and on Node 24. Each part of `pnpm run verify` is a separate step. After the tests, the job builds each playground and runs the tests of each playground that has a `test` script.
- `e2e` runs `pnpm run test:e2e` in Chromium, Firefox and WebKit on the Node version in `.nvmrc`. It then runs `pnpm run test:playground`, the smoke tests of the playground apps, in Chromium.

A failed check does not stop the later checks, so one run shows each failure. CI caches the pnpm store only. It does not cache `dist/`, lint results or browsers. CI does not run `test:collector` or `bench:release`. The collector check has a binary for macOS on Apple silicon only. Shared runners are too noisy for the benchmark budgets.

## Example Applications

The [playground guide](../playground/README.md) tells you how to run each example and what to look for.

Build the package first:

```bash
pnpm run build
pnpm run example:react          # http://localhost:5180
pnpm run example:react-custom-backend  # http://localhost:5185, with the mock ingest server and the mock app API
pnpm run example:angular        # http://localhost:4200
pnpm run example:microfrontend  # Shell on http://localhost:5191, remotes on 5192 and 5193
pnpm run example:console-only   # http://localhost:5195
```
