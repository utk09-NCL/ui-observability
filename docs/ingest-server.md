# Ingest Server Requirements

This document is the ingest contract. `tools/mock-ingest-server.mjs`, `tools/reference-collector.mjs` and the `uiobs doctor` tool implement it.

The ingest server must meet these requirements:

1. **Protocol:** Accept `POST` with `Content-Type: application/json` (OTLP), `application/x-ndjson` (ECS, with `serializer: "ecs"`) or `text/plain;charset=UTF-8`. Without `headers`, the exit flush sends a `text/plain` batch to an endpoint on another origin. That content type needs no CORS preflight.
   - With `credentials: "omit"` or `"same-origin"`, that batch is a keepalive `fetch` with no custom header. It obeys `credentials`. Thus it sends no cookie to another origin.
   - With `credentials: "include"`, that batch is a beacon. `sendBeacon` always sends the cookies. Thus the library uses it only when the app asks for cookies.
   - The batch id and the exit reason are in the query parameters `uiobs_batch_id` and `uiobs_exit`.
   - The answer to the keepalive `fetch` must permit the origin. If it does not, a page that is still open sends the batch again at the next page load.
   - It is possible that a keepalive `fetch` is less reliable than a beacon at page exit in some browsers. This is a hypothesis. `e2e/exit-flush.e2e.ts` shows that the `fetch` arrives after a navigation in Chromium, Firefox and WebKit.
   - An endpoint on the origin of the page gets the exit batch with the content type of the serializer. For OTLP, that is `application/json`. A same-origin request needs no CORS preflight. A sandboxed frame, a `srcdoc` frame and an `about:blank` frame still send the `text/plain` batch.
   - A stock OpenTelemetry Collector accepts only `application/json` or protobuf. On another origin, it refuses the `text/plain` exit batch with `415`. The library loses that batch.
   - To prevent this loss, set `headers` or put a same-origin proxy in front of the collector.
   - With `headers`, the exit flush sends a keepalive `fetch` with the content type of the serializer, `application/json` for OTLP. To another origin, that request needs a CORS preflight.
   - It is possible that a browser cancels that request during page exit. No test in this repository checks this risk.
2. **Preflight:** Answer `OPTIONS` on the ingest path, and allow the request headers:

   ```http
   Access-Control-Allow-Headers: content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt
   ```

   - The transport sends `X-UiObs-Batch-Id` and `X-UiObs-Attempt` with each batch.
   - Above 1 KiB, it also sends `Content-Encoding: gzip`.
   - Each of these headers causes a CORS preflight. If the server does not allow them, each preflight fails.
   - After a failed preflight, the library tries the batch 5 more times. It then drops the batch.
   - Only the `text/plain` batches of the exit flush arrive, because they have no custom header.

3. **Deduplication:** Deduplicate on the `X-UiObs-Batch-Id` header and the `uiobs_batch_id` query parameter. Keep the ids for at least 24 hours.
4. **Throttling:** Return `429` or `503` with `Retry-After`. Expose the header with `Access-Control-Expose-Headers: retry-after`. The library waits 60 s at most.
5. **Status codes:** `200`, `202` and `204` accept the batch. `413` makes the library split the batch. A `413` body can give the limit as JSON, for example `{"maxBytes": 65536}`. The library reads at most 16 KiB of a response body. `delivery.requestTimeoutMs` also limits that read. An OTLP `2xx` answer can have `partialSuccess` in a JSON body. The library gives the rejected count to `onDrop` with the reason `partially_rejected`. It does not send the batch again. `408` and each `5xx` make the library send the batch again later. With a `headers` function, a `401` or `403` gets one more send with new headers. The library drops a batch that gets any other `4xx`.
6. **Metrics and traces endpoints (optional):** With `metricsEndpoint`, the library sends each batch of metric records there as an OTLP/JSON `ExportMetricsServiceRequest`. With `tracesEndpoint`, it sends each batch of span records there as an OTLP/JSON `ExportTraceServiceRequest`. The rules 1 to 5 also apply to these endpoints. A throttle or a failed batch of one endpoint does not hold back the batches of another endpoint. `headers` applies to each endpoint. Each point is a delta from the previous point of its attribute set. A histogram point with a negative value has no `sum`.
7. **Remote sampling (optional):** To send sampling rules, add `X-UiObs-Sampling` to a `2xx` answer. Expose the header with `Access-Control-Expose-Headers: x-uiobs-sampling`.
8. **Clock offset (optional):** Expose the `Date` header with `Access-Control-Expose-Headers: date`. Each later log and span record then carries `uiobs.clock_offset_ms`.

**Replay endpoint (only with `replay.endpoint`).** It is a separate URL. It gets one `POST` for each segment of the session replay.

- The body is JSON, with `Content-Encoding: gzip` when `compression` is `gzip`. It has `replay.id`, `session.id`, `tab.id`, `service.name`, `sequence`, `bytes` and `events`. `events` is the list of recorder events.
- The request has `X-UiObs-Batch-Id` with the value `<replay.id>-<sequence>`, `X-UiObs-Attempt` and the headers of your `replay.headers` option. Allow them in the preflight, as for the log endpoint. Store a segment one time for each batch id.
- Answer `2xx` for a stored segment. The library sends a segment again after `429`, `5xx`, `401` and `403`. It drops a segment after another `4xx` status.
- Accept a large body. The first segment of an upload has a full snapshot of the page. One snapshot of a page with 35,000 table cells was 4.7 MB of JSON. The library does not split one event.
- Keep the segments of one `replay.id` in the order of `sequence`. A player needs the segment with the full snapshot before the later segments.
- `tools/mock-ingest-server.mjs` and `tools/reference-collector.mjs` accept `/v1/replay` and print one line for each segment. The reference collector accepts a replay body of at most `MAX_REPLAY_BODY_BYTES` (16 MB by default). `uiobs doctor` tests the replay endpoint with the option `--replay`. See [Check an ingest server](#check-an-ingest-server).

`tools/reference-collector.mjs` implements each rule with no dependencies. It is not part of the package. Run `node tools/reference-collector.mjs`. Set `ALLOWED_ORIGINS` to the origins of your app. Set `UPSTREAM_URL` to an OTLP/HTTP collector, for example `http://localhost:4318`, to forward each OTLP batch there. The file lists the other settings: `PORT`, `AUTH_TOKEN`, `SAMPLING_RULES`, `MAX_BODY_BYTES` and `MAX_REQUESTS_PER_SECOND`.

## Check an ingest server

Run the command line tool against your ingest URL. Give the origin of your app.

```bash
pnpm dlx @utk09/ui-observability doctor https://ingest.example/v1/logs --origin https://app.example
```

The tool prints `PASS` or `FAIL` for each rule. The exit code is 0 when each rule passes, 1 when a rule fails and 2 for a wrong command.

| Rule              | Check                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `preflight`       | `OPTIONS` answers with a `2xx` status and permits the origin.                                    |
| `allowed headers` | The preflight allows each request header of the library.                                         |
| `test batch`      | A `POST` of an OTLP batch gets a `2xx` status and permits the origin.                            |
| `exposed headers` | The batch answer exposes `Retry-After`. The output names optional headers that stay hidden.      |
| `gzip`            | A `POST` with `Content-Encoding: gzip` gets a `2xx` status.                                      |
| `deduplication`   | A second `POST` with the same `X-UiObs-Batch-Id` gets a `2xx` status.                            |
| `beacon`          | A `POST` with `text/plain;charset=UTF-8`, the exit batch to another origin, gets a `2xx` status. |

- The tool sends real test batches. Each record has `service.name: "uiobs-doctor"`. Expect four test batches in the store of the server.
- The `beacon` batch has its batch id in `uiobs_batch_id` and the reason `pagehide` in `uiobs_exit`, as in the exit flush of the library.
- The exit flush sends that batch as a keepalive `fetch`, or as a beacon with `credentials: "include"`. The rule applies to the two.
- A stock OpenTelemetry Collector answers `415` to the `beacon` batch. The `FAIL` line then names the two corrections of requirement 1.
- The exit flush sends no `text/plain` batch to an endpoint on the origin of the page. For such an endpoint, a failed `beacon` rule causes no loss. A sandboxed frame, a `srcdoc` frame and an `about:blank` frame are exceptions, because they send the `text/plain` batch.
- The tool sends no credentials by default. Add a request header with `--header "Name: value"`. You can give the option more than one time.

  ```bash
  pnpm dlx @utk09/ui-observability doctor https://ingest.example/v1/logs --origin https://app.example --header "Authorization: Bearer $TOKEN"
  ```

- The tool sends each custom header with each batch. The preflight names the header, and `allowed headers` tests that the server allows it.
- With a custom header, the tool sends no `beacon` batch. The exit flush of the library then uses a keepalive fetch with the content type of the serializer.

To test a replay endpoint, give the value of `replay.endpoint` and add `--replay` directly after the origin. Give each header of your `replay.headers` option with `--header`.

```bash
pnpm dlx @utk09/ui-observability doctor https://ingest.example/v1/replay --origin https://app.example --replay
```

| Rule              | Check                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| `preflight`       | `OPTIONS` answers with a `2xx` status and permits the origin.            |
| `allowed headers` | The preflight allows each request header of the library.                 |
| `test segment`    | A `POST` of a small segment gets a `2xx` status and permits the origin.  |
| `gzip`            | A `POST` of a segment with `Content-Encoding: gzip` gets a `2xx` status. |
| `large segment`   | A `POST` of a segment of 5 MB without gzip gets a `2xx` status.          |
| `deduplication`   | A second `POST` with the same `X-UiObs-Batch-Id` gets a `2xx` status.    |

- The tool sends four real test segments with one `replay.id`. Each segment has `service.name: "uiobs-doctor"` and one custom event of the recorder. One segment has 5 MB.
- The `large segment` rule finds a body limit that is too low. The library drops a segment after a `413` status, and the first segment of an upload has a full snapshot of the page.
- The tool sends no beacon to a replay endpoint, because the exit flush sends no segment.
- The tool prints no header value. A header value stays in the history of your shell. Use an environment variable for a token.
- A custom header cannot have the name of a header that the tool sets, for example `Content-Type` or `Origin`.
- A client cannot see the store of the server. `deduplication` proves only that the server accepts a repeated id.
- The tool follows no redirect. A `3xx` answer is a failure, because a browser refuses a preflight that redirects.
- An origin has no path and no trailing slash. A wrong command prints the usage and the arguments that the tool received.
- The tool needs Node 22.22.3 or later.
