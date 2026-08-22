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

## License

Apache-2.0. See [LICENSE](LICENSE).
