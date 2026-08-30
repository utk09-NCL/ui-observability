# ui-observability

Framework-agnostic UI observability and logging for browsers, embedded webviews and OpenFin desktop containers. One entry point, no framework dependencies, and a logger that never throws into its caller.

> **Status: early development.** The library is being built module by module and the public API is not published yet. Nothing here is stable.

## Develop

```bash
npm install
npm run dev      # playground, mock ingest server, and a second origin
npm run verify   # typecheck, lint, build, tests with coverage
```

The playground is at `http://localhost:5173/playground/vanilla/index.html`. Records arrive in the terminal running the mock ingest server. Port 5174 must be free.

## Consumer examples

Each example imports the built package by name, so run `npm run build` first, and `npm run dev` alongside for the ingest server on port 8787.

```bash
npm run example:react          # http://localhost:5180
npm run example:angular        # http://localhost:4200
npm run example:microfrontend  # http://localhost:5191, plus two remotes on 5192 and 5193
```

The microfrontend shell composes two remotes over module federation. Each remote also serves itself standalone on its own port, on a runtime of its own.

## License

Apache-2.0. See [LICENSE](LICENSE).
