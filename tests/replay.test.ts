// tests/replay.test.ts
//
// Tests for the session replay capture, using a fake recorder. The fake keeps the options the
// capture passed in, and a test calls its emit function the way the real recorder would.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayCapture } from "../src/capture/replay";
import type { CaptureContext, CaptureOnce } from "../src/capture/types";
import { BreadcrumbBuffer } from "../src/core/breadcrumbs";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { ObservabilityConfig, ReplayOptions } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";
import type { ReplayPluginTools, ReplayRecord, ReplaySegment } from "../src/models/replay";
import { runAsLibraryRequest } from "../src/utils/library-request";
import { TraceEngine } from "../src/utils/tracing";

/** The options the capture passed to the recorder. */
interface RecordOptions {
  emit: (event: unknown, isCheckout?: boolean) => void;
  checkoutEveryNms: number;
  maskAllInputs: boolean;
  maskInputOptions: unknown;
  maskInputFn: (text: string) => string;
  maskTextSelector: string | undefined;
  maskTextFn: (text: string, element: Element | null) => string;
  blockSelector: string | undefined;
  recordCanvas: boolean;
  errorHandler: (error: unknown) => void;
  plugins: unknown[];
  sampling?: unknown;
}

/** The `once` flags of a fresh document. */
const freshOnce = (): CaptureOnce => ({
  webVitals: false,
  navigationTiming: false,
  longFrames: false,
  uncleanExit: false,
  userTiming: false,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Builds a fake for the recorder's record function.
 * @param withSnapshot Pass false for a recorder without takeFullSnapshot.
 * @returns The record function, its calls and its stop function.
 */
function fakeRecorder(withSnapshot = true) {
  const calls: RecordOptions[] = [];
  const stop = vi.fn();
  const record = vi.fn((options: Record<string, unknown>) => {
    calls.push(options as unknown as RecordOptions);
    return stop;
  }) as unknown as ReplayRecord & ReturnType<typeof vi.fn>;

  if (withSnapshot) {
    // The real recorder sends a meta event and a snapshot, both flagged as checkout.
    record.takeFullSnapshot = vi.fn((isCheckout?: boolean) => {
      calls.at(-1)?.emit({ type: 4, data: "meta" }, isCheckout);
      calls.at(-1)?.emit({ type: 2, data: "full" }, isCheckout);
    });
  }

  return { record, calls, stop };
}

/**
 * Builds a capture wired to a fake recorder and a list that collects the segments.
 * @param replay Replay settings for the test.
 * @param over Other settings and parts for the test.
 * @returns The capture and everything it writes to.
 */
function setup(
  replay: Partial<ReplayOptions> = {},
  over: {
    config?: Partial<ObservabilityConfig>;
    once?: CaptureOnce;
    consent?: boolean;
    recorder?: ReturnType<typeof fakeRecorder>;
  } = {},
) {
  vi.useFakeTimers();
  const events: DiagnosticEvent[] = [];
  const segments: ReplaySegment[] = [];
  const context = new Map<string, string>();
  const state: { hook: ((record: LogRecord) => void) | undefined } = { hook: undefined };
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const recorder = over.recorder ?? fakeRecorder();
  const ctx: CaptureContext = {
    config: resolveConfig(
      {
        endpoint: null,
        serviceName: "blotter",
        replay: {
          enabled: true,
          loader: () => Promise.resolve({ record: recorder.record }),
          onSegment: (segment) => {
            segments.push(segment);
          },
          ...replay,
        },
        ...over.config,
      },
      diagnostics,
    ),
    diagnostics,
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      logEvent: vi.fn(),
      logMetric: vi.fn(),
      debug: vi.fn(),
    },
    breadcrumbs: new BreadcrumbBuffer(50),
    tracing: new TraceEngine(diagnostics),
    once: over.once ?? freshOnce(),
    recordMetric: vi.fn(),
    recordSpan: vi.fn(),
    sessionId: () => "session",
    onError: (hook) => {
      state.hook = hook;
    },
    setContext: (key, value) => {
      if (value === undefined) {
        context.delete(key);
      } else {
        context.set(key, value);
      }
    },
    replayConsent: () => over.consent,
  };
  events.length = 0;
  const sut = new ReplayCapture(ctx);

  /** Installs the capture and waits for the recorder to load. */
  const run = async (): Promise<RecordOptions> => {
    sut.install();
    await vi.advanceTimersByTimeAsync(0);
    return recorder.calls[0];
  };

  /** Feeds an ERROR record to the capture's hook. */
  const fail = (resource: Record<string, unknown> = { "session.id": "s-1", "tab.id": "t-1" }) => {
    state.hook?.({ severityText: "ERROR", resource } as unknown as LogRecord);
  };

  return { sut, ctx, events, segments, context, state, recorder, run, fail };
}

/** Reduces each event to its code and message. */
const reports = (events: DiagnosticEvent[]): [string, string][] =>
  events.map(({ code, message }) => [code, message]);

/** Parses the events out of each segment. */
const sent = (segments: ReplaySegment[]): unknown[][] =>
  segments.map((segment) => JSON.parse(segment.payload) as unknown[]);

describe("start of the recorder", () => {
  it("starts the recorder at install with the privacy options of the library", async () => {
    const { run, recorder, events } = setup({
      recordOptions: { sampling: { mousemove: false }, slimDOMOptions: "all" },
    });

    const options = await run();

    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(options).toMatchObject({
      checkoutEveryNms: 30_000,
      // The per-element list masks every input type, hidden and file inputs included.
      maskAllInputs: false,
      maskInputOptions: { input: true, textarea: true, select: true },
      maskTextSelector: "*",
      blockSelector: "[data-observability-ignore]",
      recordCanvas: false,
      plugins: [],
      sampling: { mousemove: false },
      slimDOMOptions: "all",
    });
    expect(events).toEqual([]);
  });

  it("ignores each key of recordOptions that can turn off a privacy option, and reports them", async () => {
    const emit = vi.fn();
    const { run, events } = setup({
      recordOptions: {
        sampling: { scroll: 150 },
        maskAllInputs: true,
        maskInputFn: (text: string) => text,
        maskTextFn: (text: string) => text,
        recordCanvas: true,
        inlineImages: true,
        recordCrossOriginIframes: true,
        packFn: (event: unknown) => String(event),
        emit,
        plugins: [{ name: "app" }],
      },
    });

    const options = await run();

    expect(options).toMatchObject({ sampling: { scroll: 150 }, recordCanvas: false, plugins: [] });
    expect(options).not.toHaveProperty("inlineImages");
    expect(options).not.toHaveProperty("recordCrossOriginIframes");
    expect(options).not.toHaveProperty("packFn");
    expect(options.emit).not.toBe(emit);
    expect(options.maskInputFn("4711")).toBe("********");
    expect(reports(events)).toEqual([
      [
        "config.invalid",
        "The library ignores these keys of replay.recordOptions: maskAllInputs, maskInputFn, maskTextFn, recordCanvas, inlineImages, recordCrossOriginIframes, packFn, emit, plugins. It sets the mask, block, canvas, plugin and event options itself.",
      ],
    ]);
  });

  it("passes the app's settings to the recorder", async () => {
    const { run } = setup({
      bufferMs: 10_000,
      maskText: false,
      maskInputs: false,
      recordCanvas: true,
      maskSelectors: [".account", "#name"],
      blockSelectors: ["#blotter", ".chart"],
    });

    expect(await run()).toMatchObject({
      checkoutEveryNms: 5000,
      maskAllInputs: false,
      // Password inputs stay masked even with maskInputs off.
      maskInputOptions: { password: true },
      maskTextSelector: ".account,#name",
      blockSelector: "[data-observability-ignore],#blotter,.chart",
      recordCanvas: true,
    });
  });

  it("always blocks the elements that click capture ignores, with or without blockSelectors", async () => {
    const plain = setup();
    expect((await plain.run()).blockSelector).toBe("[data-observability-ignore]");

    const listed = setup({ blockSelectors: ["#blotter"] });
    expect((await listed.run()).blockSelector).toBe("[data-observability-ignore],#blotter");
  });

  it("masks an input value with a text of a fixed length, and keeps an empty value", async () => {
    const { run } = setup();
    const { maskInputFn } = await run();

    // The length of a PIN must not leak.
    expect(maskInputFn("1234")).toBe("********");
    expect(maskInputFn("a long account name")).toBe("********");
    expect(maskInputFn("")).toBe("");
  });

  it("passes no mask selector with maskText off and no mask list", async () => {
    const { run } = setup({ maskText: false });

    expect((await run()).maskTextSelector).toBeUndefined();
  });

  it("starts the recorder with a replay id when the browser has no crypto.randomUUID", async () => {
    // Chrome 85 to 91, Firefox 79 to 94, Safari 14.1 to 15.3 and any plain http page lack it.
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    const { run, context, events } = setup();

    await run();

    expect(context.get("replay.id")).toMatch(/^[0-9a-f]{32}$/);
    expect(reports(events)).toEqual([]);
  });

  it("sets the replay id as an ambient attribute while the recorder runs", async () => {
    const { sut, run, context } = setup();

    await run();
    const id = context.get("replay.id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    sut.uninstall();
    expect(context.has("replay.id")).toBe(false);
  });

  it("starts one recorder for two install calls and two start calls", async () => {
    const { sut, run, recorder } = setup();

    sut.install();
    void sut.start();
    await run();
    await sut.start();

    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it("waits for startReplay() with requireConsent", async () => {
    const { sut, run, recorder } = setup({ requireConsent: true });

    await run();
    expect(recorder.record).not.toHaveBeenCalled();

    await sut.start();
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it("starts at install with requireConsent when the app gave consent before", async () => {
    const { run, recorder } = setup({ requireConsent: true }, { consent: true });

    await run();

    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it("stays off at a new install after the app called stopReplay()", async () => {
    const { run, recorder } = setup({}, { consent: false });

    await run();

    // Reinstalling the captures must not restart a recorder the user stopped.
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it("reports a recorder that gives no stop function and stays off", async () => {
    const recorder = fakeRecorder();
    // The recorder swallows errors from its own startup and returns undefined.
    recorder.record.mockImplementation(() => undefined);
    const { sut, run, fail, events, segments, context } = setup({}, { recorder });

    await run();
    fail();
    sut.uninstall();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(reports(events)).toEqual([
      ["capture.install_failed", "The replay recorder did not start."],
    ]);
    expect(segments).toEqual([]);
    expect(context.has("replay.id")).toBe(false);
  });

  it("starts a new recording with a new id at reset(), and drops the buffer", async () => {
    const { sut, run, fail, segments, recorder, context } = setup({ afterErrorMs: 0 });
    const { emit } = await run();
    const first = context.get("replay.id");

    emit({ type: 4 });
    emit({ type: 2, data: "page of the first user" });
    sut.reset();
    await vi.advanceTimersByTimeAsync(0);

    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledTimes(2);
    expect(context.get("replay.id")).not.toBe(first);

    recorder.calls[1].emit({ type: 4 });
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent(segments)).toEqual([[{ type: 4 }]]);
  });

  it("starts no recorder at reset() while the recorder does not run", async () => {
    const { sut, run, recorder } = setup({ requireConsent: true });

    await run();
    sut.reset();
    await vi.advanceTimersByTimeAsync(0);

    expect(recorder.record).not.toHaveBeenCalled();
  });

  it("starts the recorder at a reset() during the load", async () => {
    const { sut, recorder } = setup();

    sut.install();
    sut.reset();
    await vi.advanceTimersByTimeAsync(0);

    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it("does not start before install and after uninstall", async () => {
    const { sut, recorder } = setup();

    await sut.start();
    sut.install();
    sut.uninstall();
    await sut.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(recorder.record).not.toHaveBeenCalled();
  });

  it("starts no recorder when a stop comes during the load", async () => {
    let open: (value: { record: ReplayRecord }) => void = () => undefined;
    const recorder = fakeRecorder();
    const { sut, context } = setup(
      {
        loader: () =>
          new Promise((resolve) => {
            open = resolve;
          }),
      },
      { recorder },
    );

    sut.install();
    sut.stop();
    open({ record: recorder.record });
    await vi.advanceTimersByTimeAsync(0);

    expect(recorder.record).not.toHaveBeenCalled();
    expect(context.has("replay.id")).toBe(false);

    // A later start loads again, and this time it runs.
    void sut.start();
    open({ record: recorder.record });
    await vi.advanceTimersByTimeAsync(0);
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<ReplayOptions>]>([
    ["no loader", { loader: null }],
    ["no endpoint and no segment function", { onSegment: null }],
  ])("reports %s and stays off", async (_label, replay) => {
    const { run, recorder, events } = setup(replay);

    await run();

    expect(recorder.record).not.toHaveBeenCalled();
    expect(reports(events)).toEqual([
      [
        "config.invalid",
        "The session replay needs replay.loader, and replay.endpoint or replay.onSegment. The session replay is off.",
      ],
    ]);
  });

  it("starts with an endpoint and no segment function", async () => {
    const { run, recorder } = setup({ onSegment: null, endpoint: "https://replay.example/r" });

    await run();

    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it("reports once per document in a context with no document", async () => {
    const once = freshOnce();
    const first = setup({}, { once });
    const second = setup({}, { once });
    vi.stubGlobal("document", undefined);

    await first.run();
    await second.run();

    expect(first.recorder.record).not.toHaveBeenCalled();
    expect(reports([...first.events, ...second.events])).toEqual([
      ["capture.install_failed", "This context has no document. The session replay is off."],
    ]);
  });

  it.each<[string, Partial<ReplayOptions>]>([
    ["mask", { maskSelectors: [".ok", "div["] }],
    ["block", { blockSelectors: ["div["] }],
  ])("stays off for a %s selector that is not valid", async (_label, replay) => {
    const { run, recorder, events } = setup(replay);

    await run();

    // A replay with a missing mask would show text the app meant to hide.
    expect(recorder.record).not.toHaveBeenCalled();
    expect(reports(events)).toEqual([
      [
        "config.invalid",
        "The replay selector div[ is not a valid CSS selector. The session replay is off.",
      ],
    ]);
    expect(events[0].cause).toBeInstanceOf(Error);
  });

  it("reports a loader that rejects, once", async () => {
    const error = new Error("chunk not found");
    const { run, recorder, events } = setup({ loader: () => Promise.reject(error) });

    await run();

    expect(recorder.record).not.toHaveBeenCalled();
    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      ["capture.install_failed", "The library could not load the replay recorder.", error],
    ]);
  });

  it("reports a loader that gives no record function", async () => {
    const { run, events } = setup({
      loader: () => Promise.resolve({} as { record: ReplayRecord }),
    });

    await run();

    expect(reports(events)).toEqual([
      [
        "capture.install_failed",
        "The replay loader gave no record function. The session replay is off.",
      ],
    ]);
  });

  it("reports a recorder that throws at its start and stays off", async () => {
    const error = new Error("no MutationObserver");
    const recorder = fakeRecorder();
    recorder.record.mockImplementation(() => {
      throw error;
    });
    const { run, fail, events, segments, context } = setup({}, { recorder });

    await run();
    fail();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      ["capture.install_failed", "The replay recorder did not start.", error],
    ]);
    expect(segments).toEqual([]);
    expect(context.has("replay.id")).toBe(false);
  });

  it("stops the recorder at uninstall and reports a stop function that throws", async () => {
    const error = new Error("already stopped");
    const { sut, run, recorder, state, events } = setup();

    await run();
    recorder.stop.mockImplementation(() => {
      throw error;
    });
    sut.uninstall();
    sut.uninstall();

    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(state.hook).toBeUndefined();
    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      ["capture.install_failed", "The replay recorder did not stop.", error],
    ]);
  });
});

describe("plugins", () => {
  it("passes each loader's plugin to the recorder", async () => {
    const seen: ReplayPluginTools[] = [];
    const { run } = setup({
      plugins: [
        (tools) => {
          seen.push(tools);
          return { name: "sync" };
        },
        () => Promise.resolve({ name: "async" }),
      ],
    });

    const options = await run();

    expect(options.plugins).toEqual([{ name: "sync" }, { name: "async" }]);
    expect(typeof seen[0].transformRequest).toBe("function");
  });

  it("reports a plugin loader that throws and starts with the other plugins", async () => {
    const error = new Error("plugin not found");
    const { run, events } = setup({
      plugins: [
        () => {
          throw error;
        },
        () => ({ name: "good" }),
      ],
    });

    const options = await run();

    expect(options.plugins).toEqual([{ name: "good" }]);
    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      ["capture.install_failed", "The library could not load a replay plugin.", error],
    ]);
  });

  /**
   * Starts a capture and returns the request helper its plugin loader was given.
   * @param replay Replay settings for the test.
   * @param config Other settings for the test.
   * @returns The helper and the events.
   */
  async function requestTool(
    replay: Partial<ReplayOptions> = {},
    config: Partial<ObservabilityConfig> = {},
  ) {
    let tool: ReplayPluginTools["transformRequest"] | undefined;
    const harness = setup(
      {
        plugins: [
          (tools) => {
            tool = tools.transformRequest;
            return {};
          },
        ],
        ...replay,
      },
      { config },
    );
    await harness.run();

    return { transform: tool!, events: harness.events };
  }

  it("removes the query and the fragment of a request URL", async () => {
    const { transform } = await requestTool();

    expect(
      transform({ name: "https://api.example/orders?token=secret#top", method: "GET" }),
    ).toEqual({ name: "https://api.example/orders", method: "GET" });
  });

  it("keeps the full URL with capture.fullUrls", async () => {
    const { transform } = await requestTool({}, { capture: { fullUrls: true } });
    const request = { name: "https://api.example/orders?page=2" };

    expect(transform(request)).toBe(request);
  });

  it("skips a request to each endpoint of the library, also outside a library request scope", async () => {
    const { transform } = await requestTool(
      { endpoint: "https://replay.example/v1/replay" },
      { endpoint: "https://ingest.example/v1/logs", capture: { ignoreUrls: ["/health"] } },
    );

    // The network plugin calls the helper after the request, when no library-request scope is open.
    expect(transform({ name: "https://replay.example/v1/replay?x=1" })).toBeUndefined();
    expect(transform({ name: "https://ingest.example/v1/logs" })).toBeUndefined();
    expect(transform({ name: "https://api.example/health" })).toBeUndefined();
    expect(transform({ name: "https://api.example/orders" })).toEqual({
      name: "https://api.example/orders",
    });
  });

  it("skips a request in a library request scope", async () => {
    const { transform } = await requestTool();

    expect(
      runAsLibraryRequest(() => transform({ name: "https://api.example/orders" })),
    ).toBeUndefined();
  });

  it("skips a request that it cannot read and reports it, with no throw", async () => {
    const { transform, events } = await requestTool();

    // The plugin calls the helper inside its fetch wrapper, where a throw could break the request.
    expect(transform({ name: 5 as unknown as string })).toBeUndefined();
    expect(reports(events)).toEqual([
      ["capture.record_failed", "The replay recorder had an error."],
    ]);
  });
});

describe("masking", () => {
  /**
   * Builds elements for the mask function.
   * @returns A plain element, an unmasked element with a child, and a force-masked element in it.
   */
  function page() {
    const plain = document.createElement("p");
    const open = document.createElement("section");
    open.setAttribute("data-observability-unmask", "");
    const child = document.createElement("span");
    const forced = document.createElement("b");
    forced.className = "account";
    open.append(child, forced);

    return { plain, open, child, forced };
  }

  it("masks each character that is not a space, and keeps the text of an unmasked element", async () => {
    const { run } = setup();
    const { maskTextFn } = await run();
    const { plain, open, child } = page();

    expect(maskTextFn("Order 42\n for VOD", plain)).toBe("***** **\n *** ***");
    expect(maskTextFn("Order 42", null)).toBe("***** **");
    expect(maskTextFn("Order 42", open)).toBe("Order 42");
    expect(maskTextFn("Order 42", child)).toBe("Order 42");
  });

  it("masks the text of a mask selector inside an unmasked element", async () => {
    const { run } = setup({ maskSelectors: [".account"] });
    const { maskTextFn } = await run();
    const { child, forced } = page();

    expect(maskTextFn("GB29 NWBK", forced)).toBe("**** ****");
    expect(maskTextFn("Order 42", child)).toBe("Order 42");
  });

  it("masks each text that the recorder asks for with maskText off", async () => {
    const { run } = setup({ maskText: false, maskSelectors: [".account"] });
    const { maskTextFn } = await run();
    const { open, forced } = page();

    // With maskText off, the recorder only calls the function for text under a mask selector.
    expect(maskTextFn("GB29 NWBK", forced)).toBe("**** ****");
    expect(maskTextFn("Order 42", open)).toBe("***** **");
  });
});

describe("events that the recorder mask does not cover", () => {
  it("removes the query and the fragment of the page URL in a meta event", async () => {
    const { run, fail, segments } = setup({ afterErrorMs: 0 });
    const { emit } = await run();

    emit({ type: 4, data: { href: "https://app.example/orders?token=secret#top", width: 800 } });
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent(segments)[0]).toEqual([
      { type: 4, data: { href: "https://app.example/orders", width: 800 } },
    ]);
  });

  it("keeps the full page URL with capture.fullUrls", async () => {
    const { run, fail, segments } = setup(
      { afterErrorMs: 0 },
      { config: { capture: { fullUrls: true } } },
    );
    const { emit } = await run();

    emit({ type: 4, data: { href: "https://app.example/orders?page=2" } });
    emit({ type: 4, data: {} });
    emit({ type: 4 });
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent(segments)[0]).toEqual([
      { type: 4, data: { href: "https://app.example/orders?page=2" } },
      { type: 4, data: {} },
      { type: 4 },
    ]);
  });

  /**
   * Builds a text node directly in a shadow root and a text node inside an element.
   * @param hostAttribute Attribute for the host element, if any.
   * @param hostClass Class for the host element.
   * @returns The nodes by recorder id: 1 is the shadow text, 2 is the element text.
   */
  function shadowPage(hostAttribute?: string, hostClass = "") {
    const host = document.createElement("div");
    host.className = hostClass;
    if (hostAttribute) {
      host.setAttribute(hostAttribute, "");
    }
    const root = host.attachShadow({ mode: "open" });
    const shadowText = document.createTextNode("x");
    root.append(shadowText);
    const paragraph = document.createElement("p");
    const elementText = document.createTextNode("y");
    paragraph.append(elementText);
    const nodes = new Map<number, Node>([
      [1, shadowText],
      [2, elementText],
    ]);

    return { getNode: (id: number): Node | null => nodes.get(id) ?? null };
  }

  /** A mutation event with a changed text and an added text node, for ids 1, 2 and 3. */
  const mutation = () => ({
    type: 3,
    data: {
      source: 0,
      texts: [
        { id: 1, value: "IBAN GB29" },
        { id: 2, value: "**** ****" },
        { id: 3, value: "no node" },
      ],
      adds: [
        { node: { id: 1, type: 3, textContent: "PIN 4711" } },
        { node: { id: 2, type: 3, textContent: "*** ****" } },
        { node: { id: 9, type: 2, tagName: "p" } },
        {},
      ],
    },
  });

  /**
   * Sends one mutation event through a capture and returns what got uploaded.
   * @param replay Replay settings for the test.
   * @param mirror The recorder's node lookup, or undefined for a recorder without one.
   * @returns The uploaded event, and the event object the recorder handed over.
   */
  async function scrubbed(
    replay: Partial<ReplayOptions>,
    mirror: { getNode: (id: number) => Node | null } | undefined,
  ) {
    const { run, fail, segments, recorder } = setup({ afterErrorMs: 0, ...replay });
    recorder.record.mirror = mirror;
    const { emit } = await run();
    const event = mutation();
    const added = event.data.adds[0].node;

    emit(event);
    fail();
    await vi.advanceTimersByTimeAsync(0);

    const [uploaded] = sent(segments)[0] as ReturnType<typeof mutation>[];
    return { uploaded, added };
  }

  it("masks a text that is directly in a shadow root, in a mutation", async () => {
    const { uploaded, added } = await scrubbed({}, shadowPage());

    // The recorder doesn't mask this text in a mutation. Text inside an element is masked earlier.
    expect(uploaded.data.texts).toEqual([
      { id: 1, value: "**** ****" },
      { id: 2, value: "**** ****" },
      { id: 3, value: "no node" },
    ]);
    expect(uploaded.data.adds[0].node).toEqual({ id: 1, type: 3, textContent: "*** ****" });
    expect(uploaded.data.adds[1].node).toEqual({ id: 2, type: 3, textContent: "*** ****" });
    // The recorder holds on to the node object, so the capture must not change it.
    expect(added).toEqual({ id: 1, type: 3, textContent: "PIN 4711" });
  });

  it("keeps the shadow root text of a host with the unmask attribute", async () => {
    const { uploaded } = await scrubbed({}, shadowPage("data-observability-unmask"));

    expect(uploaded.data.texts[0]).toEqual({ id: 1, value: "IBAN GB29" });
  });

  it("masks the shadow root text of a host in a mask selector with maskText off", async () => {
    const masked = await scrubbed(
      { maskText: false, maskSelectors: [".account"] },
      shadowPage("", "account"),
    );
    const open = await scrubbed({ maskText: false, maskSelectors: [".account"] }, shadowPage());
    const none = await scrubbed({ maskText: false }, shadowPage("", "account"));

    expect(masked.uploaded.data.texts[0]).toEqual({ id: 1, value: "**** ****" });
    expect(open.uploaded.data.texts[0]).toEqual({ id: 1, value: "IBAN GB29" });
    expect(none.uploaded.data.texts[0]).toEqual({ id: 1, value: "IBAN GB29" });
  });

  it("masks a text node that has no parent", async () => {
    const detached = document.createTextNode("x");
    const { uploaded } = await scrubbed({}, { getNode: () => detached });

    // The node left the page before the event, so the capture can't find an unmask element.
    expect(uploaded.data.texts[0]).toEqual({ id: 1, value: "**** ****" });
  });

  it("keeps each text with a recorder that has no node lookup", async () => {
    const { uploaded } = await scrubbed({}, undefined);

    expect(uploaded.data.texts[0]).toEqual({ id: 1, value: "IBAN GB29" });
  });

  it("changes no event of another type and no mutation with no text", async () => {
    const { run, fail, segments } = setup({ afterErrorMs: 0 });
    const { emit } = await run();
    const others = [
      { type: 3, data: { source: 2, texts: [{ id: 1, value: "kept" }] } },
      { type: 3, data: { source: 0 } },
      { type: 3, data: { source: 0, texts: [{ id: 1, value: 5 }] } },
      { type: 2, data: { href: "https://app.example/?a=1" } },
    ];

    for (const event of others) {
      emit(event);
    }
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent(segments)[0]).toEqual(others);
  });
});

describe("upload after an error", () => {
  it("keeps the events in memory and sends nothing with no error", async () => {
    const { run, segments } = setup();
    const { emit } = await run();

    emit({ type: 4 });
    emit({ type: 2 });
    emit({ type: 3, data: 1 });
    await vi.advanceTimersByTimeAsync(600_000);

    expect(segments).toEqual([]);
  });

  it("sends the buffer for an error record, with the ids of the record", async () => {
    const { run, fail, segments, context } = setup();
    const { emit } = await run();

    emit({ type: 4 });
    emit({ type: 2 });
    emit({ type: 3, data: 1 });
    fail({ "session.id": "s-9", "tab.id": "t-9" });
    await vi.advanceTimersByTimeAsync(2000);

    expect(sent(segments)).toEqual([[{ type: 4 }, { type: 2 }, { type: 3, data: 1 }]]);
    expect(segments[0]).toMatchObject({
      "replay.id": context.get("replay.id"),
      "session.id": "s-9",
      "tab.id": "t-9",
      sequence: 0,
    });
  });

  it("sends each event of the time after the error, then starts the buffer with a snapshot", async () => {
    const { run, fail, segments, recorder } = setup({ afterErrorMs: 5000, flushIntervalMs: 1000 });
    const { emit } = await run();

    emit({ type: 4 });
    emit({ type: 2 });
    fail();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent(segments)).toEqual([[{ type: 4 }, { type: 2 }]]);

    // An event within the 5 seconds after the error goes into the next segment.
    emit({ type: 3, data: "after" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent(segments)[1]).toEqual([{ type: 3, data: "after" }]);

    emit({ type: 3, data: "last" });
    await vi.advanceTimersByTimeAsync(2999);
    expect(recorder.record.takeFullSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    // The live period is over: the open segment closed, and a snapshot restarts the buffer.
    expect(sent(segments)[2]).toEqual([{ type: 3, data: "last" }]);
    expect(recorder.record.takeFullSnapshot).toHaveBeenCalledWith(true);

    emit({ type: 3, data: "buffered" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(segments).toHaveLength(3);

    // The next error sends the new buffer, which starts with the snapshot.
    fail();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent(segments)[3]).toEqual([
      { type: 4, data: "meta" },
      { type: 2, data: "full" },
      { type: 3, data: "buffered" },
    ]);
    expect(segments.map((segment) => segment.sequence)).toEqual([0, 1, 2, 3]);
  });

  it("does not extend the time after the error for a second error", async () => {
    const { run, fail, segments, recorder } = setup({ afterErrorMs: 5000 });
    const { emit } = await run();

    emit({ type: 4 });
    fail({ "session.id": "s-1", "tab.id": "t-1" });
    await vi.advanceTimersByTimeAsync(4000);
    fail({ "session.id": "s-2", "tab.id": "t-2" });
    await vi.advanceTimersByTimeAsync(1000);

    // The live period ends 5 seconds after the first error. The second error starts no upload.
    expect(recorder.record.takeFullSnapshot).toHaveBeenCalledTimes(1);
    expect(segments.map((segment) => segment["session.id"])).toEqual(["s-1"]);
  });

  it("keeps the upload limit under a stream of errors", async () => {
    const { run, fail, segments, events } = setup({
      afterErrorMs: 5000,
      uploadsPerWindow: 1,
      uploadWindowMs: 60_000,
    });
    vi.setSystemTime(1_700_000_000_000);
    const { emit } = await run();

    // One error every 4 seconds for 40 seconds, with one event before each.
    for (let step = 0; step < 10; step++) {
      emit({ type: 3, data: step });
      fail();
      await vi.advanceTimersByTimeAsync(4000);
    }

    // Only the first error uploads in this window. The later events stay in the buffer.
    expect(sent(segments).flat()).toEqual([
      { type: 3, data: 0 },
      { type: 3, data: 1 },
    ]);
    expect(events.map(({ code }) => code)).toContain("capture.rate_limited");
  });

  it("starts the upload of an empty buffer with a new full snapshot", async () => {
    const { run, fail, segments, recorder } = setup({ afterErrorMs: 1000 });
    await run();

    // An upload without a snapshot is useless to a player.
    fail();
    await vi.advanceTimersByTimeAsync(3000);

    expect(sent(segments)[0]).toEqual([
      { type: 4, data: "meta" },
      { type: 2, data: "full" },
    ]);
    // One snapshot starts the upload, and a second one restarts the buffer afterwards.
    expect(recorder.record.takeFullSnapshot).toHaveBeenCalledTimes(2);
  });

  it("ends the upload when the snapshot for an empty buffer throws, as the real recorder does before its start", async () => {
    const error = new Error("please take full snapshot after start recording");
    const recorder = fakeRecorder();
    vi.mocked(recorder.record.takeFullSnapshot!).mockImplementation(() => {
      throw error;
    });
    const { run, fail, segments, events } = setup({ afterErrorMs: 1000 }, { recorder });
    const { emit } = await run();

    fail();
    // A live period that never ends would stream every later event to the endpoint.
    emit({ type: 4 });
    emit({ type: 2 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(segments).toEqual([]);
    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      [
        "capture.record_failed",
        "The replay recorder did not take a full snapshot. The library sends no replay for this error.",
        error,
      ],
    ]);

    // The events stayed in the buffer, so the next error sends them when its live period ends.
    fail();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent(segments)).toEqual([[{ type: 4 }, { type: 2 }]]);
  });

  it("drops the events of a snapshot that fails halfway, so no lone meta event goes out", async () => {
    const recorder = fakeRecorder();
    vi.mocked(recorder.record.takeFullSnapshot!).mockImplementation((isCheckout) => {
      recorder.calls.at(-1)?.emit({ type: 4, data: "meta" }, isCheckout);
      throw new Error("snapshot failed");
    });
    const { run, fail, segments } = setup({ afterErrorMs: 1000 }, { recorder });
    await run();

    fail();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(segments).toEqual([]);
  });

  it("keeps a starved buffer waiting for a snapshot after a failed one, so no upload starts without one", async () => {
    const recorder = fakeRecorder();
    vi.mocked(recorder.record.takeFullSnapshot!).mockImplementationOnce(() => {
      throw new Error("snapshot failed");
    });
    const { run, fail, segments } = setup(
      { maxBufferBytes: 100_000, afterErrorMs: 0 },
      { recorder },
    );
    const { emit } = await run();

    emit({ type: 4 });
    emit({ type: 3, data: "a".repeat(100_000) });
    fail();
    // Nothing with a snapshot comes before this event, so a player couldn't use it.
    emit({ type: 3, data: "after" });
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent(segments)).toEqual([
      [
        { type: 4, data: "meta" },
        { type: 2, data: "full" },
      ],
    ]);
  });

  it("gives the upload slot back when the snapshot fails, so a later error still gets its upload", async () => {
    const recorder = fakeRecorder();
    const snapshot = vi.mocked(recorder.record.takeFullSnapshot!);
    for (let failed = 0; failed < 3; failed++) {
      snapshot.mockImplementationOnce(() => {
        throw new Error("snapshot failed");
      });
    }
    const { run, fail, segments } = setup(
      { afterErrorMs: 0, uploadsPerWindow: 3, uploadWindowMs: 60_000 },
      { recorder },
    );
    vi.setSystemTime(1_700_000_000_000);
    await run();

    fail();
    fail();
    fail();
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent(segments)).toEqual([
      [
        { type: 4, data: "meta" },
        { type: 2, data: "full" },
      ],
    ]);
  });

  it("starts no upload of an empty buffer with a recorder that has no snapshot function", async () => {
    const { run, fail, segments } = setup({}, { recorder: fakeRecorder(false) });
    const { emit } = await run();

    fail();
    emit({ type: 3 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(segments).toEqual([]);
  });

  it("ends the upload right away with afterErrorMs of 0", async () => {
    const { run, fail, segments, recorder } = setup({ afterErrorMs: 0 });
    const { emit } = await run();

    emit({ type: 4 });
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(segments).toHaveLength(1);
    expect(recorder.record.takeFullSnapshot).toHaveBeenCalledTimes(1);
  });

  it("stops at the upload limit of the window and reports it", async () => {
    const { run, fail, segments, events } = setup({ afterErrorMs: 0, uploadsPerWindow: 1 });
    vi.setSystemTime(1_700_000_000_000);
    const { emit } = await run();

    emit({ type: 4 });
    fail();
    await vi.advanceTimersByTimeAsync(0);
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(segments).toHaveLength(1);
    expect(events.map(({ code }) => code)).toEqual(["capture.rate_limited"]);
    expect(events[0].message).toContain("replay uploads");
  });

  it("counts uploads in replay.uploadWindowMs, not in the capture window", async () => {
    const { run, fail, segments } = setup(
      { afterErrorMs: 0, uploadsPerWindow: 1, uploadWindowMs: 1000 },
      { config: { captureLimits: { windowMs: 60_000 } } },
    );
    vi.setSystemTime(1_700_000_000_000);
    const { emit } = await run();

    emit({ type: 4 });
    fail();
    await vi.advanceTimersByTimeAsync(1001);
    emit({ type: 3 });
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(segments).toHaveLength(2);
  });

  it("reports a part over the buffer size once, and the lost events at the upload", async () => {
    const { run, fail, events, segments } = setup({ maxBufferBytes: 100_000, afterErrorMs: 0 });
    const { emit } = await run();

    emit({ type: 4 });
    emit({ type: 3, data: "a".repeat(100_000) });
    emit({ type: 3 });
    // A second part over the limit doesn't produce a second report.
    emit({ type: 4 }, true);
    emit({ type: 2, data: "b".repeat(100_000) }, true);
    expect(reports(events)).toEqual([
      [
        "capture.rate_limited",
        "One part of the replay is above replay.maxBufferBytes. The buffer is empty until the next full snapshot. The replay of an error in that time starts at the error, with no events from before it. Raise the limit, or block a large element with replay.blockSelectors.",
      ],
    ]);

    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(reports(events)[1]).toEqual([
      "capture.rate_limited",
      "The replay buffer was above replay.maxBufferBytes. The library dropped 5 events.",
    ]);
    // The buffer was empty, so the upload starts with a fresh snapshot.
    expect(sent(segments)[0]).toEqual([
      { type: 4, data: "meta" },
      { type: 2, data: "full" },
    ]);
  });

  it("reports a part over the buffer size once per recording, also for a first snapshot that is too large", async () => {
    const recorder = fakeRecorder();
    // The real recorder takes its first snapshot inside record(), before it returns.
    recorder.record.mockImplementation((options: Record<string, unknown>) => {
      const started = options as unknown as RecordOptions;
      recorder.calls.push(started);
      started.emit({ type: 4 }, false);
      started.emit({ type: 2, data: "a".repeat(100_000) }, false);
      return recorder.stop;
    });
    const { run, events } = setup({ maxBufferBytes: 100_000 }, { recorder });
    const { emit } = await run();

    emit({ type: 4 }, true);
    emit({ type: 2, data: "b".repeat(100_000) }, true);

    expect(events.map(({ code }) => code)).toEqual(["capture.rate_limited"]);
  });

  it("sends the parts that fit the size limit and reports the events it dropped", async () => {
    const { run, fail, events, segments } = setup({ maxBufferBytes: 100_000, afterErrorMs: 0 });
    const { emit } = await run();

    emit({ type: 4 });
    emit({ type: 3, data: "a".repeat(60_000) });
    // The second part pushes the total above the limit, so the first part goes.
    emit({ type: 4 }, true);
    emit({ type: 2, data: "b".repeat(50_000) }, true);
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent(segments)).toEqual([[{ type: 4 }, { type: 2, data: "b".repeat(50_000) }]]);
    expect(reports(events)).toEqual([
      [
        "capture.rate_limited",
        "The replay buffer was above replay.maxBufferBytes. The library dropped 2 events.",
      ],
    ]);
  });

  it("does nothing for an error before the recorder runs and after a stop", async () => {
    const { sut, run, fail, segments } = setup({ requireConsent: true });

    await run();
    fail();
    await sut.start();
    sut.stop();
    fail();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(segments).toEqual([]);
  });

  it("drops the buffer and the upload at a stop in the time after an error", async () => {
    const { sut, run, fail, segments, recorder } = setup({ flushIntervalMs: 1000 });
    const { emit } = await run();

    emit({ type: 4 });
    fail();
    emit({ type: 3 });
    sut.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(segments).toEqual([]);
    expect(recorder.record.takeFullSnapshot).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an event that has no JSON form, with no throw into the recorder", async () => {
    const { run, events } = setup();
    const { emit } = await run();

    expect(() => {
      emit({ type: 3, data: 10n });
    }).not.toThrow();

    expect(reports(events)).toEqual([
      ["capture.record_failed", "The replay recorder had an error."],
    ]);
    expect(events[0].cause).toBeInstanceOf(TypeError);
  });

  it("reports an error that the recorder gives to its error handler", async () => {
    const error = new Error("recorder fault");
    const { run, events } = setup();
    const { errorHandler } = await run();

    errorHandler(error);

    expect(events.map(({ code, cause }) => [code, cause])).toEqual([
      ["capture.record_failed", error],
    ]);
  });

  it("reports an error record that it cannot read, with no throw into the log call", async () => {
    const { run, state, events } = setup();
    await run();

    expect(() => {
      state.hook?.({ severityText: "ERROR" } as unknown as LogRecord);
    }).not.toThrow();

    expect(reports(events)).toEqual([
      ["capture.record_failed", "The replay upload did not start."],
    ]);
  });

  it("ends the upload with a recorder that has no snapshot function", async () => {
    const { run, fail, segments, events } = setup(
      { afterErrorMs: 0 },
      { recorder: fakeRecorder(false) },
    );
    const { emit } = await run();

    emit({ type: 4 });
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(segments).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("reports a snapshot function that throws", async () => {
    const error = new Error("snapshot failed");
    const recorder = fakeRecorder();
    vi.mocked(recorder.record.takeFullSnapshot!).mockImplementation(() => {
      throw error;
    });
    const { run, fail, events } = setup({ afterErrorMs: 0 }, { recorder });
    const { emit } = await run();

    emit({ type: 4 });
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      ["capture.record_failed", "The replay recorder did not take a full snapshot.", error],
    ]);
  });
});
