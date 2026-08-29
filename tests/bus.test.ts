import { describe, it, expect, vi } from "vitest";
import { BootBuffer, Bus } from "../src/bus/bus";
import {
  createBroadcastLink,
  createChildrenLink,
  createDirectLink,
  createOpenFinLink,
  createParentLink,
  createOwnerLink,
  createWorkerLink,
  type Link,
  type Receive,
} from "../src/bus/links";
import { resolveConfig } from "../src/core/config";
import { Diagnostics, type DiagnosticEvent } from "../src/core/diagnostics";
import type { Journey } from "../src/core/journey";
import {
  envelope,
  unwrap,
  type BusEnvelope,
  type BusMessage,
  type LinkKind,
  type MessageSource,
} from "../src/models/bus";
import type { LogRecord } from "../src/models/log-record";
import { BUS_PROTOCOL } from "../src/constants";

/** Matches the parent-runtime lookup key in src/bus/links.ts. */
const RUNTIME_KEY = Symbol.for("ui-observability.runtime");

const diag = () => new Diagnostics(vi.fn<(event: DiagnosticEvent) => void>(), 0);

const oneRecord = (): LogRecord[] => [{ body: "x" } as unknown as LogRecord];

const fakeJourney = (over: Partial<Journey> = {}): Journey =>
  ({
    id: "j1",
    name: "checkout",
    startedAt: Date.now(),
    ...over,
  }) as unknown as Journey;

type IabCall = (...args: unknown[]) => Promise<void>;

interface FakeIab {
  subscribe: ReturnType<typeof vi.fn<IabCall>>;
  publish: ReturnType<typeof vi.fn<IabCall>>;
}

const fakeIab = (over: Partial<FakeIab> = {}): FakeIab => ({
  subscribe: vi.fn(() => Promise.resolve()),
  publish: vi.fn(() => Promise.resolve()),
  ...over,
});

class FakeBroadcastChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();

  constructor(public name: string) {
    FakeBroadcastChannel.instances.push(this);
  }

  static instances: FakeBroadcastChannel[] = [];
}

const handlers = () => ({
  onRecords: vi.fn<(records: LogRecord[]) => void>(),
  onJourney: vi.fn<(journey: Journey | null) => void>(),
  onJourneyRequest: vi.fn<() => Journey | null>(() => null),
  onTabConflict: vi.fn<() => void>(),
});

const platform = (over = {}) => ({
  platform: "browser" as const,
  userAgent: "test",
  isWorker: false,
  isTopLevelDocument: true,
  ...over,
});

const fakeLink = (kind: LinkKind) => ({ kind, post: vi.fn(), close: vi.fn() });

function make(over = {}, platformOver = {}, ctx = "ctx-1") {
  const diagnostics = new Diagnostics(vi.fn<(event: DiagnosticEvent) => void>(), 0);
  const config = resolveConfig(
    {
      endpoint: "https://x/v1/logs",
      serviceName: "svc",
      bus: { handshakeTimeoutMs: 20, ...over },
    },
    diagnostics,
  );
  const h = handlers();
  return {
    bus: new Bus(config, diagnostics, platform(platformOver), ctx, "tab-1", h),
    handlers: h,
    diagnostics,
    config,
  };
}

/** Every channel funnels into `receive`, so the tests drive it the same way. */
const deliver = (bus: Bus, message: BusMessage, source: MessageSource) =>
  (bus as unknown as { receive: (m: BusMessage, s: MessageSource) => void }).receive(
    message,
    source,
  );

const crossOriginParent = () =>
  new Proxy({} as Window, {
    get() {
      throw new DOMException("blocked a frame", "SecurityError");
    },
  });

describe("models/bus: envelope and unwrap", () => {
  it("wraps a message in the protocol envelope", () => {
    const message: BusMessage = { t: "hello", from: "ctx-1", tabId: "tab-1" };
    expect(envelope(message)).toEqual({ p: BUS_PROTOCOL, m: message });
  });

  it("rejects nullish data", () => {
    expect(unwrap(null)).toBeNull();
    expect(unwrap(undefined)).toBeNull();
  });

  it("rejects data that is not an object", () => {
    expect(unwrap("hello")).toBeNull();
    expect(unwrap(42)).toBeNull();
  });

  it("rejects an envelope with the wrong protocol tag", () => {
    expect(
      unwrap({
        p: "some-other-protocol",
        m: { t: "hello", from: "x", tabId: "t" },
      }),
    ).toBeNull();
  });

  it("rejects an envelope with no message", () => {
    expect(unwrap({ p: BUS_PROTOCOL, m: null })).toBeNull();
    expect(unwrap({ p: BUS_PROTOCOL })).toBeNull();
  });

  it("rejects a message whose type is not a string", () => {
    expect(unwrap({ p: BUS_PROTOCOL, m: { t: 42 } })).toBeNull();
    expect(unwrap({ p: BUS_PROTOCOL, m: {} })).toBeNull();
  });

  it("accepts a well-formed envelope and returns the message", () => {
    const message: BusMessage = { t: "hello", from: "ctx-1", tabId: "tab-1" };
    expect(unwrap(envelope(message))).toEqual(message);
  });
});

describe("createDirectLink", () => {
  it("returns null when there is no window", () => {
    vi.stubGlobal("window", undefined);
    expect(createDirectLink(vi.fn<Receive>(), diag())).toBeNull();
  });

  it("returns null at the top level, where window.parent is window", () => {
    expect(createDirectLink(vi.fn<Receive>(), diag())).toBeNull();
  });

  it("returns null when the parent is cross-origin", () => {
    vi.spyOn(window, "parent", "get").mockReturnValue(crossOriginParent());
    expect(createDirectLink(vi.fn<Receive>(), diag())).toBeNull();
  });

  it("returns null when the parent has not called configure()", () => {
    const fakeParent = {} as unknown as Window & typeof globalThis;
    vi.spyOn(window, "parent", "get").mockReturnValue(fakeParent);
    expect(createDirectLink(vi.fn<Receive>(), diag())).toBeNull();
  });

  it("returns null when the parent's runtime exposes no busAccept function", () => {
    const fakeParent = {} as unknown as Window & typeof globalThis;
    (fakeParent as unknown as Record<symbol, unknown>)[RUNTIME_KEY] = {
      busAccept: "nope",
    };
    vi.spyOn(window, "parent", "get").mockReturnValue(fakeParent);
    expect(createDirectLink(vi.fn<Receive>(), diag())).toBeNull();
  });

  it("attaches to a configured parent runtime, and stops posting once closed", () => {
    const busAccept = vi.fn();
    const fakeParent = {} as unknown as Window & typeof globalThis;
    (fakeParent as unknown as Record<symbol, unknown>)[RUNTIME_KEY] = {
      busAccept,
    };
    vi.spyOn(window, "parent", "get").mockReturnValue(fakeParent);

    const receive = vi.fn<Receive>();
    const link = createDirectLink(receive, diag());
    expect(link).not.toBeNull();

    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(busAccept).toHaveBeenCalledWith(expect.objectContaining({ t: "hello" }), receive);

    link?.close();
    busAccept.mockClear();
    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(busAccept).not.toHaveBeenCalled();
  });

  it("reports rather than throwing when the parent's busAccept itself throws", () => {
    const fakeParent = {} as unknown as Window & typeof globalThis;
    (fakeParent as unknown as Record<symbol, unknown>)[RUNTIME_KEY] = {
      busAccept: () => {
        throw new Error("parent is broken");
      },
    };
    vi.spyOn(window, "parent", "get").mockReturnValue(fakeParent);

    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const link = createDirectLink(vi.fn<Receive>(), new Diagnostics(handler, 0));
    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));
  });
});

describe("createParentLink", () => {
  it("returns null when there is no window", () => {
    vi.stubGlobal("window", undefined);
    expect(createParentLink(vi.fn<Receive>(), diag())).toBeNull();
  });

  it("returns null at the top level", () => {
    expect(createParentLink(vi.fn<Receive>(), diag())).toBeNull();
  });

  it("delivers a message from window.parent and ignores one from elsewhere", () => {
    const fakeParent = { postMessage: vi.fn() } as unknown as Window & typeof globalThis;
    vi.spyOn(window, "parent", "get").mockReturnValue(fakeParent);

    const receive = vi.fn<Receive>();
    const link = createParentLink(receive, diag());
    expect(link).not.toBeNull();

    const message = envelope({
      t: "hello",
      from: "parent-ctx",
      tabId: "tab-9",
    });
    dispatchEvent(
      Object.assign(new MessageEvent("message", { data: message }), {
        source: fakeParent,
        origin: "https://app.example",
      }),
    );
    expect(receive).toHaveBeenCalledWith(
      { t: "hello", from: "parent-ctx", tabId: "tab-9" },
      { link: "parent", origin: "https://app.example" },
    );

    receive.mockClear();
    dispatchEvent(
      Object.assign(new MessageEvent("message", { data: message }), {
        source: {},
        origin: "https://app.example",
      }),
    );
    expect(receive).not.toHaveBeenCalled();

    link?.close();
  });

  it("ignores a message with no protocol envelope", () => {
    const fakeParent = {} as unknown as Window & typeof globalThis;
    vi.spyOn(window, "parent", "get").mockReturnValue(fakeParent);
    const receive = vi.fn<Receive>();
    createParentLink(receive, diag());

    dispatchEvent(
      Object.assign(new MessageEvent("message", { data: { not: "ours" } }), {
        source: fakeParent,
      }),
    );
    expect(receive).not.toHaveBeenCalled();
  });

  it("posts to the parent with a wildcard origin, and reports a failure when it throws", () => {
    const postMessage = vi.fn();
    const fakeParent = { postMessage } as unknown as Window & typeof globalThis;
    vi.spyOn(window, "parent", "get").mockReturnValue(fakeParent);
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const link = createParentLink(vi.fn<Receive>(), new Diagnostics(handler, 0));

    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(postMessage).toHaveBeenCalledWith(
      envelope({ t: "hello", from: "ctx-1", tabId: "tab-1" }),
      "*",
    );

    postMessage.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));
  });

  it("stops delivering once closed", () => {
    const fakeParent = {} as unknown as Window & typeof globalThis;
    vi.spyOn(window, "parent", "get").mockReturnValue(fakeParent);
    const receive = vi.fn<Receive>();
    const link = createParentLink(receive, diag());
    link?.close();

    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "hello", from: "x", tabId: "t" }),
        }),
        {
          source: fakeParent,
        },
      ),
    );
    expect(receive).not.toHaveBeenCalled();
  });
});

describe("createChildrenLink", () => {
  it("returns null when there is no window", () => {
    vi.stubGlobal("window", undefined);
    expect(createChildrenLink(vi.fn<Receive>(), [], diag())).toBeNull();
  });

  it("ignores a message with no protocol envelope", () => {
    const receive = vi.fn<Receive>();
    const link = createChildrenLink(receive, [], diag());
    dispatchEvent(new MessageEvent("message", { data: { not: "ours" } }));
    expect(receive).not.toHaveBeenCalled();
    link?.close();
  });

  it("reports and drops a message from an untrusted origin", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const receive = vi.fn<Receive>();
    const link = createChildrenLink(receive, [], new Diagnostics(handler, 0));

    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "hello", from: "child", tabId: "t" }),
        }),
        {
          origin: "https://evil.example",
        },
      ),
    );

    expect(receive).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "bus.untrusted_origin",
        detail: { origin: "https://evil.example", type: "hello" },
      }),
    );
    link?.close();
  });

  it("accepts the document's own origin and a configured trusted origin", () => {
    const receive = vi.fn<Receive>();
    const link = createChildrenLink(receive, ["https://trusted.example"], diag());

    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "hello", from: "a", tabId: "t" }),
        }),
        {
          origin: window.location.origin,
        },
      ),
    );
    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "hello", from: "b", tabId: "t" }),
        }),
        {
          origin: "https://trusted.example",
        },
      ),
    );

    expect(receive).toHaveBeenCalledTimes(2);
    link?.close();
  });

  it("tracks a message source and drops it once its window is closed", () => {
    const link = createChildrenLink(vi.fn<Receive>(), [], diag());
    const child = { closed: false, postMessage: vi.fn() };

    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "hello", from: "child", tabId: "t" }),
        }),
        {
          origin: window.location.origin,
          source: child,
        },
      ),
    );
    link?.post({ t: "journey?", from: "ctx-1" });
    expect(child.postMessage).toHaveBeenCalledWith(envelope({ t: "journey?", from: "ctx-1" }), "*");

    child.closed = true;
    child.postMessage.mockClear();
    link?.post({ t: "journey?", from: "ctx-1" });
    expect(child.postMessage).not.toHaveBeenCalled();

    link?.close();
  });

  it("does not add a source when the message event carries none", () => {
    const receive = vi.fn<Receive>();
    const link = createChildrenLink(receive, [], diag());

    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "hello", from: "child", tabId: "t" }),
        }),
        {
          origin: window.location.origin,
        },
      ),
    );

    expect(receive).toHaveBeenCalledOnce();
    link?.close();
  });

  it("reports rather than throwing when posting to a child fails", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const link = createChildrenLink(vi.fn<Receive>(), [], new Diagnostics(handler, 0));
    const child = {
      closed: false,
      postMessage: () => {
        throw new Error("blocked");
      },
    };

    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "hello", from: "child", tabId: "t" }),
        }),
        {
          origin: window.location.origin,
          source: child,
        },
      ),
    );
    link?.post({ t: "journey?", from: "ctx-1" });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));
  });

  it("clears every tracked source on close", () => {
    const link = createChildrenLink(vi.fn<Receive>(), [], diag());
    const child = { closed: false, postMessage: vi.fn() };
    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "hello", from: "child", tabId: "t" }),
        }),
        {
          origin: window.location.origin,
          source: child,
        },
      ),
    );

    link?.close();
    link?.post({ t: "journey?", from: "ctx-1" });

    expect(child.postMessage).not.toHaveBeenCalled();
  });
});

describe("createBroadcastLink", () => {
  it("returns null when there is no BroadcastChannel", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(createBroadcastLink("ch", vi.fn<Receive>(), diag())).toBeNull();
  });

  it("returns null and reports when the channel cannot be opened", () => {
    // A function expression, not vi.fn: the constructor is invoked with `new`,
    // and vitest warns when a mock implementation is not a function or class.
    vi.stubGlobal("BroadcastChannel", function ThrowingChannel(): never {
      throw new Error("channel unavailable");
    });
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    expect(createBroadcastLink("ch", vi.fn<Receive>(), new Diagnostics(handler, 0))).toBeNull();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));
  });

  it("delivers an incoming message and ignores one with no protocol envelope", () => {
    FakeBroadcastChannel.instances = [];
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const receive = vi.fn<Receive>();
    createBroadcastLink("ch", receive, diag());
    const channel = FakeBroadcastChannel.instances[0];

    channel.onmessage?.({ data: { not: "ours" } } as MessageEvent);
    expect(receive).not.toHaveBeenCalled();

    const message = envelope({ t: "hello", from: "peer", tabId: "t" });
    channel.onmessage?.({ data: message } as MessageEvent);
    expect(receive).toHaveBeenCalledWith(
      { t: "hello", from: "peer", tabId: "t" },
      { link: "broadcast", origin: "same-origin" },
    );
  });

  it("posts and closes through the channel, reporting either failure", () => {
    FakeBroadcastChannel.instances = [];
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const link = createBroadcastLink("ch", vi.fn<Receive>(), new Diagnostics(handler, 0));
    const channel = FakeBroadcastChannel.instances[0];

    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(channel.postMessage).toHaveBeenCalledWith(
      envelope({ t: "hello", from: "ctx-1", tabId: "tab-1" }),
    );

    channel.postMessage.mockImplementationOnce(() => {
      throw new Error("channel closed");
    });
    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));

    link?.close();
    expect(channel.close).toHaveBeenCalledOnce();

    channel.close.mockImplementationOnce(() => {
      throw new Error("already closed");
    });
    link?.close();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));
  });
});

describe("createOpenFinLink", () => {
  it("returns null when there is no fin.InterApplicationBus", () => {
    expect(createOpenFinLink("topic", vi.fn<Receive>(), diag())).toBeNull();
    vi.stubGlobal("fin", {});
    expect(createOpenFinLink("topic", vi.fn<Receive>(), diag())).toBeNull();
  });

  it("subscribes across every application and delivers a message to receive", async () => {
    const iab = fakeIab();
    vi.stubGlobal("fin", { InterApplicationBus: iab });
    const receive = vi.fn<Receive>();

    createOpenFinLink("topic", receive, diag());
    await vi.waitFor(() => {
      expect(iab.subscribe).toHaveBeenCalledWith({ uuid: "*" }, "topic", expect.any(Function));
    });

    const listener = iab.subscribe.mock.calls[0][2] as (raw: unknown) => void;
    listener({ not: "ours" });
    expect(receive).not.toHaveBeenCalled();

    const message = envelope({ t: "hello", from: "peer", tabId: "t" });
    listener(message);
    expect(receive).toHaveBeenCalledWith(
      { t: "hello", from: "peer", tabId: "t" },
      { link: "openfin", origin: "openfin" },
    );
  });

  it("reports rather than throwing when the subscription rejects", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const iab = fakeIab({
      subscribe: vi.fn(() => Promise.reject(new Error("iab is gone"))),
    });
    vi.stubGlobal("fin", { InterApplicationBus: iab });

    createOpenFinLink("topic", vi.fn<Receive>(), new Diagnostics(handler, 0));
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));
    });
  });

  it("publishes through the bus, and reports rather than throwing when it rejects", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const iab = fakeIab();
    vi.stubGlobal("fin", { InterApplicationBus: iab });
    const link = createOpenFinLink("topic", vi.fn<Receive>(), new Diagnostics(handler, 0));

    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    await vi.waitFor(() => {
      expect(iab.publish).toHaveBeenCalledWith(
        "topic",
        envelope({ t: "hello", from: "ctx-1", tabId: "tab-1" }),
      );
    });

    iab.publish.mockImplementationOnce(() => Promise.reject(new Error("iab is gone")));
    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));
    });

    expect(() => link?.close()).not.toThrow();
  });
});

describe("createOwnerLink", () => {
  it("returns null outside a worker scope", () => {
    expect(createOwnerLink(vi.fn<Receive>(), diag())).toBeNull();
  });

  it("returns null in a worker-like scope with no postMessage", () => {
    vi.stubGlobal("WorkerGlobalScope", {});
    vi.stubGlobal("postMessage", undefined);
    expect(createOwnerLink(vi.fn<Receive>(), diag())).toBeNull();
  });

  it("delivers a message from the owner and ignores one with no protocol envelope", () => {
    vi.stubGlobal("WorkerGlobalScope", {});
    vi.stubGlobal("postMessage", vi.fn());
    const receive = vi.fn<Receive>();
    const link = createOwnerLink(receive, diag());
    expect(link?.kind).toBe("owner");

    dispatchEvent(new MessageEvent("message", { data: { not: "ours" } }));
    expect(receive).not.toHaveBeenCalled();

    dispatchEvent(
      new MessageEvent("message", {
        data: envelope({ t: "hello", from: "owner", tabId: "t" }),
      }),
    );
    expect(receive).toHaveBeenCalledWith(
      { t: "hello", from: "owner", tabId: "t" },
      { link: "owner", origin: "same-origin" },
    );
  });

  it("tolerates a scope with no addEventListener", () => {
    vi.stubGlobal("WorkerGlobalScope", {});
    vi.stubGlobal("postMessage", vi.fn());
    vi.stubGlobal("addEventListener", undefined);
    expect(() => createOwnerLink(vi.fn<Receive>(), diag())).not.toThrow();
  });

  it("posts to the owner, and reports rather than throwing when it fails", () => {
    vi.stubGlobal("WorkerGlobalScope", {});
    const post = vi.fn();
    vi.stubGlobal("postMessage", post);
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const link = createOwnerLink(vi.fn<Receive>(), new Diagnostics(handler, 0));

    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(post).toHaveBeenCalledWith(envelope({ t: "hello", from: "ctx-1", tabId: "tab-1" }));

    post.mockImplementationOnce(() => {
      throw new Error("owner is gone");
    });
    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));

    expect(() => link?.close()).not.toThrow();
  });
});

type WorkerSubscribe = (type: "message", listener: (event: MessageEvent) => void) => void;

/** Mock-typed so `.mock.calls` stays reachable after the spread of `over`. */
interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn<(message: unknown) => void>>;
  addEventListener: ReturnType<typeof vi.fn<WorkerSubscribe>>;
  removeEventListener: ReturnType<typeof vi.fn<WorkerSubscribe>>;
  start?: () => void;
}

describe("createWorkerLink", () => {
  const worker = (over: Partial<FakeWorker> = {}): FakeWorker => ({
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...over,
  });

  it("delivers a message from the worker and ignores one with no protocol envelope", () => {
    const w = worker();
    const receive = vi.fn<Receive>();
    createWorkerLink(w, receive, diag());

    const listener = w.addEventListener.mock.calls[0][1] as (event: MessageEvent) => void;
    listener(new MessageEvent("message", { data: { not: "ours" } }));
    expect(receive).not.toHaveBeenCalled();

    listener(
      new MessageEvent("message", {
        data: envelope({ t: "hello", from: "doc", tabId: "t" }),
      }),
    );
    expect(receive).toHaveBeenCalledWith(
      { t: "hello", from: "doc", tabId: "t" },
      { link: "worker", origin: "same-origin" },
    );
  });

  it("starts a MessagePort when one is given, and tolerates a Worker with no start", () => {
    const start = vi.fn();
    const port = worker({ start });
    createWorkerLink(port, vi.fn<Receive>(), diag());
    expect(start).toHaveBeenCalledOnce();

    expect(() => createWorkerLink(worker(), vi.fn<Receive>(), diag())).not.toThrow();
  });

  it("posts to the worker, and reports rather than throwing when it fails", () => {
    const w = worker();
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const link = createWorkerLink(w, vi.fn<Receive>(), new Diagnostics(handler, 0));

    link.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(w.postMessage).toHaveBeenCalledWith(
      envelope({ t: "hello", from: "ctx-1", tabId: "tab-1" }),
    );

    w.postMessage.mockImplementationOnce(() => {
      throw new Error("worker is gone");
    });
    link.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));
  });

  it("removes the same listener it registered, on close", () => {
    const w = worker();
    const link = createWorkerLink(w, vi.fn<Receive>(), diag());
    const listener = w.addEventListener.mock.calls[0][1];

    link.close();
    expect(w.removeEventListener).toHaveBeenCalledWith("message", listener);
  });
});

describe("Bus role resolution: off, sender, forwarder", () => {
  it("does nothing at all when the mode is off", async () => {
    const { bus } = make({ mode: "off" });
    const role = await bus.start();

    expect(role).toBe("sender");
    expect(bus.isResolved()).toBe(true);
    expect((bus as unknown as { links: Link[] }).links).toHaveLength(0);
  });

  it("reports the resolved role through getRole", async () => {
    vi.stubGlobal("WorkerGlobalScope", {});
    vi.stubGlobal("postMessage", vi.fn());
    const { bus } = make({ mode: "forwarder" }, { isWorker: true, isTopLevelDocument: false });

    expect(bus.getRole()).toBe("sender");
    await bus.start();
    expect(bus.getRole()).toBe("forwarder");
    bus.destroy();
  });

  it("is a sender immediately when the mode says so", async () => {
    const { bus } = make({ mode: "sender" });
    expect(await bus.start()).toBe("sender");
    bus.destroy();
  });

  it("is a forwarder immediately when the mode says so, forwarding once an upstream exists", async () => {
    vi.stubGlobal("WorkerGlobalScope", {});
    vi.stubGlobal("postMessage", vi.fn());
    const { bus } = make({ mode: "forwarder" }, { isWorker: true, isTopLevelDocument: false });

    expect(await bus.start()).toBe("forwarder");
    bus.destroy();
  });

  it("reports no_owner and drops records when forwarder mode finds nothing to forward to", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const diagnostics = new Diagnostics(handler, 0);
    const config = resolveConfig(
      {
        endpoint: "https://x/v1/logs",
        serviceName: "svc",
        bus: { mode: "forwarder" },
      },
      diagnostics,
    );
    const h = handlers();
    const bus = new Bus(config, diagnostics, platform(), "ctx-1", "tab-1", h);

    expect(await bus.start()).toBe("forwarder");
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.no_owner" }));

    deliver(
      bus,
      { t: "records", from: "child", records: oneRecord() },
      { link: "children", origin: "https://app.example" },
    );
    expect(h.onRecords).not.toHaveBeenCalled();
    bus.destroy();
  });
});

describe("Bus role resolution: auto mode", () => {
  it("is a sender when it is a top-level document with nothing above it", async () => {
    const { bus } = make();
    expect(await bus.start()).toBe("sender");
    bus.destroy();
  });

  it("promotes itself to sender when candidateUpstream finds nothing to forward to", async () => {
    const diagnostics = new Diagnostics(vi.fn<(event: DiagnosticEvent) => void>(), 0);
    const config = resolveConfig(
      {
        endpoint: "https://x/v1/logs",
        serviceName: "svc",
        bus: { handshakeTimeoutMs: 20 },
      },
      diagnostics,
    );
    const bus = new Bus(
      config,
      diagnostics,
      platform({ isTopLevelDocument: false }),
      "ctx-2",
      "tab-2",
      handlers(),
    );

    // No parent replies: window.parent === window in this environment, so
    // createParentLink returns null and the role resolves without a handshake.
    expect(await bus.start()).toBe("sender");
    bus.destroy();
  });

  it("attaches directly to a same-origin parent, with no handshake", async () => {
    const busAccept = vi.fn();
    const fakeParent = {} as unknown as Window & typeof globalThis;
    (fakeParent as unknown as Record<symbol, unknown>)[RUNTIME_KEY] = { busAccept };
    const parentSpy = vi.spyOn(window, "parent", "get").mockReturnValue(fakeParent);

    const { bus } = make();
    const role = await bus.start();

    expect(role).toBe("forwarder");
    bus.sendRecords(oneRecord());
    expect(busAccept).toHaveBeenCalledWith(
      expect.objectContaining({ t: "records" }),
      expect.any(Function),
    );

    bus.destroy();
    parentSpy.mockRestore();
  });

  it("falls back to the handshake when the parent is cross-origin", async () => {
    const parentSpy = vi.spyOn(window, "parent", "get").mockReturnValue(crossOriginParent());

    const { bus } = make();
    // No candidate exists either (top-level, not a worker, not OpenFin), so it
    // promotes without ever starting a handshake.
    expect(await bus.start()).toBe("sender");

    bus.destroy();
    parentSpy.mockRestore();
  });

  it("becomes a forwarder through the handshake loop when an owner answers", async () => {
    vi.stubGlobal("WorkerGlobalScope", {});
    const { bus } = make(
      { handshakeTimeoutMs: 1000 },
      { isWorker: true, isTopLevelDocument: false },
    );
    vi.stubGlobal(
      "postMessage",
      vi.fn((data: unknown) => {
        const message = unwrap(data);
        if (message?.t === "hello") {
          deliver(
            bus,
            { t: "welcome", from: "owner", to: "ctx-1", tabId: "t" },
            { link: "owner", origin: "same-origin" },
          );
        }
      }),
    );

    expect(await bus.start()).toBe("forwarder");
    bus.destroy();
  });

  it("retries a cross-origin orphan the configured number of times before promoting", async () => {
    vi.spyOn(window, "parent", "get").mockReturnValue(crossOriginParent());
    const iab = fakeIab();
    vi.stubGlobal("fin", { InterApplicationBus: iab });

    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const diagnostics = new Diagnostics(handler, 0);
    const config = resolveConfig(
      {
        endpoint: "https://x/v1/logs",
        serviceName: "svc",
        bus: {
          handshakeTimeoutMs: 5,
          maxHandshakeAttempts: 2,
          openFinRole: "client",
        },
      },
      diagnostics,
    );
    // Realistic OpenFin desktop shape: a genuine view is always its own
    // top-level document, so the control-link and candidate-link paths for
    // "openfin" both run, and share the one memoized subscription.
    const bus = new Bus(
      config,
      diagnostics,
      platform({ platform: "openfin" }),
      "ctx-1",
      "tab-1",
      handlers(),
    );

    expect(await bus.start()).toBe("sender");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "bus.handshake_timeout",
        message: expect.stringContaining("2 attempt(s)"),
      }),
    );
    const hellos = iab.publish.mock.calls.filter(
      ([, message]) => (message as BusEnvelope).m.t === "hello",
    );
    expect(hellos).toHaveLength(2);
    bus.destroy();
  });

  it("promotes after a single attempt when the orphan is not cross-origin", async () => {
    vi.stubGlobal("WorkerGlobalScope", {});
    const post = vi.fn();
    vi.stubGlobal("postMessage", post);

    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const diagnostics = new Diagnostics(handler, 0);
    const config = resolveConfig(
      {
        endpoint: "https://x/v1/logs",
        serviceName: "svc",
        bus: { handshakeTimeoutMs: 5 },
      },
      diagnostics,
    );
    const bus = new Bus(
      config,
      diagnostics,
      platform({ isWorker: true, isTopLevelDocument: false }),
      "ctx-1",
      "tab-1",
      handlers(),
    );

    expect(await bus.start()).toBe("sender");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "bus.handshake_timeout",
        message: expect.stringContaining("1 attempt(s)"),
      }),
    );
    expect(post).toHaveBeenCalledTimes(1);
    bus.destroy();
  });
});

describe("Bus handshake", () => {
  it("settles a handshake from a welcome that was never a DOM message event", async () => {
    // The OpenFin and worker case. A handshake that only listened for a
    // `message` event would time out here every time, because neither
    // channel ever fires one.
    const { bus } = make({ handshakeTimeoutMs: 1000 });
    const upstream = fakeLink("openfin");
    upstream.post.mockImplementation((message: BusMessage) => {
      if (message.t !== "hello") {
        return;
      }
      deliver(
        bus,
        { t: "welcome", from: "provider", to: message.from, tabId: "tab-9" },
        { link: "openfin", origin: "openfin" },
      );
    });

    const welcomed = await (
      bus as unknown as { handshake: (link: Link) => Promise<boolean> }
    ).handshake(upstream);

    expect(welcomed).toBe(true);
    bus.destroy();
  });

  it("ignores a welcome addressed to a different context", async () => {
    const { bus } = make({ handshakeTimeoutMs: 30 });
    const upstream = fakeLink("openfin");
    upstream.post.mockImplementation(() => {
      deliver(
        bus,
        { t: "welcome", from: "provider", to: "another-view", tabId: "tab-9" },
        { link: "openfin", origin: "openfin" },
      );
    });

    const welcomed = await (
      bus as unknown as { handshake: (link: Link) => Promise<boolean> }
    ).handshake(upstream);

    expect(welcomed).toBe(false);
    bus.destroy();
  });

  it("ignores a correctly addressed welcome that arrives on the wrong link", async () => {
    const { bus } = make({ handshakeTimeoutMs: 20 });
    const upstream = fakeLink("parent");
    upstream.post.mockImplementation(() => {
      deliver(
        bus,
        { t: "welcome", from: "provider", to: "ctx-1", tabId: "t" },
        { link: "openfin", origin: "openfin" },
      );
    });

    const welcomed = await (
      bus as unknown as { handshake: (link: Link) => Promise<boolean> }
    ).handshake(upstream);

    expect(welcomed).toBe(false);
    bus.destroy();
  });

  it("ignores a second call to settle once the handshake has already resolved", async () => {
    const { bus } = make({ handshakeTimeoutMs: 1000 });
    const upstream = fakeLink("parent");

    const promise = (bus as unknown as { handshake: (link: Link) => Promise<boolean> }).handshake(
      upstream,
    );
    const settle = (
      bus as unknown as {
        awaitingWelcome: { settle: (ok: boolean) => void } | null;
      }
    ).awaitingWelcome?.settle;

    settle?.(true);
    expect(() => settle?.(false)).not.toThrow();
    expect(await promise).toBe(true);
    bus.destroy();
  });
});

describe("Bus receive: hello and tab", () => {
  it("ignores its own broadcast regardless of message type", () => {
    const { bus, handlers: h } = make();
    deliver(
      bus,
      { t: "records", from: "ctx-1", records: oneRecord() },
      { link: "broadcast", origin: "same-origin" },
    );
    expect(h.onRecords).not.toHaveBeenCalled();
  });

  it("ignores a bus message from an untrusted origin", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const diagnostics = new Diagnostics(handler, 0);
    const config = resolveConfig(
      {
        endpoint: "https://x/v1/logs",
        serviceName: "svc",
        bus: { trustedOrigins: [] },
      },
      diagnostics,
    );
    const h = handlers();
    const bus = new Bus(config, diagnostics, platform(), "ctx-3", "tab-3", h);
    await bus.start();

    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: {
            p: "ui-observability/1",
            m: { t: "records", from: "evil", records: [{}] },
          },
        }),
        { origin: "https://evil.example" },
      ),
    );

    expect(h.onRecords).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.untrusted_origin" }));
    bus.destroy();
  });

  it("answers a hello only on a channel it structurally owns", async () => {
    const { bus } = make();
    await bus.start();

    const children = fakeLink("children");
    const broadcast = fakeLink("broadcast");
    const links = (bus as unknown as { links: Link[] }).links;
    links.length = 0;
    links.push(children, broadcast);

    deliver(
      bus,
      { t: "hello", from: "frame", tabId: "t" },
      { link: "children", origin: "https://app.example" },
    );
    deliver(
      bus,
      { t: "hello", from: "peer-tab", tabId: "t" },
      { link: "broadcast", origin: "same-origin" },
    );

    expect(children.post).toHaveBeenCalledWith(
      expect.objectContaining({ t: "welcome", to: "frame" }),
    );
    // A peer tab is not ours to own. Answering it is how two tabs end up
    // forwarding to each other.
    expect(broadcast.post).not.toHaveBeenCalled();
    bus.destroy();
  });

  it("never answers a hello once it is no longer the sender", () => {
    const { bus } = make();
    const link = fakeLink("children");
    (bus as unknown as { links: Link[] }).links.push(link);
    (bus as unknown as { role: string }).role = "forwarder";

    deliver(
      bus,
      { t: "hello", from: "child", tabId: "t" },
      { link: "children", origin: "https://app.example" },
    );
    expect(link.post).not.toHaveBeenCalled();
  });

  it("answers a hello on the OpenFin channel only when it is the provider", () => {
    const notProvider = make();
    const provider = make();
    (notProvider.bus as unknown as { isOpenFinProvider: boolean }).isOpenFinProvider = false;
    (provider.bus as unknown as { isOpenFinProvider: boolean }).isOpenFinProvider = true;

    const link1 = fakeLink("openfin");
    const link2 = fakeLink("openfin");
    (notProvider.bus as unknown as { links: Link[] }).links.push(link1);
    (provider.bus as unknown as { links: Link[] }).links.push(link2);

    deliver(
      notProvider.bus,
      { t: "hello", from: "view", tabId: "t" },
      { link: "openfin", origin: "openfin" },
    );
    expect(link1.post).not.toHaveBeenCalled();

    deliver(
      provider.bus,
      { t: "hello", from: "view", tabId: "t" },
      { link: "openfin", origin: "openfin" },
    );
    expect(link2.post).toHaveBeenCalledWith(expect.objectContaining({ t: "welcome", to: "view" }));
  });

  it("resolves a duplicated tab id deterministically, so only one side regenerates", async () => {
    const a = make({}, {}, "ctx-aaa");
    const b = make({}, {}, "ctx-zzz");
    await a.bus.start();
    await b.bus.start();

    const fromAnotherTab: MessageSource = {
      link: "broadcast",
      origin: "same-origin",
    };
    // ctx-zzz sees a claim from ctx-aaa for the same tab id and yields,
    // because "ctx-zzz" > "ctx-aaa".
    deliver(b.bus, { t: "tab", from: "ctx-aaa", tabId: "tab-1" }, fromAnotherTab);
    deliver(a.bus, { t: "tab", from: "ctx-zzz", tabId: "tab-1" }, fromAnotherTab);

    expect(b.handlers.onTabConflict).toHaveBeenCalled();
    expect(a.handlers.onTabConflict).not.toHaveBeenCalled();
    a.bus.destroy();
    b.bus.destroy();
  });

  it("does not treat a same-origin frame's shared tab id as a conflict", async () => {
    const { bus, handlers: h } = make({}, {}, "ctx-aaa");
    await bus.start();

    deliver(
      bus,
      { t: "tab", from: "ctx-zzz", tabId: "tab-1" },
      { link: "children", origin: "https://app.example" },
    );

    expect(h.onTabConflict).not.toHaveBeenCalled();
    bus.destroy();
  });

  it("ignores a tab claim for a different tab id entirely", () => {
    const { bus, handlers: h } = make({}, {}, "ctx-zzz");
    deliver(
      bus,
      { t: "tab", from: "ctx-aaa", tabId: "some-other-tab" },
      { link: "broadcast", origin: "same-origin" },
    );
    expect(h.onTabConflict).not.toHaveBeenCalled();
  });
});

describe("Bus receive: welcome, records and journey", () => {
  it("ignores a welcome with no handshake in flight", () => {
    const { bus } = make();
    expect(() =>
      deliver(
        bus,
        { t: "welcome", from: "peer", to: "ctx-1", tabId: "t" },
        { link: "broadcast", origin: "same-origin" },
      ),
    ).not.toThrow();
  });

  it("delivers records to onRecords when this context is the sender", () => {
    const { bus, handlers: h } = make();
    const records = oneRecord();
    deliver(
      bus,
      { t: "records", from: "child", records },
      { link: "children", origin: "https://app.example" },
    );
    expect(h.onRecords).toHaveBeenCalledWith(records);
  });

  it("relays records upward when it is itself a forwarder", async () => {
    // A middle frame in a nested arrangement. Dropping these, which is what a
    // sender-only check does, loses every record from a grandchild frame.
    const { bus, handlers: h } = make();
    await bus.start();

    const upstream = fakeLink("parent");
    const internals = bus as unknown as { role: string; upstream: Link | null };
    internals.role = "forwarder";
    internals.upstream = upstream;

    deliver(
      bus,
      { t: "records", from: "grandchild", records: oneRecord() },
      { link: "children", origin: "https://app.example" },
    );

    expect(h.onRecords).not.toHaveBeenCalled();
    expect(upstream.post).toHaveBeenCalledWith(expect.objectContaining({ t: "records" }));
    bus.destroy();
  });

  it("drops records rather than forwarding when a forwarder has no upstream", () => {
    const { bus, handlers: h } = make();
    (bus as unknown as { role: string }).role = "forwarder";

    deliver(
      bus,
      { t: "records", from: "child", records: oneRecord() },
      { link: "children", origin: "https://app.example" },
    );
    expect(h.onRecords).not.toHaveBeenCalled();
  });

  it("does not echo records back to the link they arrived from as an upstream", () => {
    const { bus, handlers: h } = make();
    const upstream = fakeLink("parent");
    const internals = bus as unknown as { role: string; upstream: Link | null };
    internals.role = "forwarder";
    internals.upstream = upstream;

    deliver(
      bus,
      { t: "records", from: "peer", records: oneRecord() },
      { link: "parent", origin: "same-origin" },
    );

    expect(h.onRecords).not.toHaveBeenCalled();
    expect(upstream.post).not.toHaveBeenCalled();
  });

  it("adopts a journey pushed from elsewhere, including a cleared one", () => {
    const { bus, handlers: h } = make();
    const j = fakeJourney();

    deliver(
      bus,
      { t: "journey", from: "peer", journey: j },
      { link: "broadcast", origin: "same-origin" },
    );
    expect(h.onJourney).toHaveBeenCalledWith(j);

    deliver(
      bus,
      { t: "journey", from: "peer", journey: null },
      { link: "broadcast", origin: "same-origin" },
    );
    expect(h.onJourney).toHaveBeenCalledWith(null);
  });

  it("answers a journey question over receive only when a journey is active", () => {
    const { bus, handlers: h } = make();
    const link = fakeLink("children");
    (bus as unknown as { links: Link[] }).links.push(link);

    h.onJourneyRequest.mockReturnValueOnce(null);
    deliver(
      bus,
      { t: "journey?", from: "child" },
      { link: "children", origin: "https://app.example" },
    );
    expect(link.post).not.toHaveBeenCalled();

    const j = fakeJourney();
    h.onJourneyRequest.mockReturnValueOnce(j);
    deliver(
      bus,
      { t: "journey?", from: "child" },
      { link: "children", origin: "https://app.example" },
    );
    expect(link.post).toHaveBeenCalledWith({
      t: "journey",
      from: "ctx-1",
      journey: j,
    });
  });
});

describe("Bus internals: resolveOpenFinProvider", () => {
  const call = (over = {}, platformOver = {}) => {
    const { bus } = make(over, platformOver);
    return (bus as unknown as { resolveOpenFinProvider: () => boolean }).resolveOpenFinProvider();
  };

  it("trusts an explicit role over the platform or identity", () => {
    expect(call({ openFinRole: "provider" })).toBe(true);
    expect(call({ openFinRole: "client" })).toBe(false);
  });

  it("is never the provider outside an OpenFin platform", () => {
    expect(call({}, { platform: "browser" })).toBe(false);
  });

  it("is never the provider with no identity, or as a view", () => {
    vi.stubGlobal("fin", {});
    expect(call({}, { platform: "openfin" })).toBe(false);

    vi.stubGlobal("fin", {
      me: { isView: true, identity: { uuid: "app-1", name: "app-1" } },
    });
    expect(call({}, { platform: "openfin" })).toBe(false);
  });

  it("is the provider only when its window name equals the application uuid", () => {
    vi.stubGlobal("fin", {
      me: { identity: { uuid: "app-1", name: "app-1" } },
    });
    expect(call({}, { platform: "openfin" })).toBe(true);

    vi.stubGlobal("fin", {
      me: { identity: { uuid: "app-1", name: "view-1" } },
    });
    expect(call({}, { platform: "openfin_web" })).toBe(false);

    vi.stubGlobal("fin", { me: { identity: { uuid: "app-1", name: "" } } });
    expect(call({}, { platform: "openfin" })).toBe(false);
  });
});

describe("Bus internals: orphanPolicy and isCrossOriginFrame", () => {
  const orphanPolicyOf = (over = {}) => {
    const { bus } = make(over);
    return (bus as unknown as { orphanPolicy: () => string }).orphanPolicy();
  };
  const crossOrigin = () => {
    const { bus } = make();
    return (bus as unknown as { isCrossOriginFrame: () => boolean }).isCrossOriginFrame();
  };

  it("returns an explicit policy without inspecting the frame", () => {
    expect(orphanPolicyOf({ orphanPolicy: "promote" })).toBe("promote");
    expect(orphanPolicyOf({ orphanPolicy: "retry" })).toBe("retry");
  });

  it("is never cross-origin with no window", () => {
    vi.stubGlobal("window", undefined);
    expect(crossOrigin()).toBe(false);
  });

  it("is not cross-origin at the top level", () => {
    expect(crossOrigin()).toBe(false);
  });

  it("is not cross-origin when the parent is framed but readable", () => {
    vi.spyOn(window, "parent", "get").mockReturnValue({
      location: {},
    } as unknown as Window & typeof globalThis);
    expect(crossOrigin()).toBe(false);
  });

  it("is cross-origin when reading the parent throws", () => {
    vi.spyOn(window, "parent", "get").mockReturnValue(crossOriginParent());
    expect(crossOrigin()).toBe(true);
  });

  it("auto-resolves retry cross-origin and promote otherwise", () => {
    expect(orphanPolicyOf({ orphanPolicy: "auto" })).toBe("promote");

    vi.spyOn(window, "parent", "get").mockReturnValue(crossOriginParent());
    expect(orphanPolicyOf({ orphanPolicy: "auto" })).toBe("retry");
  });
});

describe("Bus internals: candidateUpstream", () => {
  const call = (over = {}, platformOver = {}, isProvider = false) => {
    const { bus } = make(over, platformOver);
    (bus as unknown as { isOpenFinProvider: boolean }).isOpenFinProvider = isProvider;
    return (bus as unknown as { candidateUpstream: () => Link | null }).candidateUpstream();
  };

  it("returns null with nothing above a top-level document", () => {
    expect(call()).toBeNull();
  });

  it("asks the worker link when this realm is a worker", () => {
    vi.stubGlobal("WorkerGlobalScope", {});
    vi.stubGlobal("postMessage", vi.fn());
    expect(call({}, { isWorker: true })?.kind).toBe("owner");
  });

  it("asks the parent link when this document is not top level", () => {
    vi.spyOn(window, "parent", "get").mockReturnValue({
      postMessage: vi.fn(),
    } as unknown as Window & typeof globalThis);
    expect(call({}, { isTopLevelDocument: false })?.kind).toBe("parent");
  });

  it("forwards to the OpenFin provider only when it is not the provider itself", () => {
    vi.stubGlobal("fin", { InterApplicationBus: fakeIab() });
    expect(call({}, { platform: "openfin" }, false)?.kind).toBe("openfin");
  });

  it("does not forward when it is itself the OpenFin provider", () => {
    vi.stubGlobal("fin", { InterApplicationBus: fakeIab() });
    expect(call({}, { platform: "openfin" }, true)).toBeNull();
  });

  it("does not forward when openFinHost is self", () => {
    vi.stubGlobal("fin", { InterApplicationBus: fakeIab() });
    expect(call({ openFinHost: "self" }, { platform: "openfin" }, false)).toBeNull();
  });
});

describe("Bus internals: ensureOpenFinLink", () => {
  it("subscribes once even when asked for twice", () => {
    const iab = fakeIab();
    vi.stubGlobal("fin", { InterApplicationBus: iab });
    const { bus } = make({}, { platform: "openfin" });
    const internals = bus as unknown as {
      ensureOpenFinLink: () => Link | null;
    };

    const first = internals.ensureOpenFinLink();
    const second = internals.ensureOpenFinLink();

    expect(first).toBe(second);
    expect(iab.subscribe).toHaveBeenCalledOnce();
  });
});

describe("Bus internals: openControlLinks", () => {
  it("opens the children and broadcast control links at the top level", () => {
    const { bus } = make();
    (bus as unknown as { openControlLinks: () => void }).openControlLinks();
    const kinds = (bus as unknown as { links: Link[] }).links.map((l) => l.kind);
    expect(kinds).toEqual(["children", "broadcast"]);
    bus.destroy();
  });

  it("skips a control link whose factory declines to build one", () => {
    // No BroadcastChannel: createBroadcastLink returns null and nothing is
    // pushed, so a top-level document opens the children link alone.
    vi.stubGlobal("BroadcastChannel", undefined);

    const { bus } = make();
    (bus as unknown as { openControlLinks: () => void }).openControlLinks();
    expect((bus as unknown as { links: Link[] }).links.map((l) => l.kind)).toEqual(["children"]);
    bus.destroy();
  });

  it("opens no children or broadcast link inside a frame with no OpenFin platform", () => {
    const { bus } = make({}, { isTopLevelDocument: false });
    (bus as unknown as { openControlLinks: () => void }).openControlLinks();
    expect((bus as unknown as { links: Link[] }).links).toHaveLength(0);
  });

  it("opens the OpenFin control link on both OpenFin platforms", () => {
    vi.stubGlobal("fin", { InterApplicationBus: fakeIab() });

    const desktop = make({}, { platform: "openfin", isTopLevelDocument: false });
    (desktop.bus as unknown as { openControlLinks: () => void }).openControlLinks();
    expect((desktop.bus as unknown as { links: Link[] }).links.map((l) => l.kind)).toEqual([
      "openfin",
    ]);

    const coreWeb = make({}, { platform: "openfin_web", isTopLevelDocument: false });
    (coreWeb.bus as unknown as { openControlLinks: () => void }).openControlLinks();
    expect((coreWeb.bus as unknown as { links: Link[] }).links.map((l) => l.kind)).toEqual([
      "openfin",
    ]);
  });
});

describe("Bus destroy and allLinks", () => {
  it("closes a link only once when it is both the upstream and a control link", () => {
    const { bus } = make();
    const shared = fakeLink("openfin");
    const internals = bus as unknown as {
      links: Link[];
      upstream: Link | null;
    };
    internals.links.push(shared);
    internals.upstream = shared;

    bus.destroy();

    expect(shared.close).toHaveBeenCalledOnce();
  });

  it("closes the upstream separately when it is not also a control link", () => {
    const { bus } = make();
    const control = fakeLink("broadcast");
    const upstream = fakeLink("parent");
    const internals = bus as unknown as {
      links: Link[];
      upstream: Link | null;
    };
    internals.links.push(control);
    internals.upstream = upstream;

    bus.destroy();

    expect(control.close).toHaveBeenCalledOnce();
    expect(upstream.close).toHaveBeenCalledOnce();
  });

  it("stops delivering to handlers once destroyed", () => {
    const { bus, handlers: h } = make();
    (bus as unknown as { openControlLinks: () => void }).openControlLinks();
    bus.destroy();

    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "records", from: "child", records: [] }),
        }),
        {
          origin: window.location.origin,
        },
      ),
    );

    expect(h.onRecords).not.toHaveBeenCalled();
  });
});

describe("Bus public methods", () => {
  it("does nothing when there is no upstream to send records to", () => {
    const { bus } = make();
    expect(() => bus.sendRecords(oneRecord())).not.toThrow();
  });

  it("ignores its own message in acceptDirect", () => {
    const { bus } = make();
    const reply = vi.fn<Receive>();
    bus.acceptDirect({ t: "hello", from: "ctx-1", tabId: "t" }, reply);
    expect(reply).not.toHaveBeenCalled();
  });

  it("answers a hello directly when it can own the channel", () => {
    const { bus } = make();
    const reply = vi.fn<Receive>();
    bus.acceptDirect({ t: "hello", from: "child", tabId: "t" }, reply);
    expect(reply).toHaveBeenCalledWith(
      { t: "welcome", from: "ctx-1", to: "child", tabId: "tab-1" },
      { link: "direct", origin: "same-origin" },
    );
  });

  it("does not answer a hello directly once it is no longer the sender", () => {
    const { bus } = make();
    (bus as unknown as { role: string }).role = "forwarder";
    const reply = vi.fn<Receive>();
    bus.acceptDirect({ t: "hello", from: "child", tabId: "t" }, reply);
    expect(reply).not.toHaveBeenCalled();
  });

  it("answers a direct journey question only when a journey is active", () => {
    const { bus, handlers: h } = make();
    const reply = vi.fn<Receive>();

    h.onJourneyRequest.mockReturnValueOnce(null);
    bus.acceptDirect({ t: "journey?", from: "child" }, reply);
    expect(reply).not.toHaveBeenCalled();

    const j = fakeJourney();
    h.onJourneyRequest.mockReturnValueOnce(j);
    bus.acceptDirect({ t: "journey?", from: "child" }, reply);
    expect(reply).toHaveBeenCalledWith(
      { t: "journey", from: "ctx-1", journey: j },
      { link: "direct", origin: "same-origin" },
    );
  });

  it("falls through to the general handler for any other direct message", () => {
    const { bus, handlers: h } = make();
    const records = oneRecord();
    bus.acceptDirect({ t: "records", from: "child", records }, vi.fn<Receive>());
    expect(h.onRecords).toHaveBeenCalledWith(records);
  });

  it("routes a message from an attached worker to the handlers", () => {
    const { bus, handlers: h } = make();
    const addEventListener = vi.fn();
    bus.attachWorker({
      postMessage: vi.fn(),
      addEventListener,
      removeEventListener: vi.fn(),
    });

    const listener = addEventListener.mock.calls[0][1] as (event: MessageEvent) => void;
    const records = oneRecord();
    listener(
      new MessageEvent("message", {
        data: envelope({ t: "records", from: "worker-1", records }),
      }),
    );

    expect(h.onRecords).toHaveBeenCalledWith(records);
  });

  it("posts a journey message to every open link", () => {
    const { bus } = make();
    const link = fakeLink("broadcast");
    (bus as unknown as { links: Link[] }).links.push(link);

    const j = fakeJourney();
    bus.broadcastJourney(j);

    expect(link.post).toHaveBeenCalledWith({
      t: "journey",
      from: "ctx-1",
      journey: j,
    });
  });
});

describe("BootBuffer", () => {
  const bootBuffer = (maxBootBufferRecords = 2) => {
    const diagnostics = new Diagnostics(vi.fn<(event: DiagnosticEvent) => void>(), 0);
    const config = resolveConfig(
      {
        endpoint: "https://x/v1/logs",
        serviceName: "svc",
        bus: { maxBootBufferRecords },
      },
      diagnostics,
    );
    return { buffer: new BootBuffer(config, diagnostics), diagnostics };
  };

  it("holds records under the cap with nothing dropped", () => {
    const { buffer, diagnostics } = bootBuffer(2);
    buffer.push(oneRecord()[0]);
    buffer.push(oneRecord()[0]);

    expect(buffer.release()).toHaveLength(2);
    expect(diagnostics.snapshot()["record.dropped_boot_buffer_full"]).toBeUndefined();
  });

  it("drops the oldest record and counts it once the cap is reached", () => {
    const { buffer, diagnostics } = bootBuffer(2);
    const first = { body: "first" } as unknown as LogRecord;
    const second = { body: "second" } as unknown as LogRecord;
    const third = { body: "third" } as unknown as LogRecord;

    buffer.push(first);
    buffer.push(second);
    buffer.push(third);

    const released = buffer.release();
    expect(released.map((r) => r.body)).toEqual(["second", "third"]);
    expect(diagnostics.snapshot()["record.dropped_boot_buffer_full"]).toBe(1);
  });

  it("empties on release, so a second call returns nothing", () => {
    const { buffer } = bootBuffer(5);
    buffer.push(oneRecord()[0]);

    buffer.release();

    expect(buffer.release()).toEqual([]);
  });
});
