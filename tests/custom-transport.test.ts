// tests/custom-transport.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS, RETRY_BASE_DELAY_MS } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import type { Transport, TransportResponse } from "../src/models/config";
import { CustomTransport } from "../src/transport/custom-transport";
import { TransportError } from "../src/transport/errors";
import { isLibraryConsole } from "../src/utils/library-console";
import { isLibraryRequest } from "../src/utils/library-request";

/**
 * Builds a custom transport around a stub, with the diagnostics throttle off.
 * @param transport Stub that stands in for the consumer's transport.
 * @returns The transport under test and the events it reported.
 */
function setup(transport: Transport | undefined) {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const config = resolveConfig({ endpoint: null, serviceName: "svc", transport }, diagnostics);
  events.length = 0;

  return { sut: new CustomTransport(config, diagnostics), events };
}

/** A batch of two records. A count of 0 gives an empty batch. */
const batch = (count = 2): LogBatch => ({
  id: "batch-1",
  createdAt: Date.now(),
  attempts: 3,
  records: Array.from({ length: count }, (_unused, i) => ({
    timeUnixNano: "1755543600123000000",
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    traceFlags: 1,
    severityNumber: 9,
    severityText: "INFO" as const,
    body: `r${String(i)}`,
    attributes: {},
    resource: { "service.name": "svc" },
  })),
});

/**
 * Sends one batch and returns the error that the send threw.
 * @param sut Transport under test.
 * @returns The thrown TransportError.
 */
async function failure(sut: CustomTransport): Promise<TransportError> {
  const error: unknown = await sut.send(batch()).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  if (!(error instanceof TransportError)) {
    throw new Error("The send did not throw a TransportError.");
  }

  return error;
}

const answer = (response: TransportResponse): Transport => vi.fn(() => Promise.resolve(response));

afterEach(() => {
  vi.useRealTimers();
});

describe("CustomTransport", () => {
  it("gives the serialized batch, its id, its attempt and its records to the transport", async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve({ status: 202 }));
    const { sut } = setup(transport);
    const sent = batch();

    await sut.send(sent);

    const [request] = transport.mock.calls[0];
    expect(request.kind).toBe("logs");
    expect(request.batchId).toBe("batch-1");
    expect(request.attempt).toBe(3);
    expect(request.contentType).toBe("application/json");
    expect(JSON.parse(request.body)).toHaveProperty("resourceLogs");
    expect(request.records).toBe(sent.records);
  });

  it("gives a batch of metric records with metricsEndpoint set the metrics kind and body", async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve({ status: 202 }));
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const config = resolveConfig(
      { endpoint: null, serviceName: "svc", transport, metricsEndpoint: "https://x/v1/metrics" },
      diagnostics,
    );
    const sent = batch(1);
    sent.records[0].attributes = { "log.type": "metric", "metric.value": 1 };

    await new CustomTransport(config, diagnostics).send(sent);

    const [request] = transport.mock.calls[0];
    expect(request.kind).toBe("metrics");
    expect(JSON.parse(request.body)).toHaveProperty("resourceMetrics");
  });

  it("does not call the transport for an empty batch or with no transport", async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve({ status: 200 }));

    await setup(transport).sut.send(batch(0));
    await setup(undefined).sut.send(batch());

    expect(transport).not.toHaveBeenCalled();
  });

  it("marks the call as a library request and a library console call, so no capture records it", async () => {
    let inside = false;
    let printing = false;
    const { sut } = setup(() => {
      inside = isLibraryRequest();
      printing = isLibraryConsole();
      return Promise.resolve({ status: 200 });
    });

    await sut.send(batch());

    // A captured transport fetch logs a record. The transport then sends that record again.
    // A captured transport console line does the same.
    expect(inside).toBe(true);
    expect(printing).toBe(true);
    expect(isLibraryRequest()).toBe(false);
    expect(isLibraryConsole()).toBe(false);
  });

  it("gives the sampling rules of a 2xx answer to the sampling callback", async () => {
    const diagnostics = new Diagnostics(undefined, 0);
    const rules = { v: 1, ttlMs: 1000 };
    const config = resolveConfig(
      {
        endpoint: null,
        serviceName: "svc",
        sampling: { remote: true },
        transport: answer({ status: 200, sampling: rules }),
      },
      diagnostics,
    );
    const onSampling = vi.fn();

    await new CustomTransport(config, diagnostics, onSampling).send(batch());

    expect(onSampling).toHaveBeenCalledWith(rules);
  });

  it("splits on 413 and passes the maxBytes hint", async () => {
    const { sut } = setup(answer({ status: 413, maxBytes: 4096 }));

    const error = await failure(sut);

    expect(error.kind).toBe("too_large");
    expect(error.maxBytes).toBe(4096);
  });

  it("throttles on 429 for the Retry-After delay", async () => {
    const { sut, events } = setup(answer({ status: 429, retryAfterMs: 5000 }));

    const error = await failure(sut);

    expect(error.kind).toBe("throttled");
    expect(error.retryAfterMs).toBe(5000);
    expect(sut.throttledForMs(batch())).toBeGreaterThan(4000);
    expect(events.map((event) => event.code)).toContain("transport.throttled");
  });

  it("ignores a delay or a size limit that is not a finite number", async () => {
    const text = { status: 429, retryAfterMs: "30", maxBytes: "4096" } as unknown;
    const { sut } = setup(answer(text as TransportResponse));

    const error = await failure(sut);

    expect(error.retryAfterMs).toBeUndefined();
    expect(sut.throttledForMs(batch())).toBeLessThanOrEqual(RETRY_BASE_DELAY_MS);

    const endless = await failure(setup(answer({ status: 503, retryAfterMs: Infinity })).sut);
    const tooLarge = await failure(setup(answer({ status: 413, maxBytes: NaN })).sut);

    expect(endless.retryAfterMs).toBeUndefined();
    expect(tooLarge.maxBytes).toBeUndefined();
  });

  it("uses 0 for a negative delay", async () => {
    const { sut } = setup(answer({ status: 429, retryAfterMs: -5000 }));

    expect((await failure(sut)).retryAfterMs).toBe(0);
  });

  it("clears the throttle after an accepted batch", async () => {
    const responses: TransportResponse[] = [{ status: 503, retryAfterMs: 5000 }, { status: 204 }];
    const { sut } = setup(() => Promise.resolve(responses.shift() ?? { status: 200 }));

    await failure(sut);
    await sut.send(batch());

    expect(sut.throttledForMs(batch())).toBe(0);
  });

  it("retries a 5xx and drops another 4xx", async () => {
    expect((await failure(setup(answer({ status: 500 })).sut)).kind).toBe("transient");

    const { sut, events } = setup(answer({ status: 400 }));
    expect((await failure(sut)).kind).toBe("permanent");
    expect(events.map((event) => event.code)).toContain("transport.dropped_permanent");
  });

  it("drops a batch on 401 without the cookie advice of the HTTP path", async () => {
    const { sut, events } = setup(answer({ status: 401 }));

    expect((await failure(sut)).kind).toBe("permanent");
    expect(events[0].code).toBe("transport.rejected_credentials");
    expect(events[0].message).not.toContain("cookie");
  });

  it("retries when the transport throws, and keeps the cause", async () => {
    const cause = new Error("socket closed");
    const { sut } = setup(() => Promise.reject(cause));

    const error = await failure(sut);

    expect(error.kind).toBe("transient");
    expect(error.cause).toBe(cause);
  });

  it("retries when the transport does not settle in time", async () => {
    vi.useFakeTimers();
    const { sut } = setup(() => new Promise<TransportResponse>(() => undefined));

    const pending = failure(sut);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

    expect((await pending).kind).toBe("timeout");
  });

  it("reports a response that has no valid status, and retries", async () => {
    // A JavaScript consumer can resolve to a value with no status.
    const noStatus = (() => Promise.resolve(undefined)) as unknown as Transport;
    const { sut, events } = setup(noStatus);

    expect((await failure(sut)).kind).toBe("transient");
    expect(events.map((event) => event.code)).toContain("transport.http_error");
  });

  it("drops a batch that the serializer cannot encode", async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve({ status: 200 }));
    const events: DiagnosticEvent[] = [];
    const diagnostics = new Diagnostics((event) => {
      events.push(event);
    }, 0);
    const config = resolveConfig(
      {
        endpoint: null,
        serviceName: "svc",
        transport,
        serializer: {
          name: "broken",
          serialize: () => {
            throw new Error("cannot encode");
          },
        },
      },
      diagnostics,
    );

    await new CustomTransport(config, diagnostics).send(batch());

    expect(transport).not.toHaveBeenCalled();
    expect(events.map((event) => event.code)).toContain("transport.serialize_failed");
  });
});
