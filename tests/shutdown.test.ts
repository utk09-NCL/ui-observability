// tests/shutdown.test.ts
//
// shutdown() stops the runtime. With `pending: "discard"` it sends nothing, reports each record
// in memory as "discarded", and late async work writes nothing. `clearStorage` also removes the
// stored batches and the stored ids.

import { afterEach, describe, expect, it, vi } from "vitest";
import { JOURNEY_STORAGE_KEY, SESSION_ID_KEY, TAB_ID_KEY } from "../src/constants";
import type { DiagnosticEvent } from "../src/core/diagnostics";
import { Diagnostics } from "../src/core/diagnostics";
import type { RotationHost } from "../src/core/rotation";
import { ObservabilityRuntime } from "../src/core/runtime";
import { Sender } from "../src/core/sender";
import type {
  ObservabilityConfig,
  ShutdownOptions,
  Transport,
  TransportRequest,
} from "../src/models/config";
import type { LogBatch } from "../src/models/batch";
import type { DropSummary } from "../src/models/drop";
import { saveToEmergencyQueue } from "../src/storage/emergency-queue";
import {
  addBreadcrumb,
  adoptJourney,
  collectDebugBundle,
  configure,
  counter,
  createMemoryTransport,
  debug,
  flush,
  getHealth,
  getJourneyToken,
  getLogger,
  info,
  profiler,
  rotateSecurityContext,
  setContext,
  shutdown,
  startJourney,
} from "../src/index";

/** Settings that keep a test away from storage, captures and the bus. */
const quiet = {
  serviceName: "shutdown",
  storage: { backend: "memory" as const },
  capture: { errors: false, rejections: false },
  bus: { mode: "off" as const },
};

/** The same, with the default bus mode, so startup waits for the bus role. */
const auto = { ...quiet, bus: { mode: "auto" as const } };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Builds a transport whose answer the test gives, so a request stays in flight until then.
 * @returns The transport, its requests and the function that answers the last request.
 */
function gatedTransport(): {
  transport: Transport;
  requests: TransportRequest[];
  answer: (status: number) => void;
} {
  const requests: TransportRequest[] = [];
  let answer: (status: number) => void = () => undefined;
  const transport: Transport = (request) => {
    requests.push(request);
    return new Promise((resolve) => {
      answer = (status) => {
        resolve({ status });
      };
    });
  };

  return {
    transport,
    requests,
    answer: (status) => {
      answer(status);
    },
  };
}

/**
 * Lists the library's keys in localStorage, for batches and for the emergency queue.
 * @returns The keys, sorted.
 */
function storedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = String(localStorage.key(i));
    if (
      key.startsWith("ui-observability.batch.") ||
      key.startsWith("ui-observability.emergency.")
    ) {
      keys.push(key);
    }
  }

  return keys.sort();
}

/** Waits for every chunk load, the startup and one timer turn. */
async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Collects onDrop summaries and diagnostic events for a config.
 * @returns The lists and the config keys that fill them.
 */
function reports(): {
  drops: DropSummary[];
  events: DiagnosticEvent[];
  hooks: Pick<ObservabilityConfig, "onDrop" | "onDiagnostic">;
} {
  const drops: DropSummary[] = [];
  const events: DiagnosticEvent[] = [];
  return {
    drops,
    events,
    hooks: {
      onDrop: (summary) => {
        drops.push(summary);
      },
      onDiagnostic: (event) => {
        events.push(event);
      },
    },
  };
}

/**
 * Builds an emergency queue entry, as an earlier page's exit flush writes it.
 * @param id Batch id.
 * @param context The batch's security context.
 * @returns The batch.
 */
function emergency(id: string, context: string): LogBatch {
  const batch: LogBatch = {
    id,
    createdAt: Date.now(),
    attempts: 0,
    routingContextId: context,
    records: [
      {
        body: id,
        severityText: "INFO",
        severityNumber: 9,
        timeUnixNano: `${String(Date.now())}000000`,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        traceFlags: 1,
        attributes: { "log.type": "log" },
        resource: {},
      },
    ],
  };
  saveToEmergencyQueue(batch, new Diagnostics());
  return batch;
}

/**
 * Stores one batch in localStorage under context A, as a failed send does.
 * @param over Settings layered over the stored config.
 */
async function storedInA(over: Partial<ObservabilityConfig> = {}): Promise<void> {
  const memory = createMemoryTransport();
  memory.respondWith(500);
  configure({
    ...quiet,
    storage: { backend: "localstorage" },
    transport: memory.transport,
    securityContext: { id: "A" },
    ...over,
  });
  await settle();
  info("stored in A");
  await flush();
}

/** The library's id keys in the two browser stores. */
function idKeys(): (string | null)[] {
  return [
    localStorage.getItem(SESSION_ID_KEY),
    sessionStorage.getItem(TAB_ID_KEY),
    sessionStorage.getItem(JOURNEY_STORAGE_KEY),
  ];
}

describe("shutdown() during startup", () => {
  it("reports a record held for the bus role when shutdown() comes before the startup ends", async () => {
    const drops: DropSummary[] = [];
    const memory = createMemoryTransport();
    configure({
      ...auto,
      transport: memory.transport,
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    info("held for the bus role");
    expect(ObservabilityRuntime.current()?.["ready"]).toBe(false);

    await shutdown();
    await settle();

    expect(memory.batches()).toEqual([]);
    expect(drops).toEqual([expect.objectContaining({ reason: "load_failed", records: 1 })]);
  });

  it("reports a held record when shutdown() stops a sender load that startup began", async () => {
    const drops: DropSummary[] = [];
    const memory = createMemoryTransport();
    configure({
      serviceName: "orders",
      transport: memory.transport,
      storage: { backend: "none" },
      bus: { mode: "off" },
      identity: "memory",
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    info("logged before shutdown");
    // With the bus off, startup has already begun the sender load, unlike the case above.
    expect(ObservabilityRuntime.current()?.["senderLoad"]).toBeDefined();

    await shutdown();
    await settle();

    expect(memory.batches()).toEqual([]);
    expect(drops).toEqual([expect.objectContaining({ reason: "load_failed", records: 1 })]);
  });
});

describe("shutdown() after the sender loads but before startup ends", () => {
  it("sends the startup records with the sender's last flush instead of reporting them", async () => {
    // An OpenFin journey read that hasn't answered keeps startup open after the sender loads.
    let answer: (options: unknown) => void = () => undefined;
    vi.stubGlobal("fin", {
      me: {
        getOptions: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      },
    });
    const { drops, hooks } = reports();
    const memory = createMemoryTransport();
    configure({
      ...quiet,
      storage: { backend: "none" },
      identity: "memory",
      transport: memory.transport,
      ...hooks,
    });
    info("logged during startup");
    const runtime = ObservabilityRuntime.current();
    await vi.waitFor(() => {
      expect(runtime?.["sender"]).toBeDefined();
    });
    expect(runtime?.["ready"]).toBe(false);

    await shutdown();
    answer({});
    await settle();

    expect(memory.records().map((record) => record.body)).toEqual(["logged during startup"]);
    expect(drops).toEqual([]);
  });
});

describe("shutdown() during a rotation", () => {
  it.each([
    ["carry", [expect.objectContaining({ reason: "security_context", records: 1 })], []],
    ["flush", [], ["held in A"]],
  ] as const)(
    "rejects a %s rotation whose new sender's load shutdown() stops, and reports only what is lost",
    async (pending, lost, sentToA) => {
      const { drops, hooks } = reports();
      const first = createMemoryTransport();
      const second = createMemoryTransport();
      configure({
        ...quiet,
        storage: { backend: "none" },
        identity: "memory",
        transport: first.transport,
        securityContext: { id: "A" },
        batching: { logFlushIntervalMs: 60_000 },
        ...hooks,
      });
      await flush();
      info("held in A");

      // Holds the new context's sender load, so shutdown() lands inside openDelivery().
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const create = Sender.create.bind(Sender);
      let loading = false;
      vi.spyOn(Sender, "create").mockImplementation(async (options) => {
        loading = true;
        await gate;
        return create(options);
      });
      const outcome = rotateSecurityContext(
        { id: "B", routing: { transport: second.transport } },
        { pending },
      ).then(
        () => "resolved",
        (error: unknown) => String(error),
      );
      await vi.waitFor(() => {
        expect(loading).toBe(true);
      });

      const stopping = shutdown();
      open();
      await stopping;
      await settle();

      expect(await outcome).toBe("Error: The runtime has stopped.");
      expect(second.batches()).toEqual([]);
      expect(first.records().map((record) => record.body)).toEqual(sentToA);
      expect(drops).toEqual(lost);
    },
  );

  it("removes the old context's stored batches when a clearStorage shutdown stops a carry", async () => {
    await storedInA();
    expect(storedKeys()).toHaveLength(1);

    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const create = Sender.create.bind(Sender);
    let loading = false;
    vi.spyOn(Sender, "create").mockImplementation(async (options) => {
      loading = true;
      await gate;
      return create(options);
    });
    const outcome = rotateSecurityContext(
      { id: "B", routing: { transport: createMemoryTransport().transport } },
      { pending: "carry" },
    ).then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    await vi.waitFor(() => {
      expect(loading).toBe(true);
    });

    // The rotation already moved the active id to B, so only the carried ids point at A's batch.
    const stopping = shutdown({ clearStorage: "context" });
    open();
    await stopping;

    expect(await outcome).toBe("Error: The runtime has stopped.");
    expect(storedKeys()).toEqual([]);
  });

  it("keeps the parked batches for clearStorage when the next sender load fails", async () => {
    await storedInA();
    configure({ enabled: false });
    const routing = { transport: createMemoryTransport().transport };
    await rotateSecurityContext({ id: "B", routing }, { pending: "carry" });
    expect(storedKeys()).toHaveLength(1);

    // The resume loads a sender for the parked batches, and that load fails.
    vi.spyOn(Sender, "create").mockRejectedValue(new Error("chunk failed"));
    configure({ enabled: true });
    await settle();
    await shutdown({ clearStorage: "context" });

    expect(storedKeys()).toEqual([]);
  });
});

describe("late async work after a discard", () => {
  it("stores and sends nothing when the delivery stack loads after the discard", async () => {
    emergency("late-a", "A");
    const memory = createMemoryTransport();
    configure({
      ...quiet,
      storage: { backend: "localstorage" },
      transport: memory.transport,
      securityContext: { id: "A" },
    });
    info("before the load");

    await shutdown({ pending: "discard", clearStorage: "context" });
    await settle();

    expect(storedKeys()).toEqual([]);
    expect(memory.batches()).toEqual([]);
  });

  it("stops a delivery stack that finishes its build after the discard, and sends nothing", async () => {
    emergency("late-a", "A");
    const memory = createMemoryTransport();
    const exit = vi.fn(() => true);
    const build = Sender.create.bind(Sender);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = vi.spyOn(Sender, "create").mockImplementation(async (deps) => {
      await gate;
      return build(deps);
    });
    configure({
      ...quiet,
      storage: { backend: "localstorage" },
      transport: memory.transport,
      transportOnExit: exit,
      securityContext: { id: "A" },
    });
    await vi.waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });

    const done = shutdown({ pending: "discard", clearStorage: "context" });
    release();
    await done;
    await settle();

    expect(memory.batches()).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
    expect(storedKeys()).toEqual([]);
  });

  it("sends nothing when the rotation code loads after the discard", async () => {
    const { drops, hooks } = reports();
    const before = createMemoryTransport();
    const after = createMemoryTransport();
    configure({
      ...quiet,
      ...hooks,
      transport: before.transport,
      securityContext: { id: "A" },
      batching: { logFlushIntervalMs: 60_000 },
    });
    await settle();
    info("old context");

    const rotation = rotateSecurityContext(
      { id: "B", routing: { transport: after.transport } },
      { pending: "flush" },
    );
    await shutdown({ pending: "discard" });

    await expect(rotation).rejects.toThrow("The runtime has stopped.");
    await settle();
    expect(before.batches()).toEqual([]);
    expect(after.batches()).toEqual([]);
    expect(drops).toEqual([expect.objectContaining({ reason: "discarded", records: 1 })]);
  });

  it("leaves the old context's storage alone when the rotation code runs after the discard", async () => {
    const { drops, hooks } = reports();
    await storedInA(hooks);
    const runtime = ObservabilityRuntime.current()!;
    const host = runtime["rotationHost"].bind(runtime);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const made = vi
      .spyOn(runtime as unknown as { rotationHost: () => RotationHost }, "rotationHost")
      .mockImplementation(() => ({ ...host(), senderLoaded: () => gate }));

    const rotation = rotateSecurityContext(
      { id: "B", routing: { transport: createMemoryTransport().transport } },
      { pending: "flush" },
    );
    await vi.waitFor(() => {
      expect(made).toHaveBeenCalledTimes(1);
    });
    const done = shutdown({ pending: "discard" });
    release();
    await done;

    await expect(rotation).rejects.toThrow("The runtime has stopped.");
    expect(storedKeys()).toHaveLength(1);
    expect(drops.map((summary) => summary.reason)).not.toContain("rejected");
  });

  it("installs nothing when a capture module loads after the discard", async () => {
    const native = console.warn;
    configure({ ...quiet, capture: { errors: false, rejections: false, console: true } });

    await shutdown({ pending: "discard" });
    await settle();

    expect(console.warn).toBe(native);
  });

  it("stops a replay upload in flight and schedules no retry", async () => {
    let fail: (error: Error) => void = () => undefined;
    const upload = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          fail = reject;
        }),
    );
    vi.stubGlobal("fetch", upload);
    const emits: ((event: unknown) => void)[] = [];
    const record = vi.fn((options: Record<string, unknown>) => {
      emits.push(options.emit as (event: unknown) => void);
      return vi.fn();
    });
    configure({
      ...quiet,
      transport: createMemoryTransport().transport,
      delivery: { retryBaseDelayMs: 0 },
      replay: {
        enabled: true,
        loader: () => Promise.resolve({ record: record as never }),
        endpoint: "https://replay.example/v1/replay",
        afterErrorMs: 0,
      },
    });
    await settle();
    emits[0]({ type: 4 });
    getLogger("app").error("failed", new Error("x"));
    await vi.waitFor(() => {
      expect(upload).toHaveBeenCalledTimes(1);
    });

    await shutdown({ pending: "discard" });
    fail(new Error("network"));
    await settle();
    await settle();

    expect(upload).toHaveBeenCalledTimes(1);
    expect((upload.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(
      true,
    );
  });

  it("stores nothing when a request in flight fails after the discard", async () => {
    const gate = gatedTransport();
    configure({
      ...quiet,
      storage: { backend: "localstorage" },
      transport: gate.transport,
      transportOnExit: () => true,
    });
    await settle();
    info("in flight");
    void flush();
    await vi.waitFor(() => {
      expect(gate.requests).toHaveLength(1);
    });

    const done = shutdown({ pending: "discard" });
    gate.answer(500);
    await done;
    await settle();

    expect(storedKeys()).toEqual([]);
  });
});

describe("shutdown() with pending discard", () => {
  it("sends nothing, runs no exit flush and reports each record in memory as discarded", async () => {
    const { drops, hooks } = reports();
    const memory = createMemoryTransport();
    const exit = vi.fn(() => true);
    configure({
      ...quiet,
      ...hooks,
      transport: memory.transport,
      transportOnExit: exit,
      batching: { logFlushIntervalMs: 60_000 },
    });
    await settle();
    info("first");
    getLogger("app").logAction("pay");

    await shutdown({ pending: "discard" });
    await settle();

    expect(memory.batches()).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
    expect(drops).toEqual([
      expect.objectContaining({ reason: "discarded", records: 2, actions: ["pay"] }),
    ]);
    expect((await getHealth()).delivery.dropped).toEqual({ discarded: 2 });
  });

  it("doesn't report a record in a request that is in flight, and its answer changes nothing", async () => {
    const { drops, hooks } = reports();
    const gate = gatedTransport();
    configure({
      ...quiet,
      ...hooks,
      transport: gate.transport,
      batching: { logFlushIntervalMs: 60_000 },
    });
    await settle();
    info("in flight");
    void flush();
    await vi.waitFor(() => {
      expect(gate.requests).toHaveLength(1);
    });
    info("buffered");

    await shutdown({ pending: "discard" });
    gate.answer(200);
    await settle();

    expect(gate.requests).toHaveLength(1);
    expect(gate.requests[0].signal?.aborted).toBe(true);
    expect(drops).toEqual([expect.objectContaining({ reason: "discarded", records: 1 })]);
    expect((await getHealth()).delivery.lastSendAt).toBeNull();
  });

  it("reports a record in a batch that waits for a free request slot", async () => {
    const { drops, hooks } = reports();
    const gate = gatedTransport();
    configure({
      ...quiet,
      ...hooks,
      transport: gate.transport,
      delivery: { maxConcurrentRequests: 1 },
      batching: { logFlushIntervalMs: 60_000 },
    });
    await settle();
    info("in flight");
    void flush();
    await vi.waitFor(() => {
      expect(gate.requests).toHaveLength(1);
    });
    info("queued");
    void flush();
    await Promise.resolve();
    info("buffered");

    await shutdown({ pending: "discard" });
    await settle();

    expect(gate.requests).toHaveLength(1);
    expect(drops).toEqual([expect.objectContaining({ reason: "discarded", records: 2 })]);
  });

  it("reports a record that waits for the bus role as discarded", async () => {
    const { drops, hooks } = reports();
    const memory = createMemoryTransport();
    configure({ ...auto, ...hooks, transport: memory.transport });
    info("held for the bus role");

    await shutdown({ pending: "discard" });
    await settle();

    expect(memory.batches()).toEqual([]);
    expect(drops).toEqual([expect.objectContaining({ reason: "discarded", records: 1 })]);
  });

  it("reports a record that an unconfigured runtime holds as discarded", async () => {
    info("before configure");
    const runtime = ObservabilityRuntime.current()!;

    await shutdown({ pending: "discard" });

    expect(runtime["bootBuffer"].length).toBe(0);
    expect(runtime.isDestroyed()).toBe(true);
  });

  it("builds no metric point, profiler point or root span for the open interval", async () => {
    const processor = vi.fn((record: unknown) => record);
    const memory = createMemoryTransport();
    configure({
      ...quiet,
      transport: memory.transport,
      tracesEndpoint: "https://x.example/v1/traces",
      processors: [processor as never],
      profiler: { enabled: true },
    });
    await settle();
    counter("orders").add(1);
    profiler.probe("grid.render").record(5);
    processor.mockClear();

    await shutdown({ pending: "discard" });
    await settle();

    expect(processor).not.toHaveBeenCalled();
    expect(memory.batches()).toEqual([]);
  });

  it("clears the trail, the context and the debug buffer that the stopped runtime keeps", async () => {
    configure({ ...quiet, minLevel: "INFO", debugBuffer: { enabled: true } });
    await settle();
    addBreadcrumb("opened the account page");
    setContext({ user: "previous" });
    debug("below the level");

    await shutdown({ pending: "discard" });

    const bundle = await collectDebugBundle();
    expect(bundle.breadcrumbs).toEqual([]);
    expect(bundle.debugBuffer).toEqual([]);
    expect(ObservabilityRuntime.stopped()?.context.getAll()).toEqual({});
  });

  it("reports a forwarder's staged records as discarded and gives none to the bus", async () => {
    const { drops, hooks } = reports();
    configure({ ...quiet, ...hooks, bus: { mode: "forwarder" } });
    await settle();
    const runtime = ObservabilityRuntime.current()!;
    const sent = vi.spyOn(runtime["bus"]!, "sendRecords");
    info("staged");

    await shutdown({ pending: "discard" });
    await settle();

    expect(sent).not.toHaveBeenCalled();
    expect(drops).toEqual([expect.objectContaining({ reason: "discarded", records: 1 })]);
  });

  it("reports a record once when a pagehide during a pause reported it first", async () => {
    const { drops, hooks } = reports();
    configure({
      ...quiet,
      ...hooks,
      transport: createMemoryTransport().transport,
      batching: { logFlushIntervalMs: 60_000 },
    });
    await settle();
    info("in memory");
    configure({ enabled: false });
    dispatchEvent(new Event("pagehide"));
    await settle();

    await shutdown({ pending: "discard" });
    await settle();

    expect(drops).toEqual([expect.objectContaining({ reason: "disabled", records: 1 })]);
  });

  it("stops a sender that a failed rotation parked, and keeps its stored batches", async () => {
    await storedInA();
    await expect(
      rotateSecurityContext({ id: "B", routing: { credentials: "all" as never } }),
    ).rejects.toThrow();

    await shutdown({ pending: "discard" });

    expect(storedKeys()).toHaveLength(1);
  });
});

describe("shutdown() with clearStorage", () => {
  it("removes the context's stored batches and emergency entries, and the stored ids", async () => {
    emergency("from-b", "B");
    await storedInA();
    emergency("late-a", "A");
    startJourney("checkout");
    expect(idKeys().every((value) => value !== null)).toBe(true);

    await shutdown({ pending: "discard", clearStorage: "context" });

    // Isolation is on, so the other context's entry stays.
    expect(storedKeys()).toEqual([expect.stringContaining("from-b")]);
    expect(idKeys()).toEqual([null, null, null]);
  });

  it("removes every batch in the namespace with the namespace scope", async () => {
    emergency("from-b", "B");
    await storedInA();

    await shutdown({ clearStorage: "namespace" });

    expect(storedKeys()).toEqual([]);
  });

  it("removes the parked sender's batches after a failed rotation", async () => {
    await storedInA();
    await expect(
      rotateSecurityContext({ id: "B", routing: { credentials: "all" as never } }),
    ).rejects.toThrow();

    await shutdown({ clearStorage: "context" });

    expect(storedKeys()).toEqual([]);
  });

  it("removes nothing before the first configure() call, because no store is known", async () => {
    await storedInA();
    await shutdown();
    // A new page: no stopped runtime takes the next log call.
    Reflect.deleteProperty(globalThis, Symbol.for("ui-observability.stopped"));
    const before = [...storedKeys(), ...idKeys()];
    info("before configure");
    const unconfigured = ObservabilityRuntime.current();
    expect((await getHealth()).status).toBe("unconfigured");

    await shutdown({ pending: "discard", clearStorage: "namespace" });

    expect(unconfigured?.isDestroyed()).toBe(true);
    expect(before).toHaveLength(4);
    expect([...storedKeys(), ...idKeys()]).toEqual(before);
  });

  it("removes the stored batches and ids of an earlier page during a first-call pause", async () => {
    await storedInA();
    await shutdown();
    expect(storedKeys()).toHaveLength(1);
    expect(localStorage.getItem(SESSION_ID_KEY)).not.toBeNull();

    configure({
      ...quiet,
      storage: { backend: "localstorage" },
      transport: createMemoryTransport().transport,
      securityContext: { id: "A" },
      enabled: false,
    });
    await shutdown({ pending: "discard", clearStorage: "context" });

    expect(storedKeys()).toEqual([]);
    expect(idKeys()).toEqual([null, null, null]);
  });

  it("keeps the ids in memory alone with identity memory", async () => {
    localStorage.setItem(SESSION_ID_KEY, "an earlier page's session");
    configure({ ...quiet, identity: "memory" });
    await settle();

    await shutdown({ clearStorage: "context" });

    expect(localStorage.getItem(SESSION_ID_KEY)).toBe("an earlier page's session");
  });

  it("reports a storage that throws and still stops", async () => {
    const { events, hooks } = reports();
    configure({ ...quiet, ...hooks, storage: { backend: "localstorage" } });
    await settle();
    // happy-dom's Storage is a Proxy, so a spy on its prototype never runs.
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    await shutdown({ clearStorage: "namespace" });

    expect(events.map((event) => event.message)).toContain(
      "The library could not remove ui-observability.tab from sessionStorage.",
    );
    expect(ObservabilityRuntime.stopped()?.isDestroyed()).toBe(true);
  });
});

describe("the shutdown() options", () => {
  /** Text of the report for options the library can't use. */
  const INVALID =
    'shutdown() got invalid options. The library discards the records in memory. An invalid clearStorage removes the "context" scope.';

  it.each<[string, unknown, boolean, boolean]>([
    ["no options", undefined, false, true],
    ["an empty object", {}, false, true],
    ['pending "flush"', { pending: "flush" }, false, true],
    ['pending "discard"', { pending: "discard" }, false, false],
    ["an unknown pending value", { pending: "later" }, true, false],
    ['clearStorage "context"', { clearStorage: "context" }, false, false],
    ['clearStorage "namespace"', { clearStorage: "namespace" }, false, false],
    ["an unknown clearStorage value", { clearStorage: "all" }, true, false],
    ["clearStorage null", { clearStorage: null }, false, true],
    ["null options", null, false, true],
    ["a string", "discard", true, false],
    [
      'pending "flush" with clearStorage',
      { pending: "flush", clearStorage: "context" },
      true,
      false,
    ],
  ])("reads %s", async (_label, options, invalid, sends) => {
    const { events, hooks } = reports();
    const memory = createMemoryTransport();
    configure({
      ...quiet,
      ...hooks,
      transport: memory.transport,
      transportOnExit: () => true,
      batching: { logFlushIntervalMs: 60_000 },
    });
    await settle();
    info("waits");

    await shutdown(options as ShutdownOptions);

    expect(events.some((event) => event.message === INVALID)).toBe(invalid);
    expect(memory.records().length > 0).toBe(sends);
  });

  it("clears the context scope for an unknown clearStorage value", async () => {
    await storedInA();

    await shutdown({ clearStorage: "all" as never });

    expect(storedKeys()).toEqual([]);
  });

  it("discards and removes no storage when the options can't be read", async () => {
    const { events, hooks } = reports();
    await storedInA(hooks);
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("trap");
        },
      },
    );

    await shutdown(hostile);

    expect(events.map((event) => event.message)).toContain(INVALID);
    expect(storedKeys()).toHaveLength(1);
  });
});

describe("review fixes", () => {
  it("removes the batches that a carry during a pause left under the older context", async () => {
    await storedInA();
    configure({ enabled: false });
    await rotateSecurityContext(
      { id: "B", routing: { transport: createMemoryTransport().transport } },
      { pending: "carry" },
    );
    expect(storedKeys()).toHaveLength(1);

    await shutdown({ pending: "discard", clearStorage: "context" });

    expect(storedKeys()).toEqual([]);
  });

  it.each<[string, ShutdownOptions | undefined]>([
    ["a discard", { pending: "discard" }],
    ["a flush", undefined],
  ])(
    "reports the records a rotation's retire took when %s shutdown stops it",
    async (_label, options) => {
      const { drops, hooks } = reports();
      const gate = gatedTransport();
      configure({
        ...quiet,
        ...hooks,
        transport: gate.transport,
        securityContext: { id: "A" },
        batching: { logFlushIntervalMs: 60_000 },
      });
      await settle();
      info("in flight");
      void flush();
      await vi.waitFor(() => {
        expect(gate.requests).toHaveLength(1);
      });
      info("buffered");

      const rotation = rotateSecurityContext(
        { id: "B", routing: { transport: createMemoryTransport().transport } },
        { pending: "flush", timeoutMs: 50 },
      );
      await vi.waitFor(() => {
        expect(gate.requests).toHaveLength(2);
      });
      await shutdown(options);

      await expect(rotation).rejects.toThrow("The runtime has stopped.");
      await settle();
      expect(drops).toContainEqual(
        expect.objectContaining({ reason: "security_context", records: 2 }),
      );
    },
  );

  it.each<[string, "discard" | "flush" | "retain" | "carry", number, number]>([
    ["discard", "discard", 2, 0],
    ["flush", "flush", 0, 0],
    ["retain", "retain", 0, 2],
    ["carry", "carry", 1, 1],
  ])(
    "reports what a %s rotation loses when a shutdown starts before its retire",
    async (_label, pending, lost, kept) => {
      const { drops, hooks } = reports();
      const memory = createMemoryTransport();
      configure({
        ...quiet,
        ...hooks,
        storage: { backend: "localstorage" },
        transport: memory.transport,
        securityContext: { id: "A" },
        batching: { logFlushIntervalMs: 60_000 },
      });
      await settle();
      memory.respondWith(500);
      info("stored");
      await flush();
      memory.respondWith(200);
      info("buffered");
      const runtime = ObservabilityRuntime.current()!;
      const host = runtime["rotationHost"].bind(runtime);
      let stopping: Promise<void> | undefined;
      vi.spyOn(
        runtime as unknown as { rotationHost: () => RotationHost },
        "rotationHost",
      ).mockImplementation(() => {
        const real = host();
        return {
          ...real,
          takeOld: () => {
            const old = real.takeOld();
            stopping ??= shutdown({ pending: "discard" });
            return old;
          },
        };
      });

      const rotation = rotateSecurityContext(
        { id: "B", routing: { transport: createMemoryTransport().transport } },
        { pending },
      );

      await expect(rotation).rejects.toThrow("The runtime has stopped.");
      await stopping;
      await settle();
      const reported = drops.filter((summary) => summary.reason === "security_context");
      expect(reported.reduce((total, summary) => total + summary.records, 0)).toBe(lost);
      expect(storedKeys()).toHaveLength(kept);
    },
  );

  it("stops a rotation with no old sender that a shutdown meets in its storage step", async () => {
    await storedInA();
    configure({ enabled: false });
    const routing = { transport: createMemoryTransport().transport };
    await rotateSecurityContext({ id: "B", routing }, { pending: "carry" });
    const runtime = ObservabilityRuntime.current()!;
    const host = runtime["rotationHost"].bind(runtime);
    let stopping: Promise<void> | undefined;
    vi.spyOn(
      runtime as unknown as { rotationHost: () => RotationHost },
      "rotationHost",
    ).mockImplementation(() => {
      const real = host();
      return {
        ...real,
        storeAccess: () => {
          stopping ??= shutdown({ pending: "discard", clearStorage: "context" });
          return real.storeAccess();
        },
      };
    });

    const rotation = rotateSecurityContext({ id: "C", routing }, { pending: "retain" });

    await expect(rotation).rejects.toThrow("The runtime has stopped.");
    await stopping;
    expect(runtime.config.securityContext.id).toBe("B");
    expect(storedKeys()).toEqual([]);
  });

  it("keeps the carried batches for clearStorage when a shutdown stops a rotation at its retire", async () => {
    await storedInA();
    configure({ enabled: false });
    const routing = { transport: createMemoryTransport().transport };
    await rotateSecurityContext({ id: "B", routing }, { pending: "carry" });
    const runtime = ObservabilityRuntime.current()!;
    const host = runtime["rotationHost"].bind(runtime);
    let stopping: Promise<void> | undefined;
    vi.spyOn(
      runtime as unknown as { rotationHost: () => RotationHost },
      "rotationHost",
    ).mockImplementation(() => {
      const real = host();
      return {
        ...real,
        takeOld: () => {
          const old = real.takeOld();
          stopping ??= shutdown({ pending: "discard", clearStorage: "context" });
          return old;
        },
      };
    });

    const rotation = rotateSecurityContext({ id: "C", routing }, { pending: "discard" });

    await expect(rotation).rejects.toThrow("The runtime has stopped.");
    await stopping;
    expect(storedKeys()).toEqual([]);
  });

  it("forgets the journey in memory at a discard, and keeps the stored one", async () => {
    configure({ ...quiet, storage: { backend: "localstorage" } });
    await settle();
    startJourney("checkout");
    expect(getJourneyToken()).not.toBeNull();

    await shutdown({ pending: "discard" });

    expect(getJourneyToken()).toBeNull();
    expect(sessionStorage.getItem(JOURNEY_STORAGE_KEY)).not.toBeNull();
  });

  it("removes the stored data at a clearStorage shutdown after an earlier shutdown", async () => {
    await storedInA();
    await shutdown();
    expect(storedKeys()).toHaveLength(1);

    await shutdown({ pending: "discard", clearStorage: "context" });

    expect(storedKeys()).toEqual([]);
    expect(idKeys()).toEqual([null, null, null]);
  });

  it("removes the data only after the first shutdown's late save lands", async () => {
    const gate = gatedTransport();
    configure({
      ...quiet,
      storage: { backend: "localstorage" },
      transport: gate.transport,
      batching: { logFlushIntervalMs: 60_000 },
    });
    await settle();
    info("fails late");
    void flush();
    await vi.waitFor(() => {
      expect(gate.requests).toHaveLength(1);
    });

    const first = shutdown();
    const second = shutdown({ pending: "discard", clearStorage: "context" });
    gate.answer(500);
    await Promise.all([first, second]);

    expect(storedKeys()).toEqual([]);
  });

  it("writes no journey to sessionStorage after shutdown()", async () => {
    configure({ ...quiet, storage: { backend: "localstorage" } });
    await settle();
    startJourney("before");
    const token = getJourneyToken()!;
    await shutdown();
    sessionStorage.clear();

    startJourney("after");
    adoptJourney(token);

    expect(sessionStorage.getItem(JOURNEY_STORAGE_KEY)).toBeNull();
  });
});
