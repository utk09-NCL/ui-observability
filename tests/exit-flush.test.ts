import { afterEach, describe, expect, it, vi } from "vitest";
import { EMERGENCY_STORAGE_KEY_PREFIX } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import type { ObservabilityConfig } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";
import { ExitFlush } from "../src/transport/exit-flush";

const ENDPOINT = "https://x/v1/logs";

const record = (body: string): LogRecord => ({
  timeUnixNano: "1755543600123000000",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body,
  attributes: {},
  resource: { "service.name": "svc" },
});

/**
 * Listeners outlive a test, since happy-dom gives the whole file one window. A
 * failed assertion would otherwise leave an instance flushing on the next
 * test's pagehide. `uninstall` is idempotent, so a test may still call it.
 */
const built: ExitFlush[] = [];

afterEach(() => {
  for (const flush of built.splice(0)) {
    flush.uninstall();
  }
});

interface Options {
  records?: LogRecord[];
  config?: Partial<ObservabilityConfig>;
  /** Replaces the default drain, for the shapes a real pipeline cannot produce. */
  drain?: () => LogBatch | null;
}

/**
 * The default drain empties a real array, exactly as the pipeline does. One that
 * simply answers null the second time passes the "sends once" test without
 * exercising the thing that actually prevents the double send.
 */
function setup({ records = [], config = {}, drain }: Options = {}) {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);

  const resolved = resolveConfig(
    { endpoint: ENDPOINT, serviceName: "svc", ...config },
    diagnostics,
  );
  const pending = [...records];
  let drains = 0;

  const flush = new ExitFlush({
    config: resolved,
    diagnostics,
    drainPending:
      drain ??
      (() =>
        pending.length === 0
          ? null
          : {
              id: `b${String(++drains)}`,
              createdAt: Date.now(),
              attempts: 0,
              records: pending.splice(0),
            }),
  });

  built.push(flush);
  return { flush, pending, events, codes: () => events.map((event) => event.code) };
}

const stubBeacon = (impl: (url: string, data: Blob) => boolean = () => true) => {
  const beacon = vi.fn(impl);
  vi.stubGlobal("navigator", { sendBeacon: beacon });
  return beacon;
};

/** Body defaults to null: 204 is a null-body status, and a Response with both throws. */
const stubFetch = (
  impl: (url: string, init: RequestInit) => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: 204 })),
) => {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

/** An OpenFin runtime with only the listener API this module touches. */
const stubFin = (me: unknown) => {
  vi.stubGlobal("fin", { me });
};

/** Indexed rather than enumerated: happy-dom's Storage is a Proxy and does not enumerate its items. */
const emergencyKeys = () => {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(EMERGENCY_STORAGE_KEY_PREFIX)) {
      keys.push(key);
    }
  }
  return keys;
};

describe("ExitFlush install", () => {
  it("flushes when the document becomes hidden", () => {
    const beacon = stubBeacon();
    const { flush } = setup({ records: [record("bye")] });
    flush.install();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(beacon).toHaveBeenCalledOnce();
    expect(new URL(beacon.mock.calls[0][0]).searchParams.get("uiobs_exit")).toBe("hidden");
    flush.uninstall();
  });

  it("ignores a visibilitychange back to visible", () => {
    const beacon = stubBeacon();
    const { flush } = setup({ records: [record("stay")] });
    flush.install();

    document.dispatchEvent(new Event("visibilitychange"));

    expect(beacon).not.toHaveBeenCalled();
    flush.uninstall();
  });

  it("flushes on pagehide, which fires at the window", () => {
    const beacon = stubBeacon();
    const { flush } = setup({ records: [record("bye")] });
    flush.install();

    dispatchEvent(new Event("pagehide"));

    expect(new URL(beacon.mock.calls[0][0]).searchParams.get("uiobs_exit")).toBe("pagehide");
    flush.uninstall();
  });

  it("flushes on freeze, which fires at the document and does not bubble", () => {
    const beacon = stubBeacon();
    const { flush } = setup({ records: [record("bye")] });
    flush.install();

    document.dispatchEvent(new Event("freeze"));

    expect(new URL(beacon.mock.calls[0][0]).searchParams.get("uiobs_exit")).toBe("freeze");
    flush.uninstall();
  });

  it("binds once, however often install is called", () => {
    const add = vi.spyOn(globalThis, "addEventListener");
    const { flush } = setup();

    flush.install();
    flush.install();

    expect(add).toHaveBeenCalledOnce();
    flush.uninstall();
  });

  it("binds nothing in a host without addEventListener", () => {
    vi.stubGlobal("addEventListener", undefined);
    const remove = vi.spyOn(globalThis, "removeEventListener");
    const { flush } = setup();

    flush.install();
    flush.uninstall();

    expect(remove).not.toHaveBeenCalled();
  });

  it("binds only the window listener in a host without a document", () => {
    const beacon = stubBeacon();
    vi.stubGlobal("document", undefined);
    const { flush } = setup({ records: [record("bye")] });

    flush.install();
    dispatchEvent(new Event("pagehide"));
    flush.uninstall();

    expect(beacon).toHaveBeenCalledOnce();
  });
});

describe("ExitFlush uninstall", () => {
  it("stops flushing on every signal", () => {
    const beacon = stubBeacon();
    const { flush } = setup({ records: [record("bye")] });
    flush.install();
    flush.uninstall();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("freeze"));
    dispatchEvent(new Event("pagehide"));

    expect(beacon).not.toHaveBeenCalled();
  });

  it("does nothing when it was never installed", () => {
    const remove = vi.spyOn(globalThis, "removeEventListener");
    const { flush } = setup();

    flush.uninstall();

    expect(remove).not.toHaveBeenCalled();
  });
});

describe("ExitFlush on OpenFin", () => {
  it("flushes when the runtime asks to close a window", () => {
    const beacon = stubBeacon();
    const listeners = new Map<string, () => void>();
    stubFin({
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      removeListener: () => undefined,
    });

    const { flush } = setup({ records: [record("bye")] });
    flush.install();
    listeners.get("close-requested")?.();

    expect(new URL(beacon.mock.calls[0][0]).searchParams.get("uiobs_exit")).toBe("openfin-close");
    flush.uninstall();
  });

  it("releases the close-requested listener on uninstall", () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    stubFin({ on, removeListener });

    const { flush } = setup();
    flush.install();
    flush.uninstall();

    expect(removeListener).toHaveBeenCalledWith("close-requested", on.mock.calls[0][1]);
  });

  it("tolerates a runtime that exposes no listener API", () => {
    const { flush, codes } = setup();
    stubFin({});

    flush.install();
    flush.uninstall();

    expect(codes()).not.toContain("openfin.unavailable");
  });

  it("reports a runtime whose subscription throws, and installs anyway", () => {
    const beacon = stubBeacon();
    stubFin({
      on: () => {
        throw new Error("runtime is gone");
      },
    });

    const { flush, codes } = setup({ records: [record("bye")] });
    flush.install();
    dispatchEvent(new Event("pagehide"));

    expect(codes()).toContain("openfin.unavailable");
    expect(beacon).toHaveBeenCalledOnce();
    flush.uninstall();
  });
});

describe("ExitFlush flush", () => {
  it("beacons the pending batch with the id in the query string", () => {
    const beacon = stubBeacon();

    setup({ records: [record("bye")] }).flush.flush("pagehide");

    expect(beacon).toHaveBeenCalledOnce();
    const url = new URL(beacon.mock.calls[0][0]);
    expect(url.searchParams.get("uiobs_batch_id")).toBe("b1");
    expect(beacon.mock.calls[0][1].type).toBe("text/plain;charset=utf-8");
  });

  it("sends once even when hidden is followed by pagehide", () => {
    const beacon = stubBeacon();
    const { flush } = setup({ records: [record("bye")] });

    flush.flush("hidden");
    flush.flush("pagehide");

    expect(beacon).toHaveBeenCalledOnce();
  });

  it("sends again when new records arrived between hidden and pagehide", () => {
    const beacon = stubBeacon();
    const { flush, pending } = setup({ records: [record("first")] });

    flush.flush("hidden");
    pending.push(record("second"));
    flush.flush("pagehide");

    expect(beacon).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when there is no endpoint to send to", () => {
    const beacon = stubBeacon();

    setup({ records: [record("bye")], config: { endpoint: "" } }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
  });

  it("reports an endpoint that is not a URL, and keeps the buffer", () => {
    const beacon = stubBeacon();
    const { flush, pending, events } = setup({
      records: [record("bye")],
      config: { endpoint: "not-a-url" },
    });

    flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    expect(events.some((event) => event.message.includes("the exit flush cannot use"))).toBe(true);
  });

  it("sends nothing when the drain hands back an empty batch", () => {
    const beacon = stubBeacon();
    const { flush } = setup({
      drain: () => ({ id: "b1", createdAt: Date.now(), attempts: 0, records: [] }),
    });

    flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
  });

  it("reports a serializer that throws, and drops the batch", () => {
    const beacon = stubBeacon();
    const { flush, codes } = setup({
      records: [record("bye")],
      config: {
        serializer: {
          name: "broken",
          serialize: () => {
            throw new Error("cannot encode");
          },
        },
      },
    });

    flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(codes()).toContain("transport.serialize_failed");
  });

  it("diverts an oversized batch to the synchronous emergency queue", () => {
    const beacon = stubBeacon();
    const huge = Array.from({ length: 400 }, (_unused, i) => record("x".repeat(300) + String(i)));

    setup({ records: huge }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });
});

describe("ExitFlush keepalive fallback", () => {
  it("falls back when the host has no sendBeacon", () => {
    // A navigator without the method, which is what a worker has. The tests
    // below drop the navigator outright, which is the other half of the guard.
    vi.stubGlobal("navigator", {});
    const fetchMock = stubFetch();

    setup({ records: [record("bye")] }).flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
    const headers = init.headers as Record<string, string>;
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("include");
    expect(headers["Content-Type"]).toBe("text/plain;charset=UTF-8");
  });

  it("falls back when the browser refuses the beacon", () => {
    stubBeacon(() => false);
    const fetchMock = stubFetch();

    setup({ records: [record("bye")] }).flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back when sendBeacon itself throws, and reports it", () => {
    stubBeacon(() => {
      throw new Error("beacon is unavailable");
    });
    const fetchMock = stubFetch();

    const { flush, codes } = setup({ records: [record("bye")] });
    flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(codes()).toContain("transport.http_error");
  });

  it("reports a keepalive fetch that never arrives", async () => {
    vi.stubGlobal("navigator", undefined);
    stubFetch(() => Promise.reject(new Error("network is down")));

    const { flush, events } = setup({ records: [record("bye")] });
    flush.flush("pagehide");

    await vi.waitFor(() => {
      expect(events.some((event) => event.message.includes("exit flush failed"))).toBe(true);
    });
  });

  it("reports a fetch that throws before it returns a promise", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch is not usable here");
    });

    const { flush, codes } = setup({ records: [record("bye")] });
    flush.flush("pagehide");

    expect(codes()).toContain("transport.http_error");
  });
});
