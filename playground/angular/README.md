# Angular example

This example shows the library in an Angular 22 app with standalone components. It shows a provider function, an `ErrorHandler` and a router hook.

Read the [playground guide](../README.md) first. It explains the mock ingest server and each line that the terminal prints.

## Run it

Start the mock ingest server in one terminal:

```bash
pnpm run dev:ingest
```

Build the library and start the example in a second terminal:

```bash
pnpm run build
pnpm run example:angular
```

Open `http://localhost:4200`. The first start of `ng serve` can take some seconds.

## What to look for

Open the devtools console.

| Action                         | Look for in the terminal                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **submit** on the ticket route | `[action] ORDER_SUBMIT` with a `journey=` id. The journey starts before the action and ends after it.   |
| **throw inside Angular**       | `ERROR [log] unhandled Angular error`. The console also shows the error, because the handler prints it. |
| The **blotter** link           | `[event] NAVIGATION` with a new `trace=` value. Each navigation starts a new trace.                     |
| **select ORD-2002**            | `[event] ORDER_SELECTED`, with the same trace as the navigation before it.                              |

The devtools console shows the namespace of each record. It is `oms.ticket`, `oms.blotter`, `angular.errors` or `uiobs.capture`.

## What to copy

- `src/observability.ts`. Copy this file into your app. It imports only the public API.
- `src/main.ts`. Pass `provideObservability(config)` to `bootstrapApplication()`.

`provideObservability()` does three things:

1. It calls `configure()` in an environment initializer, before the first component renders.
2. It replaces the Angular `ErrorHandler` with `ObservabilityErrorHandler`.
3. It calls `newTrace()` at each `NavigationStart` of the router.

Keep these rules from the example:

- Keep the `ErrorHandler`. Angular catches an error from a component or a template and does not throw it again. `window.onerror` never fires, and `capture.errors` cannot see the error.
- Do not add `provideBrowserGlobalErrorListeners()`. It sends `window` errors to the same `ErrorHandler`. One uncaught error then arrives two times.
- Inject `ObservabilityService` and call `forNamespace()` to get a logger for each component.
- On Angular 16 to 18, use `ENVIRONMENT_INITIALIZER`. The comment in `src/observability.ts` shows the code.

See [Configuration ownership and logger cache](../../docs/runtime-policies.md#configuration-ownership-and-logger-cache).
