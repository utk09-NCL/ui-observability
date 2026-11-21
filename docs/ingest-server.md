# Ingest Server Requirements

This document is the ingest contract. `tools/mock-ingest-server.mjs` and `tools/reference-collector.mjs` implement it. The `uiobs doctor` tool checks a server against it.

The ingest server must meet these requirements:

1. **Protocol:** Accept `POST` with `Content-Type: application/json` (OTLP), `application/x-ndjson` (ECS, with `serializer: "ecs"`) or `text/plain;charset=UTF-8`. Without `headers`, the exit flush sends a `text/plain` batch to an endpoint on another origin. That content type needs no CORS preflight.
   - With `credentials: "omit"` or `"same-origin"`, that batch is a keepalive `fetch` with no custom header. It obeys `credentials`. Thus it sends no cookie to another origin.
   - With `credentials: "include"`, that batch is a beacon. `sendBeacon` always sends the cookies. Thus the library uses it only when the app asks for cookies.
   - The batch id and the exit reason are in the query parameters `uiobs_batch_id` and `uiobs_exit`.
   - The body of a `text/plain` batch has the format of the serializer. It is OTLP JSON, or ECS NDJSON with `serializer: "ecs"`. Read the body to tell them apart.
   - An OTLP body has `resourceLogs`, `resourceMetrics` or `resourceSpans`. An ECS body has none of them. A body with one ECS record is also one valid JSON object. Do not decide on valid JSON alone.
   - Parse an NDJSON body line by line. Answer `400` when a line is not JSON.
   - Answer `400` for a `text/plain` body that is not OTLP and has no ECS document, for example `{}`, `null` or an empty body. An ECS document is a JSON object with the field `@timestamp`.
   - Answer `400` for `application/x-ndjson` on a replay endpoint. A replay segment has no ECS form.
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
   - After a failed preflight, the library sends the batch 4 more times with the default `retention.maxAttempts`. It then drops the batch.
   - Only the `text/plain` batches of the exit flush arrive, because they have no custom header.

3. **Deduplication:** Deduplicate on the `X-UiObs-Batch-Id` header and the `uiobs_batch_id` query parameter. Keep the ids for at least 24 hours. With a longer `retention.maxAgeMs`, keep them for that time. A limit on the number of ids can break this rule. The server then stores a repeated batch two times. A request with no batch id has nothing to deduplicate on.
4. **Throttling:** Return `429` or `503` with `Retry-After`. Expose the header with `Access-Control-Expose-Headers: retry-after`. The library waits 60 s at most.
5. **Status codes:** Each `2xx` status accepts the batch, for example `200`, `202` or `204`. `413` makes the library split the batch. A `413` body can give the limit as JSON, for example `{"maxBytes": 65536}`. The library puts that limit in the `transport.batch_split` diagnostic. It always splits the batch into two halves. The halves need storage. With `storage.backend: "none"`, a `413` loses the batch. The exit flush does not read its answer, so a `413` to an exit request also loses the batch. The library reads at most 16 KiB of a response body. `delivery.requestTimeoutMs` also limits that read. An OTLP `2xx` answer can have `partialSuccess` in a JSON body. The library gives the rejected count to `onDrop` with the reason `partially_rejected`. It does not send the batch again. `408` and each `5xx` make the library send the batch again later. With a `headers` function, a `401` or `403` gets one more send with new headers. The library drops a batch that gets any other `4xx`.
6. **Metrics and traces endpoints (optional):** With `metricsEndpoint`, the library sends each batch of metric records there as an OTLP/JSON `ExportMetricsServiceRequest`. With `tracesEndpoint`, it sends each batch of span records there as an OTLP/JSON `ExportTraceServiceRequest`. The rules 1 to 5 also apply to these endpoints. These batches are OTLP with each `serializer`. This includes a `text/plain` exit batch. A throttle or a failed batch of one endpoint does not hold back the batches of another endpoint. `headers` applies to each endpoint. Each counter and histogram point is a delta from the previous point of its attribute set. A gauge point has no temporality. A histogram point with a negative value has no `sum`.
7. **Remote sampling (optional):** To send sampling rules, add `X-UiObs-Sampling` to a `2xx` answer. Expose the header with `Access-Control-Expose-Headers: x-uiobs-sampling`.
8. **Clock offset (optional):** Expose the `Date` header with `Access-Control-Expose-Headers: date`. Each later log and span record then carries `uiobs.clock_offset_ms`.

**Replay endpoint (only with `replay.endpoint`).** It is a separate URL. It gets one `POST` for each segment of the session replay.

- The body is JSON. It has `Content-Encoding: gzip` when `compression` is `gzip` and the body has 1 KiB or more. It has `replay.id`, `session.id`, `tab.id`, `service.name`, `sequence`, `bytes` and `events`. `events` is the list of recorder events.
- The request has `X-UiObs-Batch-Id` with the value `<replay.id>-<sequence>`, `X-UiObs-Attempt` and the headers of your `replay.headers` option. Allow them in the preflight, as for the log endpoint. Store a segment one time for each batch id.
- Answer `2xx` for a stored segment. The library sends a segment again after `429`, `5xx`, `401`, `403` and a network error, up to `replay.maxAttempts`. It drops a segment after another `4xx` status.
- Accept a large body. The first segment of an upload has a full snapshot of the page. One snapshot of a page with 35,000 table cells was 4.7 MB of JSON. The library does not split one event.
- Keep the segments of one `replay.id` in the order of `sequence`. A player needs the segment with the full snapshot before the later segments.
- `tools/mock-ingest-server.mjs` and `tools/reference-collector.mjs` accept `/v1/replay` and print one line for each segment. The mock server also keeps the segments of each recording in a bounded memory store, and it lists them for the replay player of the React example. `GET /v1/replay/recordings` lists the recordings, and `GET /v1/replay/recordings/<id>` gives one recording with its segments in order. The store keeps at most 20 recordings, 100 segments for each recording and 64 MiB in total. It counts bytes of the body. A segment that would take one recording past 64 MiB gets `400` and a reason. The reference collector accepts a replay body of at most `MAX_REPLAY_BODY_BYTES` (16 MiB by default). `uiobs doctor` tests the replay endpoint with the option `--replay`. See [Check an ingest server](#check-an-ingest-server).

`tools/reference-collector.mjs` implements each rule with no dependencies. It is not part of the package. Run `node tools/reference-collector.mjs`. Set `ALLOWED_ORIGINS` to the origins of your app. Set `UPSTREAM_URL` to an OTLP/HTTP collector, for example `http://localhost:4318`, to forward each OTLP batch there. The file lists the other settings: `HOST`, `PORT`, `ALLOW_CREDENTIALS`, `AUTH_TOKEN`, `SAMPLING_RULES`, `MAX_BODY_BYTES`, `MAX_REPLAY_BODY_BYTES`, `MAX_REQUESTS_PER_SECOND` and `DEDUP_MAX_IDS`.

- With `UPSTREAM_URL`, the collector gives the answer of the upstream to the library. A `2xx` answer keeps its status and its body, so the library can read a `partialSuccess`. The collector sends no body that is larger than 16 KiB, because the library ignores it.
- A `408`, `429` or `503` answer keeps its status. It also keeps its `Retry-After` header, when the upstream sends one. A `413` answer stays `413`. Another `5xx`, a `401` and a `403` become `503`. Another `4xx` becomes `400`.
- A `429` or `503` with no upstream `Retry-After` gets `Retry-After: 5`. Each `503` that the collector makes itself gets it too, for example after a `401`, a `403`, another `5xx` or a failed request.
- The library reads `Retry-After` only on `429` and `503`. A `408` is a plain retry.
- When the upstream sends a `2xx` status and then its body fails or stalls, the collector keeps the `2xx` status with no body. The upstream accepted the batch, so the library must not send it again.
- `DEDUP_MAX_IDS` is the number of batch ids that the collector keeps in memory. The default is 100000. When the table is full, the collector forgets the oldest id.
- A client that sends a forgotten batch again gets the batch stored two times. The collector writes a `[dedup]` warning when it forgets an id that is younger than 24 hours. It writes one warning each minute at most.
- To keep each id for 24 hours, set `DEDUP_MAX_IDS` above the number of batches that arrive in 24 hours.

## Check an ingest server

Run the command line tool against your ingest URL. Give the origin of your app.

```bash
pnpm dlx @utk09/ui-observability doctor https://ingest.example/v1/logs --origin https://app.example
```

The tool prints `PASS` or `FAIL` for each rule. The exit code is 0 when each rule passes, 1 when a rule fails and 2 for a wrong command.

| Rule | Check |
| --- | --- |
| `preflight` | `OPTIONS` answers with a `2xx` status and permits the origin. |
| `allowed headers` | The preflight allows each request header of the library. |
| `test batch` | A `POST` of an OTLP batch gets a `2xx` status and permits the origin. |
| `exposed headers` | The batch answer exposes `Retry-After`. A `PASS` line names optional headers that stay hidden. |
| `gzip` | A `POST` with `Content-Encoding: gzip` gets a `2xx` status. |
| `deduplication` | A second `POST` with the same `X-UiObs-Batch-Id` gets a `2xx` status. |
| `beacon` | A `POST` with `text/plain;charset=UTF-8`, the exit batch to another origin, gets a `2xx` status. |

- The tool sends real test batches. Each record has `service.name: "uiobs-doctor"`. The tool sends four test requests with three batch ids. A server that deduplicates keeps three test batches.
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
- Add `--credentials include` when your app sets `credentials: "include"`. It is the only value that the option accepts. Any other value is a wrong command.

  ```bash
  pnpm dlx @utk09/ui-observability doctor https://ingest.example/v1/logs --origin https://app.example --credentials include
  ```

- With credentials, a browser refuses `*` in `Access-Control-Allow-Origin`. It reads `*` in `Access-Control-Allow-Headers` and in `Access-Control-Expose-Headers` as a plain name, not as a wildcard.
- With a plain name, the library cannot read `Retry-After`, `X-UiObs-Sampling` or `Date`.
- Without the option, a `*` in one of these headers passes. The `PASS` line then says why a browser refuses it with `credentials: "include"` and names the option.
- A `*` in `Access-Control-Allow-Headers` never covers `Authorization`, with or without the option. With `--header "Authorization: ..."`, the `allowed headers` rule fails until the server names `authorization`. The `FAIL` line says so.
- With the option, the `preflight` and `test batch` rules fail on a `*` in `Access-Control-Allow-Origin`. The `allowed headers` rule fails when `Access-Control-Allow-Headers` has a `*` and does not list each header.
- With the option, the `exposed headers` rule fails when `Access-Control-Expose-Headers` has a `*` and does not list `Retry-After`. Each `FAIL` line gives the reason.
- With the option, the `preflight` and `test batch` rules also need `Access-Control-Allow-Credentials: true`. Without it, a browser rejects the answer. The library then sees a network error and sends the batch again.
- The option does not make the tool send a cookie. The `beacon` rule does not change. It needs only a `2xx` status. With `credentials: "include"`, the exit flush sends the same batch as a beacon.

To test a replay endpoint, give the value of `replay.endpoint` and add `--replay` directly after the origin. Give each header of your `replay.headers` option with `--header`. The option `--credentials include` also applies to a replay endpoint. There, the `test segment` rule needs `Access-Control-Allow-Credentials: true` in the same way.

```bash
pnpm dlx @utk09/ui-observability doctor https://ingest.example/v1/replay --origin https://app.example --replay
```

| Rule | Check |
| --- | --- |
| `preflight` | `OPTIONS` answers with a `2xx` status and permits the origin. |
| `allowed headers` | The preflight allows each request header of the library. |
| `test segment` | A `POST` of a small segment gets a `2xx` status and permits the origin. |
| `gzip` | A `POST` of a segment with `Content-Encoding: gzip` gets a `2xx` status. |
| `large segment` | A `POST` of a segment of 5 MB without gzip gets a `2xx` status. |
| `deduplication` | A second `POST` with the same `X-UiObs-Batch-Id` gets a `2xx` status. |

- The tool sends four test requests with three segments and one `replay.id`. Each segment has `service.name: "uiobs-doctor"` and one custom event of the recorder. One segment has 5 MB.
- The `large segment` rule finds a body limit that is too low. The library drops a segment after a `413` status, and the first segment of an upload has a full snapshot of the page.
- The tool sends no beacon to a replay endpoint, because the exit flush sends no segment.
- The tool prints no header value. A header value stays in the history of your shell. Use an environment variable for a token.
- A custom header cannot have the name of a header that the tool sets, for example `Content-Type` or `Origin`.
- A client cannot see the store of the server. `deduplication` proves only that the server accepts a repeated id.
- The tool follows no redirect. A `3xx` answer is a failure, because a browser refuses a preflight that redirects.
- An origin has no path and no trailing slash. A wrong command prints the usage and the arguments that the tool received.
- Use Node 22 or later for the tool. The tests run on Node 22.22.3.
