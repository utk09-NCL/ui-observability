// tests/flush-result.test.ts
//
// flush() waits at most its time limit and returns what became of the records in memory at the
// call. A forwarder hands its records to its sender and asks the sender to flush over the bus.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Receive, WorkerLike } from "../src/bus/links";
import { BUS_MAX_FLUSH_REQUESTS, BUS_PROTOCOL } from "../src/constants";
import { JourneyEngine } from "../src/core/journey";
import { ObservabilityRuntime } from "../src/core/runtime";
import { Sender } from "../src/core/sender";
import { envelope, type BusMessage } from "../src/models/bus";
import type { DiagnosticEvent } from "../src/core/diagnostics";
import type { DropSummary } from "../src/models/drop";
import type { LogRecord } from "../src/models/log-record";
import {
  configure,
  counter,
  createMemoryTransport,
  flush,
  type FlushOptions,
  type FlushResult,
  getDiagnosticCounters,
  getHealth,
  info,
  registerFrame,
  registerWorker,
  rotateSecurityContext,
  shutdown,
  type Transport,
  type TransportResponse,
} from "../src/index";

/** Matches the runtime's global key in src/core/runtime.ts. */
const RUNTIME_KEY = Symbol.for("ui-observability.runtime");

const FLUSH_REQUEST = "ui-observability.message.flush-request";
const FLUSH_RESULT = "ui-observability.message.flush-result";

/** The report text for flush() options the library can't use. */
const FLUSH_INVALID = "flush() got invalid options. The library waits the default 5000 ms.";

/** Settings that keep a test away from storage, captures and the bus. */
const quiet = {
  serviceName: "flush",
  storage: { backend: "memory" as const },
  capture: { errors: false, rejections: false },
  bus: { mode: "off" as const },
};

/** The bus settings of a top-level sender that takes messages from any same-origin child. */
const openBus = {
  mode: "auto" as const,
  sourcePolicy: "trusted-origin" as const,
  maxMessagesPerSecond: null,
};

/** Answers the tests have not given. They're given after each test, so shutdown() can end. */
const unanswered: (() => void)[] = [];

afterEach(() => {
  for (const answer of unanswered.splice(0)) {
    answer();
  }
  vi.useRealTimers();
});

/**
 * Builds a flush result. The counts that aren't given are 0.
 * @param over The fields to set.
 * @returns The result.
 */
function result(over: Partial<FlushResult> = {}): FlushResult {
  return {
    status: "complete",
    accepted: 0,
    stored: 0,
    dropped: 0,
    forwarded: 0,
    pending: 0,
    ...over,
  };
}

/**
 * The runtime pinned to this realm.
 * @returns The runtime.
 */
function runtime(): ObservabilityRuntime {
  const current = ObservabilityRuntime.current();
  if (!current) {
    throw new Error("no runtime configured");
  }
  return current;
}

/** Waits for startup to end. */
async function ready(): Promise<void> {
  await runtime()["started"];
  expect(runtime()["ready"]).toBe(true);
}

/** Lets queued microtasks and one timer turn run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Builds a custom transport whose answers the test gives by hand.
 * @returns The transport and one answer function for each call, in call order.
 */
function heldTransport() {
  const answers: ((status: number) => void)[] = [];
  const transport: Transport = () =>
    new Promise<TransportResponse>((resolve) => {
      const answer = (status: number): void => {
        resolve({ status });
      };
      answers.push(answer);
      unanswered.push(() => {
        answer(200);
      });
    });
  return { transport, answers };
}

/**
 * Builds a record that a child context forwards. It passes the bus's record check.
 * @param body The message.
 * @returns The record.
 */
function childRecord(body: string): LogRecord {
  return {
    body,
    severityText: "INFO",
    severityNumber: 9,
    timeUnixNano: `${String(Date.now())}000000`,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    traceFlags: 1,
    attributes: {},
    resource: {},
  };
}

/**
 * Lists the flush answers that a reply function got.
 * @param reply The reply mock.
 * @returns The answers, oldest first.
 */
function flushAnswers(reply: { mock: { calls: unknown[][] } }): BusMessage[] {
  return reply.mock.calls
    .map(([message]) => message as BusMessage)
    .filter((message) => message.t === FLUSH_RESULT);
}

/**
 * Makes this document a same-origin frame whose parent runtime welcomes it, so the bus in mode
 * "auto" becomes a forwarder with a direct link. The parent keeps each message it gets.
 * @returns The messages, and a function that answers the last flush request.
 */
function sameOriginParent() {
  const received: BusMessage[] = [];
  let replyToFlush: Receive | undefined;
  const busAccept = (message: BusMessage, reply: Receive): void => {
    received.push(message);
    if (message.t === "ui-observability.message.hello") {
      reply(
        { t: "ui-observability.message.welcome", from: "owner", to: message.from, tabId: "t" },
        { link: "direct", origin: "same-origin" },
      );
    }
    if (message.t === FLUSH_REQUEST) {
      replyToFlush = reply;
    }
  };
  const host = { busAccept, busCanAccept: () => true, protocol: BUS_PROTOCOL };
  const parent = { [RUNTIME_KEY]: host } as unknown as Window & typeof globalThis;
  vi.spyOn(window, "parent", "get").mockReturnValue(parent);

  const requests = (): Extract<BusMessage, { t: typeof FLUSH_REQUEST }>[] =>
    received.filter((message) => message.t === FLUSH_REQUEST);

  return {
    received,
    requests,
    /**
     * Answers the last flush request on the direct link.
     * @param answer The result to send.
     * @param over Fields of the message to change, for example its id or sender.
     */
    answer(answer: unknown, over: Partial<{ id: string; from: string }> = {}): void {
      const [request] = requests().slice(-1);
      replyToFlush?.(
        { t: FLUSH_RESULT, from: "owner", id: request.id, result: answer, ...over },
        { link: "direct", origin: "same-origin" },
      );
    },
  };
}

describe("flush() options", () => {
  it.each([
    ["a negative timeoutMs", { timeoutMs: -1 }],
    ["a timeoutMs above 600000", { timeoutMs: 600_001 }],
    ["a timeoutMs that is NaN", { timeoutMs: Number.NaN }],
    ["a timeoutMs that is a string", { timeoutMs: "100" }],
    ["options that are a string", "fast"],
  ])("reports config.invalid for %s and waits the default 5000 ms", async (_name, options) => {
    const { transport } = heldTransport();
    const events: DiagnosticEvent[] = [];
    configure({
      ...quiet,
      transport,
      delivery: { requestTimeoutMs: 60_000 },
      onDiagnostic: (event) => {
        events.push(event);
      },
    });
    await ready();
    vi.useFakeTimers();
    info("held");

    let returned: FlushResult | undefined;
    void flush(options as FlushOptions).then((value) => {
      returned = value;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(returned).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(returned).toEqual(result({ status: "timeout", pending: 1 }));
    const invalid = events.filter((event) => event.code === "config.invalid");
    expect(invalid.map((event) => event.message)).toEqual([FLUSH_INVALID]);
  });

  it("reports one config.invalid for a getter that throws, and uses the default", async () => {
    configure({ ...quiet, transport: createMemoryTransport().transport });
    await ready();
    const options = {
      get timeoutMs(): number {
        throw new Error("no getter");
      },
    };

    expect(await flush(options)).toEqual(result());
    expect(getDiagnosticCounters()["config.invalid"]).toBe(1);
  });

  it("uses the default with no report for null options and a null timeoutMs", async () => {
    configure({ ...quiet, transport: createMemoryTransport().transport });
    await ready();

    expect(await flush(null as never)).toEqual(result());
    expect(await flush({ timeoutMs: null as never })).toEqual(result());
    expect(getDiagnosticCounters()["config.invalid"]).toBeUndefined();
  });

  it("returns at the next timer turn with timeoutMs 0", async () => {
    const { transport } = heldTransport();
    configure({ ...quiet, transport });
    await ready();
    info("held");

    expect(await flush({ timeoutMs: 0 })).toEqual(result({ status: "timeout", pending: 1 }));
  });
});

describe("flush() in a runtime that sends nothing", () => {
  it("returns inactive before configure(), with the held records as pending", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    info("early");

    expect(await flush()).toEqual(result({ status: "inactive", pending: 1 }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(runtime()["running"]).toBe(false);
  });

  it("returns inactive after a failed first configure(), which refused the held record", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    info("early");
    configure(null as never);

    expect(await flush()).toEqual(result({ status: "inactive" }));
  });

  it("returns inactive during a pause and sends nothing, then sends after the pause", async () => {
    const memory = createMemoryTransport();
    configure({ ...quiet, transport: memory.transport });
    await ready();
    info("kept");
    configure({ enabled: false });

    expect(await flush()).toEqual(result({ status: "inactive", pending: 1 }));
    expect(memory.records()).toEqual([]);

    configure({ enabled: true });
    expect(await flush()).toEqual(result({ accepted: 1 }));
  });

  it("returns inactive after shutdown()", async () => {
    configure({ ...quiet, transport: createMemoryTransport().transport });
    await ready();
    await shutdown();

    expect(await flush()).toEqual(result({ status: "inactive" }));
  });

  it("returns inactive when a pause starts during the startup wait", async () => {
    configure({ ...quiet, transport: createMemoryTransport().transport });
    info("held");

    const call = flush();
    configure({ enabled: false });

    expect(await call).toEqual(result({ status: "inactive", pending: 1 }));
  });
});

describe("flush() in a sender", () => {
  it("counts the accepted records, also the ones logged right after configure()", async () => {
    const memory = createMemoryTransport();
    configure({ ...quiet, transport: memory.transport });
    info("one");
    info("two");

    expect(await flush()).toEqual(result({ accepted: 2 }));
    expect(memory.records()).toHaveLength(2);
  });

  it("leaves out a record that is logged after the call", async () => {
    configure({ ...quiet, transport: createMemoryTransport().transport });
    await ready();
    info("before");

    const call = flush();
    info("after");

    expect(await call).toEqual(result({ accepted: 1 }));
    expect((await getHealth()).delivery.pending).toBe(1);
  });

  it("counts the records of a send that fails offline as stored", async () => {
    const transport: Transport = () => Promise.reject(new TypeError("Failed to fetch"));
    configure({ ...quiet, transport });
    await ready();
    info("one");
    info("two");

    expect(await flush()).toEqual(result({ stored: 2 }));
    expect((await getHealth()).delivery.stored).toBe(1);
  });

  it("counts a throttled send as stored, and stores the next batch without a send", async () => {
    const memory = createMemoryTransport();
    configure({ ...quiet, transport: memory.transport });
    await ready();
    memory.respondWith(429, 30_000);
    info("throttled");
    expect(await flush()).toEqual(result({ stored: 1 }));

    info("held back");
    expect(await flush()).toEqual(result({ stored: 1 }));
    expect(memory.batches()).toHaveLength(1);
  });

  it("counts the records that storage refuses as dropped", async () => {
    const memory = createMemoryTransport();
    const drops: DropSummary[] = [];
    configure({
      ...quiet,
      transport: memory.transport,
      storage: { backend: "none" },
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    await ready();
    memory.respondWith(500);
    info("lost");

    expect(await flush()).toEqual(result({ dropped: 1 }));
    await settle();
    expect(drops.map((summary) => summary.reason)).toEqual(["not_stored"]);
  });

  it("counts the records that the server refuses as dropped", async () => {
    const memory = createMemoryTransport();
    configure({ ...quiet, transport: memory.transport });
    await ready();
    memory.respondWith(400);
    info("refused");

    expect(await flush()).toEqual(result({ dropped: 1 }));
  });

  it("counts the records an OTLP server rejects in an accepted batch as dropped", async () => {
    const body = JSON.stringify({ partialSuccess: { rejectedLogRecords: "1" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
        ),
      ),
    );
    configure({ ...quiet, endpoint: "https://ingest.example/v1/logs", compression: "none" });
    await ready();
    info("one");
    info("two");
    info("three");

    expect(await flush()).toEqual(result({ accepted: 2, dropped: 1 }));
  });

  it("returns timeout at the limit with the record in flight as pending, and a late answer changes nothing", async () => {
    const { transport, answers } = heldTransport();
    configure({ ...quiet, transport, delivery: { requestTimeoutMs: 60_000 } });
    await ready();
    vi.useFakeTimers();
    info("held");

    const call = flush({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const returned = await call;
    answers[0](200);
    await vi.advanceTimersByTimeAsync(0);

    expect(returned).toEqual(result({ status: "timeout", pending: 1 }));
    expect((await getHealth()).delivery).toMatchObject({ pending: 0, inFlight: 0, stored: 0 });
  });

  it("gives each concurrent call its own snapshot and deadline", async () => {
    const { transport, answers } = heldTransport();
    configure({ ...quiet, transport, delivery: { requestTimeoutMs: 60_000 } });
    await ready();
    vi.useFakeTimers();
    info("first");

    const one = flush({ timeoutMs: 100 });
    info("second");
    const two = flush({ timeoutMs: 200 });
    await vi.advanceTimersByTimeAsync(0);
    answers[0](200);
    await vi.advanceTimersByTimeAsync(200);

    // The first batch is in both snapshots. The second one is only in the later call's.
    expect(await one).toEqual(result({ accepted: 1 }));
    expect(await two).toEqual(result({ status: "timeout", accepted: 1, pending: 1 }));
  });

  it("returns timeout when startup doesn't end before the limit", async () => {
    vi.spyOn(JourneyEngine.prototype, "bootstrap").mockReturnValue(
      new Promise<void>((resolve) => {
        unanswered.push(resolve);
      }),
    );
    configure({ ...quiet, transport: createMemoryTransport().transport });
    info("held");

    expect(await flush({ timeoutMs: 20 })).toEqual(result({ status: "timeout", pending: 1 }));
  });

  it("returns timeout with the old sender's records as pending while a rotation retires it", async () => {
    const { transport, answers } = heldTransport();
    configure({ ...quiet, transport, delivery: { requestTimeoutMs: 60_000 } });
    await ready();
    info("old context");
    expect(await flush({ timeoutMs: 0 })).toEqual(result({ status: "timeout", pending: 1 }));

    const rotating = rotateSecurityContext(
      { id: "next", routing: { transport: createMemoryTransport().transport } },
      { pending: "flush", timeoutMs: 60_000 },
    );
    await vi.waitFor(() => {
      expect(runtime()["sender"]).toBeUndefined();
    });

    // The rotation's rule decides what becomes of these records, so they aren't lost yet.
    expect(await flush({ timeoutMs: 20 })).toEqual(result({ status: "timeout", pending: 1 }));
    answers[0](200);
    await rotating;
  });

  it("waits for a sender that starts to load after startup", async () => {
    const memory = createMemoryTransport();
    // Isolation refuses a routing change, so turn it off to add the transport later.
    configure({ ...quiet, securityContext: { isolation: false } });
    await ready();
    configure({ transport: memory.transport });
    info("waits for the sender");

    expect(await flush()).toEqual(result({ accepted: 1 }));
  });

  it("returns timeout when the sender load doesn't end before the limit", async () => {
    vi.spyOn(Sender, "create").mockReturnValue(
      new Promise<Sender>((_resolve, reject) => {
        unanswered.push(() => {
          reject(new Error("test over"));
        });
      }),
    );
    configure({ ...quiet, securityContext: { isolation: false } });
    await ready();
    configure({ transport: createMemoryTransport().transport });
    info("waits for the sender");

    expect(await flush({ timeoutMs: 20 })).toEqual(result({ status: "timeout", pending: 1 }));
  });

  it("counts the waiting records as dropped when the sender doesn't load", async () => {
    vi.spyOn(Sender, "create").mockRejectedValue(new Error("chunk failed"));
    configure({ ...quiet, securityContext: { isolation: false } });
    await ready();
    configure({ transport: createMemoryTransport().transport });
    info("lost with the load");

    expect(await flush()).toEqual(result({ dropped: 1 }));
  });
});

describe("flush() in a forwarder", () => {
  it("hands its records to the sender before the request, then takes the sender's counts", async () => {
    const parent = sameOriginParent();
    configure({ serviceName: "child" });
    await ready();
    info("one");
    info("two");

    const call = flush();
    const types = parent.received
      .map((message) => message.t)
      .filter((type) => type === "ui-observability.message.records" || type === FLUSH_REQUEST);
    expect(types).toEqual(["ui-observability.message.records", FLUSH_REQUEST]);
    // The request asks for 90 percent of the time that is left, so the answer has time to come.
    const [{ timeoutMs }] = parent.requests();
    expect(timeoutMs).toBeGreaterThan(4000);
    expect(timeoutMs).toBeLessThanOrEqual(4500);
    parent.answer(result({ accepted: 7, forwarded: 99 }));

    // The sender's counts cover its whole snapshot. forwarded is this context's own count.
    expect(await call).toEqual(result({ accepted: 7, forwarded: 2 }));
  });

  it("returns timeout with the forwarded records as pending when no answer comes", async () => {
    const parent = sameOriginParent();
    configure({ serviceName: "child" });
    await ready();
    info("one");
    info("two");

    expect(await flush({ timeoutMs: 20 })).toEqual(
      result({ status: "timeout", forwarded: 2, pending: 2 }),
    );
    expect(parent.requests()).toHaveLength(1);
  });

  it.each([
    ["an unknown status", { ...result(), status: "done" }],
    ["a negative count", result({ accepted: -1 })],
    ["a count that isn't whole", result({ stored: 1.5 })],
    ["a count above the safe integers", result({ dropped: 2 ** 53 })],
    ["a count that is a string", { ...result(), pending: "1" }],
    ["a missing count", { status: "complete" }],
    ["a result that isn't an object", "complete"],
    ["the status complete with pending records", result({ pending: 2 })],
  ])("ignores an answer with %s and counts it", async (_name, answer) => {
    const parent = sameOriginParent();
    configure({ serviceName: "child" });
    await ready();
    info("one");

    const call = flush({ timeoutMs: 20 });
    parent.answer(answer);

    expect(await call).toEqual(result({ status: "timeout", forwarded: 1, pending: 1 }));
    expect(getDiagnosticCounters()["bus.rejected_message"]).toBe(1);
  });

  it("ignores an answer from another context, for another id or on another link", async () => {
    const parent = sameOriginParent();
    configure({ serviceName: "child" });
    await ready();
    info("one");

    const call = flush({ timeoutMs: 20 });
    parent.answer(result({ accepted: 1 }), { from: "stranger" });
    parent.answer(result({ accepted: 1 }), { id: "another request" });
    const [request] = parent.requests();
    const bus = runtime()["bus"] as unknown as {
      receive: (message: BusMessage, source: { link: string; origin: string }) => void;
    };
    bus.receive(
      { t: FLUSH_RESULT, from: "owner", id: request.id, result: result({ accepted: 1 }) },
      { link: "broadcast", origin: "same-origin" },
    );

    expect(await call).toEqual(result({ status: "timeout", forwarded: 1, pending: 1 }));
  });

  it("counts its records as dropped at once when it has no owner to ask", async () => {
    configure({ serviceName: "child", bus: { mode: "forwarder" } });
    await ready();
    info("lost");

    // With no owner the bus drops the records, so a "timeout" with nothing pending can't occur.
    expect(await flush()).toEqual(result({ dropped: 1 }));
  });

  it("runs its own flush for a child's request and answers with its sender's counts", async () => {
    const parent = sameOriginParent();
    configure({ serviceName: "middle", bus: openBus });
    await ready();
    const reply = vi.fn<Receive>();

    // With isolation on, a record message names the delivery context it belongs to.
    runtime().busAccept(
      {
        t: "ui-observability.message.records",
        from: "grandchild",
        records: [childRecord("deep")],
        routingContextId: runtime().config.securityContext.id,
      },
      reply,
    );
    runtime().busAccept({ t: FLUSH_REQUEST, from: "grandchild", id: "g1", timeoutMs: 1000 }, reply);
    info("middle");
    await vi.waitFor(() => {
      expect(parent.requests()).toHaveLength(1);
    });
    parent.answer(result({ accepted: 9 }));
    await vi.waitFor(() => {
      expect(flushAnswers(reply)).toHaveLength(1);
    });

    expect(flushAnswers(reply)[0]).toEqual({
      t: FLUSH_RESULT,
      from: runtime().identity.contextId,
      id: "g1",
      result: result({ accepted: 9, forwarded: 1 }),
    });
    // The grandchild's records and the middle's own records go before the middle's request.
    const order = parent.received
      .filter((message) => message.t !== "ui-observability.message.hello")
      .map((message) =>
        message.t === "ui-observability.message.records" ? message.records[0].body : message.t,
      )
      .filter((entry) => entry === "deep" || entry === "middle" || entry === FLUSH_REQUEST);
    expect(order).toEqual(["deep", "middle", FLUSH_REQUEST]);
  });
});

describe("flush requests that a sender gets over the bus", () => {
  it("puts the records that a child sent before its request in the answer", async () => {
    configure({ ...quiet, transport: createMemoryTransport().transport, bus: openBus });
    await ready();
    const reply = vi.fn<Receive>();

    runtime().busAccept(
      {
        t: "ui-observability.message.records",
        from: "child",
        records: [childRecord("one"), childRecord("two")],
        routingContextId: runtime().config.securityContext.id,
      },
      reply,
    );
    runtime().busAccept({ t: FLUSH_REQUEST, from: "child", id: "c1", timeoutMs: 1000 }, reply);
    await vi.waitFor(() => {
      expect(flushAnswers(reply)).toHaveLength(1);
    });

    expect(flushAnswers(reply)[0]).toEqual({
      t: FLUSH_RESULT,
      from: runtime().identity.contextId,
      id: "c1",
      result: result({ accepted: 2 }),
    });
  });

  it("sends no open metric interval for a flush that a child asks for", async () => {
    const memory = createMemoryTransport();
    configure({ ...quiet, transport: memory.transport, bus: openBus });
    await ready();
    counter("clicks").add(1);
    const reply = vi.fn<Receive>();
    const clicks = (): LogRecord[] => memory.records().filter((one) => one.body === "clicks");

    runtime().busAccept({ t: FLUSH_REQUEST, from: "child", id: "m1", timeoutMs: 1000 }, reply);
    await vi.waitFor(() => {
      expect(flushAnswers(reply)).toHaveLength(1);
    });
    expect(clicks()).toEqual([]);

    await flush();
    expect(clicks()).toHaveLength(1);
  });

  it("answers inactive while paused", async () => {
    configure({ ...quiet, transport: createMemoryTransport().transport, bus: openBus });
    await ready();
    configure({ enabled: false });
    const reply = vi.fn<Receive>();

    runtime().busAccept({ t: FLUSH_REQUEST, from: "child", id: "p1", timeoutMs: 1000 }, reply);
    await vi.waitFor(() => {
      expect(flushAnswers(reply)).toHaveLength(1);
    });

    expect(flushAnswers(reply)[0]).toMatchObject({ result: result({ status: "inactive" }) });
  });

  it("answers a registered frame at its origin, and no frame that isn't registered", async () => {
    configure({
      ...quiet,
      transport: createMemoryTransport().transport,
      bus: { mode: "auto", maxMessagesPerSecond: null },
    });
    await ready();
    const iframe = document.createElement("iframe");
    iframe.srcdoc = "";
    document.body.append(iframe);
    const child = iframe.contentWindow;
    if (!child) {
      throw new Error("the frame has no window");
    }
    const post = vi.spyOn(child, "postMessage");
    const ask = (id: string): void => {
      dispatchEvent(
        new MessageEvent("message", {
          data: envelope({ t: FLUSH_REQUEST, from: "frame", id, timeoutMs: 1000 }),
          source: child,
          origin: location.origin,
        }),
      );
    };

    ask("before registration");
    await settle();
    expect(post).not.toHaveBeenCalled();
    expect(getDiagnosticCounters()["bus.rejected_message"]).toBe(1);

    registerFrame(iframe, { origin: location.origin });
    await settle();
    ask("registered");
    await vi.waitFor(() => {
      expect(post).toHaveBeenCalled();
    });

    expect(post).toHaveBeenCalledWith(
      envelope({
        t: FLUSH_RESULT,
        from: runtime().identity.contextId,
        id: "registered",
        result: result(),
      }),
      location.origin,
    );
    iframe.remove();
  });

  it("answers only the worker that asked", async () => {
    configure({ ...quiet, transport: createMemoryTransport().transport, bus: openBus });
    await ready();
    const worker = (): WorkerLike & { listeners: ((event: MessageEvent) => void)[] } => {
      const listeners: ((event: MessageEvent) => void)[] = [];
      return {
        listeners,
        postMessage: vi.fn(),
        addEventListener: (_type, listener) => {
          listeners.push(listener);
        },
        removeEventListener: vi.fn(),
      };
    };
    const asking = worker();
    const other = worker();
    registerWorker(asking);
    registerWorker(other);
    await settle();

    asking.listeners[0](
      new MessageEvent("message", {
        data: envelope({ t: FLUSH_REQUEST, from: "worker", id: "w1", timeoutMs: 1000 }),
      }),
    );
    const answered = (target: WorkerLike): unknown[] =>
      vi
        .mocked(target.postMessage)
        .mock.calls.map(([data]) => data)
        .filter((data) => (data as { m: BusMessage }).m.t === FLUSH_RESULT);
    await vi.waitFor(() => {
      expect(answered(asking)).toHaveLength(1);
    });

    expect(answered(asking)[0]).toEqual(
      envelope({ t: FLUSH_RESULT, from: runtime().identity.contextId, id: "w1", result: result() }),
    );
    expect(answered(other)).toEqual([]);
  });

  it("runs at most two flushes for a flood of requests, and refuses the requests past the caps", async () => {
    const { transport, answers } = heldTransport();
    configure({ ...quiet, transport, bus: openBus, delivery: { requestTimeoutMs: 60_000 } });
    await ready();
    const flushes = vi.spyOn(
      runtime() as unknown as { flushFor: () => Promise<FlushResult> },
      "flushFor",
    );
    const reply = vi.fn<Receive>();
    const ask = (index: number, source: Window): void => {
      runtime().busAccept(
        { t: FLUSH_REQUEST, from: "child", id: `r${String(index)}`, timeoutMs: 60_000 },
        reply,
        source,
      );
    };
    info("held");

    // Each frame has its own cap of 4 waiting requests, and all frames share a cap of 100.
    const frame = {} as Window;
    ask(0, frame);
    for (let index = 1; index <= 10; index++) {
      ask(index, frame);
    }
    for (let index = 11; index <= BUS_MAX_FLUSH_REQUESTS + 50; index++) {
      ask(index, {} as Window);
    }
    await settle();
    expect(flushes).toHaveBeenCalledTimes(1);
    expect(getDiagnosticCounters()["bus.rejected_message"]).toBe(6 + 44);

    answers[0](200);
    await vi.waitFor(
      () => {
        expect(flushAnswers(reply)).toHaveLength(BUS_MAX_FLUSH_REQUESTS + 1);
      },
      { timeout: 3000 },
    );

    // The first request's flush saw the record. The queued requests share one flush after it.
    expect(flushes).toHaveBeenCalledTimes(2);
    const results = flushAnswers(reply).map((message) => (message as { result: unknown }).result);
    expect(results[0]).toEqual(result({ accepted: 1 }));
    expect(results.slice(1).every((one) => JSON.stringify(one) === JSON.stringify(result()))).toBe(
      true,
    );
  });
});
