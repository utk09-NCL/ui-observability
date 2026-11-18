# Release and Support Contract

This document states what a release of `@utk09/ui-observability` promises and what a release must show.

Some sections are proposals. Each proposal has the label **Proposal**. The maintainer must approve a proposal before it is a promise.

## Stable API and Configuration

### Public surface

The package has one entry point. `exports` in `package.json` names `.` and `./package.json` only.

The public API is each export of `src/index.ts`. A module that the entry point does not export is internal.

| Area                | Exports                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Setup and lifecycle | `configure`, `setConfigurationLocked`, `rotateSecurityContext`, `newSession`, `shutdown`                                               |
| Logging             | `getLogger`, `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `logAction`, `logEvent`, `addBreadcrumb`                              |
| Metrics and timing  | `counter`, `gauge`, `histogram`, `startMeasure`, `measure`, `profiler`                                                                 |
| Context and journey | `setContext`, `removeContext`, `startJourney`, `endJourney`, `currentJourney`, `getJourneyToken`                                       |
| Journey and trace   | `adoptJourney`, `newTrace`, `getTraceHeaders`                                                                                          |
| Bus                 | `registerFrame`, `registerWorker`                                                                                                      |
| Delivery and health | `flush`, `getHealth`, `collectDebugBundle`, `getDiagnosticCounters`                                                                    |
| Transport           | `serveTransportWorker`, `createMemoryTransport`                                                                                        |
| Session replay      | `startReplay`, `stopReplay`                                                                                                            |
| Types               | Each type that `src/index.ts` exports, for example `ObservabilityConfig`, `Logger`, `LogRecord`, `DiagnosticCode` and `StorageAdapter` |

The configuration contract is the type `ObservabilityConfig`. The README section [Configuration Options](../README.md#configuration-options) gives each key and its default.

These are the top-level keys of `ObservabilityConfig`.

- Destination and identity of the service: `endpoint`, `metricsEndpoint`, `tracesEndpoint`, `serviceName`, `serviceVersion`, `environment`, `enabled`.
- Records: `minLevel`, `minLevels`, `payloadMode`, `sampling`, `limits`, `consoleOutput`, `contextProvider`, `processors`, `redact`.
- Delivery: `transport`, `transportOnExit`, `transportWorker`, `serializer`, `compression`, `credentials`, `headers`, `batching`, `retention`, `storage`, `delivery`, `buffering`.
- Contexts: `bus`, `journey`, `identity`, `correlation`, `securityContext`.
- Capture: `capture`, `captureLimits`, `metadata`, `metrics`, `profiler`, `replay`, `otelLoader`.
- Control and feedback: `lockConfiguration`, `loggerCache`, `debugBuffer`, `diagnostics`, `onDiagnostic`, `onDrop`.

### Experimental features

The code and the documents mark no feature as experimental. This document adds no such mark.

### Needs a maintainer decision

The maintainer must decide the status of each item before the first stable release.

1. Session replay (`replay`, `startReplay`, `stopReplay`). Decide between stable and experimental.
2. The profiler (`profiler` export and `profiler` configuration). Decide between stable and experimental.
3. The transport worker (`transportWorker`, `serveTransportWorker`). Decide between stable and experimental.
4. Remote sampling and the remote capture switches. Decide between stable and experimental.
5. The capture plugin types (`CapturePlugin`, `PluginContext`). Decide between stable and experimental.
6. The `uiobs` command line tool. Decide if its arguments and its output are a part of the contract.
7. The diagnostic codes and the diagnostic message texts. Decide if a change to one is a breaking change.
8. The attribute names in [attributes](attributes.md). Decide if a change to one is a breaking change.
9. The ingest contract in the README section [Ingest Server Requirements](../README.md#ingest-server-requirements). Decide if a change to it is a breaking change.
10. The browser storage keys in the README section [Browser Storage Keys](../README.md#browser-storage-keys). Decide if a change to one is a breaking change.
11. The default value of each configuration key. Decide if a change of a default is a breaking change.

## Supported Environments

[Browser support](browser-support.md) is the source for browsers, browser APIs, fallbacks and contexts. This document does not repeat it.

`engines` in `package.json` sets Node 22.22.3 or later. In Node, the library is console only.

### Validation gaps

- No document gives a supported OpenFin version. No reproducible check on a real OpenFin runtime exists. Treat OpenFin support as not validated.
- [Browser support](browser-support.md) says "current versions" of Chrome, Edge, Firefox and Safari. No document gives a minimum version for a browser.
- The Vitest suite does not run in a real browser. The manual checks below are the only browser evidence.

## Migration and Deprecation Policy

**Proposal. The maintainer has not approved this section.**

Current practice is the base of the proposal. `CHANGELOG.md` holds the released versions and their breaking changes. The [upgrade checklist](runtime-policies.md#upgrade-checklist) holds the migration steps.

1. Use semantic versioning for the public surface in this document.
2. Make a breaking change only in a major release.
3. Mark an export or a configuration key with `@deprecated` in its JSDoc before its removal.
4. Name the replacement in the `@deprecated` text and in the `CHANGELOG.md` lines of that release.
5. Keep a deprecated item for a minimum period. The maintainer must set that period.
6. Write the migration steps for each breaking change in the upgrade checklist.
7. Treat a change of the bus envelope tag as a breaking change, because contexts on the two sides ignore each other.
8. Name each change of a default value in the `CHANGELOG.md` lines of that release.

## Security Reporting

The repository states one reporting route. It is the public issue tracker in `bugs.url` of `package.json`.

<https://github.com/utk09-NCL/ui-observability/issues>

- A public issue shows its content to each reader. It is not a private route.
- The repository has no `SECURITY.md` file and states no private contact.
- The maintainer must set a private reporting route before the first stable release.
- This document states no response time and no support commitment. The maintainer has not set one.

[Threat model](threat-model.md) gives the trust boundaries and the controls.

## Mandatory Release Evidence

A release needs each item of evidence in this section. Record the command and its output for each item.

### Available now

1. Run `pnpm run verify`. It runs the format check, typecheck, build, lint, peer check, size check, dev-server check, consumer check and the tests with coverage.
2. Run `pnpm run test:e2e`. It runs the browser tests in Chromium, Firefox and WebKit. [Browser tests](../e2e/README.md) lists what they cover.
3. Run `pnpm run test:collector`. It sends logs, metrics and spans to a pinned OpenTelemetry Collector and checks the OTLP fields that the collector wrote. [Collector check](../e2e/collector/README.md) gives the pinned version and the limits.
4. Run `pnpm run bench:release`. It compares latency, throughput, heap growth, outage recovery and replay cost with `bench/budgets.json`. [Performance](performance.md) gives the method and the approved budgets.
5. Run `pnpm --filter './playground/**' --if-present run build`. It builds each consumer playground that has a build script.
6. Do the manual browser checks that the README names.
   - Check the vanilla frames, the React example and the Angular example in a browser.
   - Check the worker path and the main-thread path of the vanilla playground in a real browser.
   - Check worker startup, fallback, page exit and rotation in a real browser. [Browser support](browser-support.md) gives this check.

`check:consumers` packs the package and installs it with no optional peer. It type-checks a NodeNext ESM consumer, a NodeNext CommonJS consumer and a Bundler consumer. It then loads the package with `import` and with `require`.

These rules apply to each release.

- Coverage stays at 100 percent for lines, branches, functions and statements. A test run with zero tests is a failure.
- Report the measured gzip size from `check:size` to the maintainer. Do not raise `SIZE_BUDGET_GZIP_BYTES` without approval from the maintainer.
- `prepublishOnly` runs `pnpm run verify` before a publish.
- The maintainer sets the version, makes the tag, publishes and edits `CHANGELOG.md`.

### Validation gaps

These checks are missing or partial. A release cannot show this evidence yet.

- No browser test covers session replay with the real recorder, masking or stop.
- The browser tests do not cover offline recovery, an IndexedDB reload, the exit flush, rotation, or metrics and spans. [Browser tests](../e2e/README.md) lists each gap.
- The collector check runs on macOS arm64 only. It does not send an exit flush.
- The benchmark runs in Chromium only.
- No smoke check runs on a real OpenFin runtime.

Record each gap in the release notes. Do not record it as a pass.

The repository has no CI workflow. A person runs each command on a local machine.

## Version Skew

Version skew is two contexts, or two copies in one context, that run different versions of the library.

### What the code does

**Two copies in one realm.** The first copy owns the page runtime. A copy compares its version with the version of the owner as an exact text.

- A copy with a different version runs console-only. It sends nothing, joins no bus and installs no capture.
- That copy reports `runtime.version_mismatch`.
- `getHealth()` of that copy has `runtime.version_mismatch` in `issues`. Its `owningSdkVersion` is the version of the owner.
- A difference in the patch number is also a different version.

**Two contexts over a message link.** Each bus message goes in an envelope with the tag `ui-observability/2`. The links are `postMessage` to a parent, a child frame or a worker, `BroadcastChannel` and the OpenFin `InterApplicationBus`.

- A context ignores an envelope that has a different tag. It reports no diagnostic for that envelope.
- A forwarder with an owner on a different tag gets no answer to its handshake.
- That forwarder reports `bus.handshake_timeout` and becomes a sender. It then uses its own configuration to send.
- The two contexts share no journey, no sampling rule and no security-context change over the bus.
- The tag changed last in version 0.9.5. A context before 0.9.5 and a context on 0.9.5 or later ignore each other.

**Two contexts with the same tag.** Each context accepts the envelope of the other. The bus then checks the type and the fields of each message.

**A same-origin child frame.** This frame calls the runtime of its parent directly. That call has no envelope. The frame first compares the bus protocol tag of the parent runtime with its own tag.

- With the same tag, the frame uses the direct call. The bus of the parent checks each message as above.
- A parent runtime from 0.9.5 to 0.12 has no tag field. Those versions use the tag `ui-observability/2`. The frame uses the direct call to such a parent.
- With a different tag, the frame does not use the direct call. It reports `bus.protocol_mismatch` and tries the message link to its parent.
- A parent runtime before 0.9.5 has an older tag. Its child frame also reports `bus.protocol_mismatch`.
- The rules of a message link then apply. A message link connects the two contexts only when their envelope tags are the same.
- If the message link does not connect them, the frame becomes a sender. Its own `redact` applies to its records. The `redact` of the parent does not.
- Only the child frame makes this check. A child frame on 0.12 or older makes no check. It calls a newer parent directly.

**The transport worker.** The worker compares its version with the version of the page as an exact text. A worker with a different version refuses the connection. The library then sends on the main HTTP path.

### Coordinated microfrontend upgrade

Do this procedure for each upgrade of the library in an application with more than one context or more than one bundle.

1. List each copy of the library. Include the shell, each remote, each frame, each worker and each OpenFin view.
2. Read `sdkVersion` from `getHealth()` in each context to confirm the list.
3. Read the `CHANGELOG.md` lines between the old version and the new version.
4. Find out if the bus envelope tag changes between the two versions.
5. Set the same new version in each bundle.
6. Build the transport worker script from the same version as its page.
7. Make sure that one realm loads one copy of the library.
8. Deploy each bundle in the same release. A deployment in stages gives version skew for its full duration.
9. If a deployment in stages is necessary, give each frame its own endpoint or transport first. A frame that gets no owner sends its own records.
10. After the deployment, call `getHealth()` in each context. Confirm that `issues` has no `runtime.version_mismatch` and that `owningSdkVersion` is `null`.
11. Call `getDiagnosticCounters()` in each forwarder. Confirm that it has no `bus.handshake_timeout` and no `bus.protocol_mismatch`.
12. Confirm in the ingest server that each context has the new `telemetry.sdk.version`.
13. For a rollback, return each bundle to the old version in the same release.

## Session Replay Adoption

Session replay sends a copy of the DOM to `replay.endpoint`. Ordinary logging sends records that pass through `redact`. The two have different privacy risks.

Do a separate privacy review before you turn on session replay. An approval for ordinary logging does not cover session replay.

The existing documents state the limitations. This document does not change them.

- README, [Session replay](../README.md#session-replay): the configuration, the mask rules and the content that stays in clear text.
- [Threat model, Session Replay](threat-model.md#session-replay): the controls and the limits of the mask.
- [Delivery guarantees, Session replay segments](delivery-guarantees.md#session-replay-segments): the losses of a segment.

The review must include these facts at a minimum.

- Session replay is off by default.
- `redact` and `processors` do not apply to a replay event. A server can never change a privacy setting.
- The mask has limits. An attribute value, a URL in `href` or `src`, and the CSS text stay in clear text.
- The library cannot mask a console argument, a header or a body that a recorder plugin records.
- With `replay.requireConsent: true`, nothing records before `startReplay()`.
- A segment is only in memory. The exit flush sends no segment.
- The replay endpoint receives only `replay.headers`. Isolation does not cover `replay.headers`.
- The app decides what is legal to record.

## Open Items

This document could not verify these items. Each one needs a decision or a check.

1. The supported OpenFin versions. No document and no code gives them.
2. The minimum supported version of each browser.
3. A private route for a security report.
4. The length of the deprecation period, and the approval of the policy proposal.
5. The stable or experimental status of each item in "Needs a maintainer decision".
6. Compatibility between two library versions that share the envelope tag. No document states it.
7. The behavior of a same-origin child frame whose library version differs from its parent. The code has no version check there.
8. The version number and the date of the first stable release.
