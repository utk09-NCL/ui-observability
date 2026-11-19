# Development

This document tells how to work on the library in this repository.

Use Node 22.22.3 or later and pnpm 12.21.0. `.nvmrc` selects the minimum Node version.
The `packageManager` field pins pnpm. See the [pnpm installation instructions](https://pnpm.io/installation).
Angular supports Node `^22.22.3 || ^24.15.0 || >=26.0.0`.
Use one of these Node versions for the complete workspace.

Install from the repository root. The first pnpm install creates `pnpm-lock.yaml`.
Commit that file with dependency changes. Use `pnpm install --frozen-lockfile` for later installs that must keep the resolved versions.

`pnpm-workspace.yaml` holds separate catalogs for `library`, `vanilla`, `react`, `angular`, `console-only`, `mf-host`, `mf-blotter` and `mf-ticket`.
Each manifest uses its named catalog for external dependencies.
The consumer playgrounds use `workspace:*` for the local library. The vanilla playground loads the library source.
Change versions in the relevant catalog, then run `pnpm install`.

Dependency versions use the current stable releases checked on 2026-11-07.
TypeScript uses 6.0.3 because Angular 22 and typescript-eslint require TypeScript below 6.1.
The workspace enables install scripts for `@parcel/watcher`, `esbuild`, `fsevents`, `lmdb` and `msgpackr-extract`.

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
```

- Vanilla playground: `http://localhost:5173/playground/vanilla/index.html`. Add `?worker=1` to send through the transport worker.
- Mock ingest server: `http://localhost:8787`. It accepts `/v1/logs`, `/v1/metrics`, `/v1/traces` and `/v1/replay`. It prints one line for each record, metric point, span and replay segment.
- Cross-origin child frame: `http://localhost:5174`. The vanilla playground registers it and its same-origin child frame before they load.
- The React example sends its counter, histogram and HTTP duration points to `/v1/metrics`.
- After a build, run `node bin/uiobs.mjs doctor http://localhost:8787/v1/logs --origin http://localhost:5173` to test the command line tool on the mock server.

After dependency changes, run these checks:

```bash
pnpm run lint:fix
pnpm run format
pnpm run verify
pnpm --filter './playground/**' --if-present run build
```

`verify` checks the library. The last command builds each consumer playground that has a build script.
Check the vanilla frames, React and Angular in a browser before a release.
To clear the React dependency cache, run `pnpm --filter @example/react run dev --force`.

## Example Applications

The [playground guide](../playground/README.md) tells you how to run each example and what to look for.

Build the package first:

```bash
pnpm run build
pnpm run example:react          # http://localhost:5180
pnpm run example:angular        # http://localhost:4200
pnpm run example:microfrontend  # Shell on http://localhost:5191, remotes on 5192 and 5193
pnpm run example:console-only   # http://localhost:5195
```
