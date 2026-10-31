# Attribute Reference

This page lists each attribute that the library writes. Your own attributes come from `setContext()`, `contextProvider`, the logger scope and the call payload. They are not on this page.

The OTLP serializer writes the resource attributes on the resource and the record attributes on the record. The ECS serializer moves some of them to ECS fields. See the `serializer` row in the README.

## Resource Attributes

Each record carries these attributes.

| Attribute                | Type   | Value                                                                                                                      |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `service.name`           | string | `serviceName`. Without it, `unknown-service`.                                                                              |
| `service.version`        | string | `serviceVersion`.                                                                                                          |
| `deployment.environment` | string | `environment`.                                                                                                             |
| `telemetry.sdk.name`     | string | The package name.                                                                                                          |
| `telemetry.sdk.version`  | string | The package version.                                                                                                       |
| `telemetry.sdk.language` | string | `webjs`.                                                                                                                   |
| `host.platform`          | string | `browser`, `openfin`, `openfin_web`, `mobile_webview`, `ionic`, `web_worker`, `shared_worker`, `service_worker` or `node`. |
| `session.id`             | string | Session id. All tabs of an origin share it. It changes after 30 minutes with no record, and at `newSession()`.             |
| `tab.id`                 | string | Tab or window id. It stays across a reload.                                                                                |
| `context.id`             | string | Id of one document, frame or worker. Each load makes a new id.                                                             |
| `browser.user_agent`     | string | `navigator.userAgent`.                                                                                                     |
| `openfin.uuid`           | string | OpenFin application uuid. Only in OpenFin.                                                                                 |
| `openfin.name`           | string | OpenFin window or view name. Only in OpenFin.                                                                              |

Each record also has `traceId`, `spanId` and `traceFlags` as record fields, not as attributes.

## Record Attributes

The library sets these attributes on each record. They replace a caller attribute of the same name.

| Attribute           | Type   | Value                                                                                      |
| ------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `log.type`          | string | `log`, `system`, `action`, `event`, `metric` or `span`.                                    |
| `log.seq`           | number | Sequence number in this context. It starts at 1. Metric points and spans take numbers too. |
| `app.namespace`     | string | Logger namespace.                                                                          |
| `page.url`          | string | Page URL. Without `capture.fullUrls`, it has no query and no fragment.                     |
| `journey.id`        | string | Id of the active journey. Only while a journey runs.                                       |
| `journey.name`      | string | Name of the active journey.                                                                |
| `journey.parent_id` | string | Id of the parent journey. Only with `startJourney(name, { parent: true })`.                |

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

The breadcrumb categories are `log`, `action`, `event`, `click`, `navigation`, `http`, `console`, `frame` and `custom`.

## Metric Records

`logMetric()`, `counter()`, `histogram()` and the captures write metric records. With `metricsEndpoint`, the OTLP metrics serializer reads these fields. They do not become OTLP attributes.

| Attribute                     | Type     | Value                                                             |
| ----------------------------- | -------- | ----------------------------------------------------------------- |
| `metric.name`                 | string   | Metric name.                                                      |
| `metric.unit`                 | string   | Unit.                                                             |
| `metric.type`                 | string   | `gauge`, `counter` or `histogram`.                                |
| `metric.value`                | number   | Value of a `logMetric()` call, or the sum of a counter point.     |
| `metric.start_time_unix_nano` | string   | Start of the interval of a point.                                 |
| `metric.attribute_keys`       | string[] | Keys of the attribute set of a point.                             |
| `metric.count`                | number   | Value count of a histogram point.                                 |
| `metric.sum`                  | number   | Sum of a histogram point.                                         |
| `metric.min`                  | number   | Smallest value of a histogram point.                              |
| `metric.max`                  | number   | Largest value of a histogram point.                               |
| `metric.bounds`               | number[] | Bucket boundaries of a histogram point.                           |
| `metric.bucket_counts`        | number[] | Bucket counts of a histogram point.                               |
| `otel.metric.overflow`        | boolean  | `true` on the point of the attribute sets above the series limit. |

## Span Records

With `tracesEndpoint`, the library writes span records. The OTLP traces serializer reads these fields. They do not become OTLP attributes.

| Attribute                   | Type   | Value                                    |
| --------------------------- | ------ | ---------------------------------------- |
| `span.kind`                 | string | `internal` or `client`.                  |
| `span.parent_id`            | string | Parent span id, or `""` for a root span. |
| `span.start_time_unix_nano` | string | Start time.                              |
| `span.end_time_unix_nano`   | string | End time.                                |
| `span.status`               | string | `error` or `unset`.                      |

## Capture Attributes

| Capture          | Record                                                             | Attributes                                                                                              |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `fetch`, `xhr`   | `GET <url>` (DEBUG), `returned <status>` (WARN), `failed` (ERROR)  | `http.request.method`, `url.full`, `http.response.status_code` (number), `http.duration_ms` (number)    |
| `httpMetrics`    | Histogram `http.client.request.duration`, in seconds               | `http.request.method`, `server.address`, `http.response.status_code` (number), `error.type`             |
| Client span      | Span named by the HTTP method                                      | `http.request.method`, `url.full`, `server.address`, `http.response.status_code` (number), `error.type` |
| `resourceErrors` | `resource failed to load` (WARN)                                   | `error.type` (`resource`), `resource.tag`, `resource.url`                                               |
| `navigation`     | Event `NAVIGATION`                                                 | `page.url.previous`                                                                                     |
| `webVitals`      | Gauges `web_vitals.<name>` and navigation timing gauges            | `metric.rating`, `metric.id`, `navigation.type`                                                         |
| `longFrames`     | Histogram `ui.long_frame.duration`, in ms                          | `frame.type`, `frame.blocking_ms` (number), `frame.script.invoker`, `frame.script.source`               |
| `console`        | The console message (ERROR or WARN)                                | `console.method`, `console.args` (array)                                                                |
| `webSocket`      | Events `websocket.open`, `websocket.close`, WARN `websocket.error` | `url.full`, `server.address`, `websocket.close.code` (number), `websocket.close.clean` (boolean)        |
| `webSocket`      | Counter `ui.websocket.messages`                                    | `network.io.direction` (`transmit` or `receive`), `server.address`                                      |
| Storage gap      | `stored records were dropped before delivery` (WARN)               | `gap.batches` (number), `gap.records` (number), `gap.reason`                                            |
