# Attribute Reference

This page lists each attribute that the library writes. Your own attributes come from `setContext()`, `contextProvider`, the logger scope and the call payload. They are not on this page.

The OTLP serializer writes the resource attributes on the resource and the record attributes on the record. The ECS serializer moves some of them to ECS fields. See the `serializer` row in the README.

In OTLP logs and spans, the instrumentation scope name is the logger namespace, for example `blotter.grid`. The scope has no version. A record without a namespace uses the scope `@utk09/ui-observability`. Metrics use the scope `@utk09/ui-observability` with the SDK version. The record keeps its `app.namespace` attribute.

## Resource Attributes

Each record carries these attributes.

| Attribute                | Type   | Value                                                                                                                                                                                                                         |
| ------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.name`           | string | `serviceName`. Without it, `unknown-service`.                                                                                                                                                                                 |
| `service.version`        | string | `serviceVersion`.                                                                                                                                                                                                             |
| `deployment.environment` | string | `environment`.                                                                                                                                                                                                                |
| `telemetry.sdk.name`     | string | The package name.                                                                                                                                                                                                             |
| `telemetry.sdk.version`  | string | The package version.                                                                                                                                                                                                          |
| `telemetry.sdk.language` | string | `webjs`.                                                                                                                                                                                                                      |
| `host.platform`          | string | `browser`, `openfin`, `openfin_web`, `mobile_webview`, `ionic`, `web_worker`, `shared_worker`, `service_worker` or `node`.                                                                                                    |
| `session.id`             | string | Session id. All tabs of an origin share it. It changes after `correlation.sessionIdleMs` (default 30 minutes) with no record, and at `newSession()`. A same-origin frame takes the new session of its owner after a rotation. |
| `tab.id`                 | string | Tab or window id. It stays across a reload.                                                                                                                                                                                   |
| `context.id`             | string | Id of one document, frame or worker. Each load makes a new id.                                                                                                                                                                |
| `browser.user_agent`     | string | `navigator.userAgent`. Not present with `metadata.userAgent: false`.                                                                                                                                                          |
| `openfin.uuid`           | string | OpenFin application uuid. Only in OpenFin. Not present with `metadata.openfin: false`.                                                                                                                                        |
| `openfin.name`           | string | OpenFin window or view name. Only in OpenFin. Not present with `metadata.openfin: false`.                                                                                                                                     |

Each record also has `traceId`, `spanId` and `traceFlags` as record fields, not as attributes.

## Record Attributes

The library sets these attributes on each record. They replace a caller attribute of the same name.

| Attribute               | Type    | Value                                                                                                                                                                                                                                                       |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log.type`              | string  | `log`, `system`, `action`, `event`, `metric` or `span`.                                                                                                                                                                                                     |
| `log.seq`               | number  | Sequence number in this context. It starts at 1. Metric points and spans take numbers too.                                                                                                                                                                  |
| `app.namespace`         | string  | Logger namespace.                                                                                                                                                                                                                                           |
| `page.url`              | string  | Page URL. Without `capture.fullUrls`, it has no query and no fragment. `capture.urlTransform` replaces this rule. Empty with `metadata.pageUrl: false`.                                                                                                     |
| `journey.id`            | string  | Id of the active journey. Only while a journey runs.                                                                                                                                                                                                        |
| `journey.name`          | string  | Name of the active journey.                                                                                                                                                                                                                                 |
| `journey.parent_id`     | string  | Id of the parent journey. Only with `startJourney(name, { parent: true })`.                                                                                                                                                                                 |
| `uiobs.clock_offset_ms` | number  | Server time minus client time, in milliseconds. It comes from the `Date` header of the last accepted answer. It is correct to about one second. Logs and spans only. With `metadata.clockOffset: false`, or before the first accepted answer, it is absent. |
| `uiobs.debug_buffer`    | boolean | `true` on a record that the debug buffer kept until an error. `minLevel` or sampling dropped it first.                                                                                                                                                      |

These attributes show a problem in the record:

| Attribute                  | Type    | Value                                                                |
| -------------------------- | ------- | -------------------------------------------------------------------- |
| `uiobs.attributes_dropped` | boolean | `true` when the attributes were larger than `limits.maxRecordBytes`. |
| `uiobs.attributes_bytes`   | number  | Size of the dropped attributes.                                      |
| `uiobs.sanitize_failed`    | boolean | `true` when the library could not sanitize the attributes.           |

## Error Records

`error()`, `fatal()` and the error captures add these attributes.

| Attribute                | Type   | Value                                                                                  |
| ------------------------ | ------ | -------------------------------------------------------------------------------------- |
| `error.type`             | string | Error name, for example `TypeError`. `resource` and `unhandledrejection` from capture. |
| `error.message`          | string | Error message.                                                                         |
| `error.stack_trace`      | string | Stack trace.                                                                           |
| `error.data`             | object | Own string, number and boolean fields of the error, or a reason that is not an Error.  |
| `error.source`           | string | Script URL of an uncaught error.                                                       |
| `error.line`             | number | Line of an uncaught error.                                                             |
| `error.column`           | number | Column of an uncaught error.                                                           |
| `error.captured_by`      | string | Source of a captured error, for example `window.onerror` or `console.error`.           |
| `error.suppressed_count` | number | Number of repeats of the same error that the capture dropped before this record.       |
| `breadcrumbs`            | array  | Last events before the error. Each item has `t`, `category`, `message` and `data`.     |

The breadcrumb categories are `log`, `action`, `event`, `click`, `navigation`, `http`, `console`, `frame`, `profile` and `custom`.

A `click` breadcrumb has the action name as its message. The name comes from the closest `data-observability-action` attribute, or from the attribute in `capture.interactions.actionAttribute`. Without a name, the message is `unknown-click`. `data.text` and `data.selector` are present only when `capture.interactions` turns them on.

## Metric Records

`counter()`, `gauge()`, `histogram()`, `startMeasure()`, `measure()`, the profiler and the captures write metric records. With `metricsEndpoint`, the OTLP metrics serializer reads these fields. They do not become OTLP attributes.

| Attribute                     | Type     | Value                                                                                                  |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `metric.name`                 | string   | Metric name.                                                                                           |
| `metric.unit`                 | string   | Unit.                                                                                                  |
| `metric.type`                 | string   | `gauge`, `counter` or `histogram`.                                                                     |
| `metric.value`                | number   | Sum of a counter point, last value of a gauge point, or the value of a capture's single metric record. |
| `metric.start_time_unix_nano` | string   | Start of the interval of a point.                                                                      |
| `metric.attribute_keys`       | string[] | Keys of the attribute set of a point.                                                                  |
| `metric.count`                | number   | Value count of a histogram point.                                                                      |
| `metric.sum`                  | number   | Sum of a histogram point.                                                                              |
| `metric.min`                  | number   | Smallest value of a histogram point.                                                                   |
| `metric.max`                  | number   | Largest value of a histogram point.                                                                    |
| `metric.bounds`               | number[] | Bucket boundaries of a histogram point.                                                                |
| `metric.bucket_counts`        | number[] | Bucket counts of a histogram point.                                                                    |
| `otel.metric.overflow`        | boolean  | `true` on the point of the attribute sets above the series limit.                                      |

## Measure Attributes

`startMeasure()` writes two histograms in milliseconds. The app attributes are also on each point. With `tracesEndpoint`, the measure span has the name of the measure and `measure.outcome`. Each child span has the name of the phase and `measure.name`.

| Histogram                   | Attributes                         |
| --------------------------- | ---------------------------------- |
| `ui.measure.duration`       | `measure.name`, `measure.outcome`. |
| `ui.measure.phase.duration` | `measure.name`, `measure.phase`.   |

## Replay Attribute

| Attribute   | Type   | Value                                                                                                                                          |
| ----------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `replay.id` | string | Id of the session replay recording. Each record has it while the recorder runs. Each segment of the recording has the same id. See the README. |

## Profile Attributes

`profiler.probe()` writes one histogram in milliseconds. Each record is the summary of one probe for one interval. The record has the histogram fields of [Metric Records](#metric-records). With `metricsEndpoint`, only `profile.probe` and `profile.sample_every` are attributes of the OTLP point.

| Histogram                   | Attributes                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui.profile.duration`       | `profile.probe`, `profile.sample_every`, `profile.p50`, `profile.p90`, `profile.p99`, `profile.self_p99`, `profile.overhead_ns`.                          |
| `ui.profile.frame.duration` | `profile.probe`, `profile.frame_phase`. Only with `profiler.framePhases`. One value for each phase of each long animation frame with a span of the probe. |

| Attribute              | Type   | Value                                                                                                                                                                                       |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile.probe`        | string | Probe name. It is an OTLP point attribute.                                                                                                                                                  |
| `profile.sample_every` | number | Sampling period of the probe. The probe measures one span of each period. It is an OTLP point attribute.                                                                                    |
| `profile.p50`          | number | 50th percentile of the interval, in milliseconds. It is the upper bound of its bucket, limited to the range from `metric.min` to `metric.max`.                                              |
| `profile.p90`          | number | 90th percentile of the interval, in milliseconds. It has the same rule as `profile.p50`.                                                                                                    |
| `profile.p99`          | number | 99th percentile of the interval, in milliseconds. It has the same rule as `profile.p50`.                                                                                                    |
| `profile.self_p99`     | number | 99th percentile of the self time, in milliseconds. The self time of a span is its duration without the measured spans inside it. It is absent when no span of the interval has a self time. |
| `profile.frame_phase`  | string | Phase of a long animation frame. It is `script`, `render`, `style_layout` or `forced_layout`. `forced_layout` is a part of `script`.                                                        |
| `profile.overhead_ns`  | number | Cost of one `begin()` and `end()` pair, in whole nanoseconds. It is the cost of a pair in one short loop. It is absent before the one measurement, and when the clock is too coarse.        |

## Span Records

With `tracesEndpoint`, the library writes span records. The OTLP traces serializer reads these fields. They do not become OTLP attributes.

| Attribute                   | Type   | Value                                                                        |
| --------------------------- | ------ | ---------------------------------------------------------------------------- |
| `span.kind`                 | string | `internal` or `client`.                                                      |
| `span.parent_id`            | string | Parent span id, or `""` for a root span.                                     |
| `span.start_time_unix_nano` | string | Start time.                                                                  |
| `span.end_time_unix_nano`   | string | End time.                                                                    |
| `span.link.trace_id`        | string | Server trace id from a valid Server-Timing traceparent entry.                |
| `span.link.span_id`         | string | Server span id. The serializer writes an OTLP link when both link ids exist. |
| `span.status`               | string | `error` or `unset`.                                                          |

## Diagnostic Records

With `diagnostics.records`, the library writes a record for each reported diagnostic. The namespace is `uiobs.diagnostics`. The body is the message of the diagnostic.

| Attribute           | Type   | Value                                                                                                 |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `diagnostic.code`   | string | Diagnostic code, for example `transport.timeout`.                                                     |
| `diagnostic.count`  | number | Number of reports of this code since startup.                                                         |
| `diagnostic.detail` | object | Detail of the diagnostic, if the code has detail. `url` and `endpoint` have no query and no fragment. |

## Capture Attributes

| Capture          | Record                                                             | Attributes                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`, `xhr`   | `GET <url>` (DEBUG), `returned <status>` (WARN), `failed` (ERROR)  | `http.request.method`, `url.full`, `http.response.status_code` (number), `http.duration_ms` (number)                                         |
| `httpMetrics`    | Histogram `http.client.request.duration`, in seconds               | `http.request.method`, `server.address`, `http.response.status_code` (number), `error.type`                                                  |
| Client span      | Span named by the HTTP method                                      | `http.request.method`, `url.full`, `server.address`, `http.response.status_code` (number), `error.type`                                      |
| `resourceErrors` | `resource failed to load` (WARN)                                   | `error.type` (`resource`), `resource.tag`, `resource.url`                                                                                    |
| `navigation`     | Event `NAVIGATION`                                                 | `page.url.previous`                                                                                                                          |
| `interactions`   | Events `ui.rage_click` and `ui.dead_click`                         | `click.action`, `click.count` (number, rage click only)                                                                                      |
| `uncleanExit`    | `ui.unclean_exit` (WARN)                                           | `exit.session_id`, `exit.last_seen_ms` (number), `exit.visibility`, `exit.discarded` (boolean)                                               |
| `serverTiming`   | Additional fields on fetch and XHR records                         | `server.timing`, a list of `name`, `duration` and `description`. A valid traceparent adds an OTLP span link.                                 |
| `reports`        | WARN `ui.report`                                                   | `report.type`, `report.url`, optional `report.id`, `report.source`, `report.line`, `report.column`, `report.directive`, `report.blocked_url` |
| `resourceTiming` | Histogram `ui.resource.duration`, in ms. Event `ui.resource.slow`  | `resource.initiator_type`, `server.address`. Slow events also have `resource.duration_ms` and `url.full`.                                    |
| `lifecycle`      | Event `ui.lifecycle`                                               | `lifecycle.state`, `lifecycle.previous_state`, `lifecycle.duration_ms`                                                                       |
| `userTiming`     | Histogram `ui.user_timing.duration`, in ms                         | `user_timing.name`. It follows `fullUrls`.                                                                                                   |
| `webVitals`      | Gauges `web_vitals.<name>` and navigation timing gauges            | `metric.rating`, `metric.id`, `navigation.type` `navigation.type` is `prerender` for a page that the browser prerendered.                    |
| `longFrames`     | Histogram `ui.long_frame.duration`, in ms                          | `frame.type`, `frame.blocking_ms` (number), `frame.script.invoker`, `frame.script.source`                                                    |
| `console`        | The console message (ERROR or WARN)                                | `console.method`, `console.args` (array)                                                                                                     |
| `webSocket`      | Events `websocket.open`, `websocket.close`, WARN `websocket.error` | `url.full`, `server.address`, `websocket.close.code` (number), `websocket.close.clean` (boolean)                                             |
| `webSocket`      | Counter `ui.websocket.messages`                                    | `network.io.direction` (`transmit` or `receive`), `server.address`                                                                           |
| Storage gap      | `stored records were dropped before delivery` (WARN)               | `gap.batches` (number), `gap.records` (number), `gap.reason`                                                                                 |
