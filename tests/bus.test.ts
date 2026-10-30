import { describe, it, expect, vi } from "vitest";
import { Bus, type HandshakeOptions } from "../src/bus/bus";
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
import { applyRemote } from "../src/core/remote-rules";
import type { RemoteSampling, RemoteSlot, RemoteWire } from "../src/core/remote-sampling";
import {
  envelope,
  unwrap,
  type BusEnvelope,
  type BusMessage,
  type LinkKind,
  type MessageSource,
} from "../src/models/bus";
import type { BusOptions } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";
import { BUS_CHANNEL_NAME, BUS_PROTOCOL, REMOTE_SAMPLING_POLL_MS } from "../src/constants";

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
  remote: { sampling: null } as RemoteSlot,
});

const platform = (over = {}) => ({
  platform: "browser" as const,
  openfinUuid: "app-1",
  userAgent: "test",
  isWorker: false,
  isTopLevelDocument: true,
  ...over,
});

const fakeLink = (kind: LinkKind) => ({ kind, post: vi.fn(), close: vi.fn() });

function make(
  over: Partial<BusOptions> & Partial<HandshakeOptions> = {},
  platformOver = {},
  ctx = "ctx-1",
) {
  const { timeoutMs, maxAttempts, ...busOver } = over;
  const diagnostics = new Diagnostics(vi.fn<(event: DiagnosticEvent) => void>(), 0);
  const config = resolveConfig(
    {
      endpoint: "https://x/v1/logs",
      serviceName: "svc",
      bus: busOver,
    },
    diagnostics,
  );
  const handshake: HandshakeOptions = {
    timeoutMs: timeoutMs ?? 20,
    maxAttempts: maxAttempts ?? 3,
  };
  const h = handlers();
  return {
    bus: new Bus(config, diagnostics, platform(platformOver), ctx, "tab-1", h, handshake),
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
  const PARENT = "https://app.example";

  /**
   * Makes this document a frame whose parent is on an origin.
   * @param origin Origin that document.referrer gives.
   * @returns The fake parent window.
   */
  function frameOf(origin: string) {
    const postMessage = vi.fn();
    const fakeParent = { postMessage } as unknown as Window & typeof globalThis;
    vi.spyOn(window, "parent", "get").mockReturnValue(fakeParent);
    vi.spyOn(document, "referrer", "get").mockReturnValue(`${origin}/page`);
    return { fakeParent, postMessage };
  }

  /**
   * Dispatches a bus message as if a window posted it.
   * @param source Window that posted the message.
   * @param origin Origin of the poster.
   */
  function postFrom(source: unknown, origin: string): void {
    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "hello", from: "parent-ctx", tabId: "tab-9" }),
        }),
        { source, origin },
      ),
    );
  }

  it("returns null when there is no window", () => {
    vi.stubGlobal("window", undefined);
    expect(createParentLink(vi.fn<Receive>(), [], diag())).toBeNull();
  });

  it("returns null at the top level", () => {
    expect(createParentLink(vi.fn<Receive>(), [], diag())).toBeNull();
  });

  it("returns null and reports when the origin of the parent is unknown", () => {
    vi.spyOn(window, "parent", "get").mockReturnValue({} as Window & typeof globalThis);
    const handler = vi.fn<(event: DiagnosticEvent) => void>();

    expect(createParentLink(vi.fn<Receive>(), [PARENT], new Diagnostics(handler, 0))).toBeNull();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "bus.untrusted_origin",
        message: "The origin of the parent frame is unknown. This context sends its own records.",
      }),
    );
  });

  it("reads a referrer that is not a URL as an unknown origin", () => {
    frameOf(PARENT);
    vi.spyOn(document, "referrer", "get").mockReturnValue("not a url");

    expect(createParentLink(vi.fn<Receive>(), [PARENT], diag())).toBeNull();
  });

  it("returns null and reports when the parent is on an origin that is not trusted", () => {
    frameOf("https://evil.example");
    const handler = vi.fn<(event: DiagnosticEvent) => void>();

    expect(createParentLink(vi.fn<Receive>(), [PARENT], new Diagnostics(handler, 0))).toBeNull();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "bus.untrusted_origin",
        message:
          "The parent frame is on https://evil.example. This origin is not in bus.trustedOrigins. This context sends its own records.",
        detail: { origin: "https://evil.example", type: "parent" },
      }),
    );
  });

  it("returns null and names the fix when this frame is sandboxed", () => {
    frameOf(PARENT);
    vi.stubGlobal("location", { origin: "null" });
    const handler = vi.fn<(event: DiagnosticEvent) => void>();

    expect(createParentLink(vi.fn<Receive>(), [PARENT], new Diagnostics(handler, 0))).toBeNull();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "bus.untrusted_origin",
        message:
          'This frame is sandboxed without allow-same-origin. It has an opaque origin. No parent can trust it. This context sends its own records. Set bus.mode: "sender" in the frame. Add allow-same-origin to the sandbox attribute only for content that you trust.',
      }),
    );
  });

  it("reads the parent origin from location.ancestorOrigins before the referrer", () => {
    const { postMessage } = frameOf("https://other.example");
    vi.stubGlobal("location", {
      origin: location.origin,
      ancestorOrigins: { length: 1, item: () => PARENT },
    });

    const link = createParentLink(vi.fn<Receive>(), [PARENT], diag());
    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });

    expect(postMessage).toHaveBeenCalledWith(expect.anything(), PARENT);
    link?.close();
  });

  it("trusts a parent on its own origin without a list", () => {
    frameOf(location.origin);

    const link = createParentLink(vi.fn<Receive>(), [], diag());

    expect(link).not.toBeNull();
    link?.close();
  });

  it("delivers a message from the trusted parent and ignores one from elsewhere", () => {
    const { fakeParent } = frameOf(PARENT);
    const receive = vi.fn<Receive>();
    const link = createParentLink(receive, [PARENT], diag());

    postFrom(fakeParent, PARENT);
    expect(receive).toHaveBeenCalledWith(
      { t: "hello", from: "parent-ctx", tabId: "tab-9" },
      { link: "parent", origin: PARENT },
    );

    receive.mockClear();
    postFrom({}, PARENT);
    expect(receive).not.toHaveBeenCalled();

    link?.close();
  });

  it("drops a message from the parent window on another origin, and reports each origin once", () => {
    const { fakeParent } = frameOf(PARENT);
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const receive = vi.fn<Receive>();
    const link = createParentLink(receive, [PARENT], new Diagnostics(handler, 0));

    // The parent navigated to another origin after this frame loaded.
    postFrom(fakeParent, "https://evil.example");
    postFrom(fakeParent, "https://evil.example");
    postFrom(fakeParent, "null");

    expect(receive).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "The bus ignored a message from https://evil.example. If you own this origin, add it to bus.trustedOrigins.",
        detail: { origin: "https://evil.example", type: "hello" },
      }),
    );
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("from a sandboxed frame") as string,
      }),
    );
    link?.close();
  });

  it("keeps the message type of an untrusted parent out of the message, and cuts it", () => {
    const { fakeParent } = frameOf(PARENT);
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const link = createParentLink(vi.fn<Receive>(), [PARENT], new Diagnostics(handler, 0));
    const type = `Click here to fix: https://evil.example/${"x".repeat(100)}`;

    dispatchEvent(
      Object.assign(new MessageEvent("message", { data: envelope({ t: type } as never) }), {
        source: fakeParent,
        origin: "https://evil.example",
      }),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "The bus ignored a message from https://evil.example. If you own this origin, add it to bus.trustedOrigins.",
        detail: { origin: "https://evil.example", type: type.slice(0, 32) },
      }),
    );
    link?.close();
  });

  it("ignores a message with no protocol envelope", () => {
    const { fakeParent } = frameOf(PARENT);
    const receive = vi.fn<Receive>();
    const link = createParentLink(receive, [PARENT], diag());

    dispatchEvent(
      Object.assign(new MessageEvent("message", { data: { not: "ours" } }), {
        source: fakeParent,
        origin: PARENT,
      }),
    );
    expect(receive).not.toHaveBeenCalled();
    link?.close();
  });

  it("posts to the origin of the parent, not to *, and reports a failure when it throws", () => {
    const { postMessage } = frameOf(PARENT);
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const link = createParentLink(vi.fn<Receive>(), [PARENT], new Diagnostics(handler, 0));

    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(postMessage).toHaveBeenCalledWith(
      envelope({ t: "hello", from: "ctx-1", tabId: "tab-1" }),
      PARENT,
    );

    postMessage.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));
    link?.close();
  });

  it("stops delivering once closed", () => {
    const { fakeParent } = frameOf(PARENT);
    const receive = vi.fn<Receive>();
    const link = createParentLink(receive, [PARENT], diag());
    link?.close();

    postFrom(fakeParent, PARENT);
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

  it("names a sandboxed child and its fix in the report", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const link = createChildrenLink(vi.fn<Receive>(), [], new Diagnostics(handler, 0));

    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "records", from: "child", records: [] }),
        }),
        { origin: "null" },
      ),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'The bus ignored a message from a sandboxed frame. The frame has an opaque origin. Set bus.mode: "sender" in the frame. Add allow-same-origin to the sandbox attribute only for content that you trust.',
      }),
    );
    link?.close();
  });

  it("drops a message from a sandboxed child when this frame is sandboxed too", () => {
    vi.stubGlobal("location", { origin: "null" });
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const receive = vi.fn<Receive>();
    const link = createChildrenLink(receive, [], new Diagnostics(handler, 0));

    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "records", from: "child", records: [] }),
        }),
        { origin: "null" },
      ),
    );

    expect(receive).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "bus.untrusted_origin",
        detail: { origin: "null", type: "records" },
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
    expect(child.postMessage).toHaveBeenCalledWith(
      envelope({ t: "journey?", from: "ctx-1" }),
      window.location.origin,
    );

    child.closed = true;
    child.postMessage.mockClear();
    link?.post({ t: "journey?", from: "ctx-1" });
    expect(child.postMessage).not.toHaveBeenCalled();

    link?.close();
  });

  it("posts to the origin a child spoke from, never a wildcard", () => {
    const link = createChildrenLink(vi.fn<Receive>(), ["https://trusted.example"], diag());
    const child = { closed: false, postMessage: vi.fn() };

    dispatchEvent(
      Object.assign(
        new MessageEvent("message", {
          data: envelope({ t: "hello", from: "child", tabId: "t" }),
        }),
        {
          origin: "https://trusted.example",
          source: child,
        },
      ),
    );
    link?.post({ t: "journey?", from: "ctx-1" });

    expect(child.postMessage).toHaveBeenCalledWith(
      envelope({ t: "journey?", from: "ctx-1" }),
      "https://trusted.example",
    );
    link?.close();
  });

  it("retargets a source that moved to another trusted origin", () => {
    const link = createChildrenLink(vi.fn<Receive>(), ["https://trusted.example"], diag());
    const child = { closed: false, postMessage: vi.fn() };
    const hello = (origin: string): void => {
      dispatchEvent(
        Object.assign(
          new MessageEvent("message", {
            data: envelope({ t: "hello", from: "child", tabId: "t" }),
          }),
          { origin, source: child },
        ),
      );
    };

    hello("https://trusted.example");
    hello(window.location.origin);
    link?.post({ t: "journey?", from: "ctx-1" });

    expect(child.postMessage).toHaveBeenCalledOnce();
    expect(child.postMessage).toHaveBeenCalledWith(
      envelope({ t: "journey?", from: "ctx-1" }),
      window.location.origin,
    );
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
    // Use a function expression, not vi.fn. The code calls the constructor with `new`. Vitest warns
    // when a mock implementation is not a function or a class.
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
    expect(createOpenFinLink("topic", "app-1", vi.fn<Receive>(), diag())).toBeNull();
    vi.stubGlobal("fin", {});
    expect(createOpenFinLink("topic", "app-1", vi.fn<Receive>(), diag())).toBeNull();
  });

  it("returns null and reports when the application uuid is unknown", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const iab = fakeIab();
    vi.stubGlobal("fin", { InterApplicationBus: iab });

    expect(
      createOpenFinLink("topic", undefined, vi.fn<Receive>(), new Diagnostics(handler, 0)),
    ).toBeNull();
    expect(iab.subscribe).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "openfin.unavailable" }));
  });

  it("scopes the topic and the subscriber identity to one application", async () => {
    const iab = fakeIab();
    vi.stubGlobal("fin", { InterApplicationBus: iab });
    const receive = vi.fn<Receive>();

    createOpenFinLink("topic", "app-1", receive, diag());
    await vi.waitFor(() => {
      expect(iab.subscribe).toHaveBeenCalledWith(
        { uuid: "app-1" },
        "topic.app-1",
        expect.any(Function),
      );
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

    createOpenFinLink("topic", "app-1", vi.fn<Receive>(), new Diagnostics(handler, 0));
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "bus.send_failed" }));
    });
  });

  it("publishes on the scoped topic, and reports rather than throwing when it rejects", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const iab = fakeIab();
    vi.stubGlobal("fin", { InterApplicationBus: iab });
    const link = createOpenFinLink("topic", "app-1", vi.fn<Receive>(), new Diagnostics(handler, 0));

    link?.post({ t: "hello", from: "ctx-1", tabId: "tab-1" });
    await vi.waitFor(() => {
      expect(iab.publish).toHaveBeenCalledWith(
        "topic.app-1",
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
      { timeoutMs: 20, maxAttempts: 3 },
    );

    // No parent replies. In this environment, window.parent === window. createParentLink then
    // returns null. The role resolves without a handshake.
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
    const { bus } = make({ timeoutMs: 1000 }, { isWorker: true, isTopLevelDocument: false });
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
        bus: { openFinRole: "client" },
      },
      diagnostics,
    );
    // This is the real OpenFin desktop shape. A real view is always its own top-level document. The
    // control-link path and the candidate-link path for "openfin" both run. They share the one
    // memoized subscription.
    const bus = new Bus(
      config,
      diagnostics,
      platform({ platform: "openfin" }),
      "ctx-1",
      "tab-1",
      handlers(),
      { timeoutMs: 5, maxAttempts: 2 },
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
      { timeoutMs: 5, maxAttempts: 3 },
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
    // This is the OpenFin and worker case. Neither channel fires a `message` event. A handshake
    // that listens only for that event times out here each time.
    const { bus } = make({ timeoutMs: 1000 });
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
    const { bus } = make({ timeoutMs: 30 });
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
    const { bus } = make({ timeoutMs: 20 });
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
    const { bus } = make({ timeoutMs: 1000 });
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

  it("relays a grandchild's records when both links in the chain are direct", () => {
    // A same-origin frame holding another same-origin frame. Both attach by a
    // direct call, so the two links share a kind while being different links.
    const { bus, handlers: h } = make();
    const upstream = fakeLink("direct");
    const internals = bus as unknown as { role: string; upstream: Link | null };
    internals.role = "forwarder";
    internals.upstream = upstream;

    deliver(
      bus,
      { t: "records", from: "grandchild", records: oneRecord() },
      { link: "direct", origin: "same-origin" },
    );

    expect(h.onRecords).not.toHaveBeenCalled();
    expect(upstream.post).toHaveBeenCalledWith(expect.objectContaining({ t: "records" }));
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

  it("adopts a journey pushed from elsewhere in origin scope, including a cleared one", () => {
    const { bus, handlers: h, config } = make();
    config.journey.scope = "origin";
    const j = fakeJourney();

    deliver(
      bus,
      { t: "journey", from: "peer", journey: j },
      { link: "broadcast", origin: "same-origin" },
    );
    expect(h.onJourney).toHaveBeenCalledWith(expect.objectContaining({ id: j.id }));

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
      to: "child",
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

  it("resolves retry cross-origin and promote otherwise", () => {
    expect(orphanPolicyOf()).toBe("promote");

    vi.spyOn(window, "parent", "get").mockReturnValue(crossOriginParent());
    expect(orphanPolicyOf()).toBe("retry");
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

  it("asks the parent link with bus.trustedOrigins when this document is not top level", () => {
    vi.spyOn(window, "parent", "get").mockReturnValue({
      postMessage: vi.fn(),
    } as unknown as Window & typeof globalThis);
    vi.spyOn(document, "referrer", "get").mockReturnValue("https://app.example/page");

    expect(call({}, { isTopLevelDocument: false })).toBeNull();
    expect(
      call({ trustedOrigins: ["https://app.example"] }, { isTopLevelDocument: false })?.kind,
    ).toBe("parent");
  });

  it("forwards to the OpenFin provider only when it is not the provider itself", () => {
    vi.stubGlobal("fin", { InterApplicationBus: fakeIab() });
    expect(call({}, { platform: "openfin" }, false)?.kind).toBe("openfin");
  });

  it("does not forward when it is itself the OpenFin provider", () => {
    vi.stubGlobal("fin", { InterApplicationBus: fakeIab() });
    expect(call({}, { platform: "openfin" }, true)).toBeNull();
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

  it("scopes the link to the application uuid detected for this context", async () => {
    const iab = fakeIab();
    vi.stubGlobal("fin", { InterApplicationBus: iab });
    const { bus } = make({}, { platform: "openfin", openfinUuid: "app-2" });

    (bus as unknown as { ensureOpenFinLink: () => Link | null }).ensureOpenFinLink();

    await vi.waitFor(() => {
      expect(iab.subscribe).toHaveBeenCalledWith(
        { uuid: "app-2" },
        `${BUS_CHANNEL_NAME}.app-2`,
        expect.any(Function),
      );
    });
  });

  it("opens no link when the OpenFin identity is unknown", () => {
    const iab = fakeIab();
    vi.stubGlobal("fin", { InterApplicationBus: iab });
    const { bus } = make({}, { platform: "openfin", openfinUuid: undefined });

    expect(
      (bus as unknown as { ensureOpenFinLink: () => Link | null }).ensureOpenFinLink(),
    ).toBeNull();
    expect(iab.subscribe).not.toHaveBeenCalled();
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
    // Without BroadcastChannel, createBroadcastLink returns null. The bus adds no link. A top-level
    // document then opens only the children link.
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
      { t: "journey", from: "ctx-1", to: "child", journey: j },
      { link: "direct", origin: "same-origin" },
    );
  });

  it("answers no direct journey question in context scope", () => {
    const { bus, handlers: h, config } = make();
    config.journey.scope = "context";
    const reply = vi.fn<Receive>();

    h.onJourneyRequest.mockReturnValueOnce(fakeJourney());
    bus.acceptDirect({ t: "journey?", from: "child" }, reply);

    expect(reply).not.toHaveBeenCalled();
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

  it("posts a journey message to each link of the journey scope", () => {
    const { bus, config } = make();
    const broadcast = fakeLink("broadcast");
    const children = fakeLink("children");
    (bus as unknown as { links: Link[] }).links.push(broadcast, children);
    const j = fakeJourney();
    const message = { t: "journey", from: "ctx-1", journey: j };

    bus.broadcastJourney(j);
    expect(children.post).toHaveBeenCalledWith(message);
    expect(broadcast.post).not.toHaveBeenCalled();

    config.journey.scope = "origin";
    bus.broadcastJourney(j);
    expect(broadcast.post).toHaveBeenCalledWith(message);
  });
});

describe("Bus journey scope", () => {
  const internals = (bus: Bus) =>
    bus as unknown as {
      role: string;
      upstream: Link | null;
      ownerId: string | null;
      awaitingWelcome: { link: LinkKind; settle: (ok: boolean) => void } | null;
    };

  /**
   * Makes a forwarder whose owner sits on a parent link.
   * @param ownerId Context id of the owner, or null for a link with no handshake.
   * @returns The bus and its handlers.
   */
  function forwarderOf(ownerId: string | null) {
    const made = make();
    const state = internals(made.bus);
    state.role = "forwarder";
    state.upstream = fakeLink("parent");
    state.ownerId = ownerId;
    return made;
  }

  const fromParent: MessageSource = { link: "parent", origin: "https://app.example" };

  it("tab: a sender adopts no journey from a child or from another tab", () => {
    const { bus, handlers: h } = make();

    deliver(
      bus,
      { t: "journey", from: "child", journey: fakeJourney() },
      {
        link: "children",
        origin: "https://app.example",
      },
    );
    deliver(
      bus,
      { t: "journey", from: "tab-2", journey: fakeJourney() },
      {
        link: "broadcast",
        origin: "same-origin",
      },
    );

    expect(h.onJourney).not.toHaveBeenCalled();
  });

  it("tab: a forwarder adopts a journey from its owner only", () => {
    const { bus, handlers: h } = forwarderOf("owner-ctx");
    const j = fakeJourney();

    deliver(bus, { t: "journey", from: "sibling", journey: fakeJourney({ id: "j2" }) }, fromParent);
    deliver(bus, { t: "journey", from: "owner-ctx", journey: j }, fromParent);
    deliver(
      bus,
      { t: "journey", from: "owner-ctx", journey: j },
      {
        link: "children",
        origin: "https://app.example",
      },
    );

    expect(h.onJourney).toHaveBeenCalledTimes(1);
    expect(h.onJourney).toHaveBeenCalledWith(expect.objectContaining({ id: "j1" }));
  });

  it("tab: a forwarder with no handshake adopts each journey on its upstream link", () => {
    const { bus, handlers: h } = forwarderOf(null);

    deliver(bus, { t: "journey", from: "parent-ctx", journey: fakeJourney() }, fromParent);

    expect(h.onJourney).toHaveBeenCalledTimes(1);
  });

  it("keeps the owner that answered the handshake, and forgets it on destroy", () => {
    const { bus } = make();
    const state = internals(bus);
    state.awaitingWelcome = { link: "parent", settle: vi.fn() };

    deliver(bus, { t: "welcome", from: "owner-ctx", to: "ctx-1", tabId: "t" }, fromParent);
    expect(state.ownerId).toBe("owner-ctx");

    bus.destroy();
    expect(state.ownerId).toBeNull();
  });

  it("ignores a journey reply addressed to another context", () => {
    const { bus, handlers: h } = forwarderOf("owner-ctx");

    deliver(
      bus,
      { t: "journey", from: "owner-ctx", to: "ctx-9", journey: fakeJourney() },
      fromParent,
    );
    deliver(
      bus,
      { t: "journey", from: "owner-ctx", to: "ctx-1", journey: fakeJourney() },
      fromParent,
    );

    expect(h.onJourney).toHaveBeenCalledTimes(1);
  });

  it("drops a journey whose payload is not a journey, and reports it", () => {
    const { bus, handlers: h, diagnostics } = forwarderOf("owner-ctx");

    deliver(bus, { t: "journey", from: "owner-ctx", journey: { id: 1 } }, fromParent);

    expect(h.onJourney).not.toHaveBeenCalled();
    expect(diagnostics.snapshot()["record.dropped_malformed"]).toBe(1);
  });

  it("origin: adopts a journey from each context, also from another tab", () => {
    const { bus, handlers: h, config } = make();
    config.journey.scope = "origin";

    deliver(
      bus,
      { t: "journey", from: "child", journey: fakeJourney() },
      {
        link: "children",
        origin: "https://app.example",
      },
    );
    deliver(
      bus,
      { t: "journey", from: "tab-2", journey: fakeJourney() },
      {
        link: "broadcast",
        origin: "same-origin",
      },
    );

    expect(h.onJourney).toHaveBeenCalledTimes(2);
  });

  it("auto: uses origin scope in OpenFin", () => {
    const { bus, handlers: h } = make({}, { platform: "openfin" });

    deliver(
      bus,
      { t: "journey", from: "view-2", journey: fakeJourney() },
      {
        link: "openfin",
        origin: "openfin",
      },
    );

    expect(h.onJourney).toHaveBeenCalledTimes(1);
  });

  it("auto: uses origin scope in OpenFin Core Web", () => {
    // View B of a Core Web platform adopts the journey of view A over the broadcast link.
    const { bus, handlers: h } = make({}, { platform: "openfin_web" });

    deliver(
      bus,
      { t: "journey", from: "view-a", journey: fakeJourney() },
      { link: "broadcast", origin: "same-origin" },
    );

    expect(h.onJourney).toHaveBeenCalledTimes(1);
  });

  it("context: adopts no journey, sends none and answers no question", () => {
    const { bus, handlers: h, config } = forwarderOf(null);
    config.journey.scope = "context";
    const children = fakeLink("children");
    (bus as unknown as { links: Link[] }).links.push(children);
    h.onJourneyRequest.mockReturnValue(fakeJourney());

    deliver(bus, { t: "journey", from: "parent-ctx", journey: fakeJourney() }, fromParent);
    deliver(
      bus,
      { t: "journey?", from: "child" },
      {
        link: "children",
        origin: "https://app.example",
      },
    );
    bus.broadcastJourney(fakeJourney());

    expect(h.onJourney).not.toHaveBeenCalled();
    expect(children.post).not.toHaveBeenCalled();
  });
});

describe("Bus remote sampling", () => {
  const wire: RemoteWire = { v: 1, ttlMs: 5000, rates: { grid: 1 } };

  /** Overlay stand-in that answers with the wire rules. */
  const stub = (): RemoteSampling => ({ wire: () => wire }) as unknown as RemoteSampling;

  /** Source of a message from a parent window on the page origin. */
  const parent = (): MessageSource => ({ link: "parent", origin: location.origin });

  /**
   * Makes a forwarder bus with a fake upstream link.
   * @param kind Kind of the upstream link.
   * @param trustedOrigins Value of bus.trustedOrigins.
   * @returns The bus, its handlers, its config and the upstream link.
   */
  function forwarder(kind: LinkKind = "parent", trustedOrigins: string[] = []) {
    const made = make({ trustedOrigins });
    const upstream = fakeLink(kind);
    const internals = made.bus as unknown as { role: string; upstream: Link | null };
    internals.role = "forwarder";
    internals.upstream = upstream;
    made.config.sampling.remote = true;

    return { ...made, upstream };
  }

  it("answers a direct sampling question, with null when no rules are in force", () => {
    const { bus, handlers: h } = make();
    const reply = vi.fn<Receive>();
    const direct = { link: "direct", origin: "same-origin" };

    bus.acceptDirect({ t: "sampling?", from: "child" }, reply);
    h.remote.sampling = stub();
    bus.acceptDirect({ t: "sampling?", from: "child" }, reply);

    // A null answer ends the copy of the forwarder. A revocation then reaches it.
    expect(reply.mock.calls).toEqual([
      [{ t: "sampling", from: "ctx-1", to: "child", rules: null }, direct],
      [{ t: "sampling", from: "ctx-1", to: "child", rules: wire }, direct],
    ]);
  });

  it("answers a sampling question as a sender on a link that it owns", () => {
    const { bus, handlers: h } = make();
    const link = fakeLink("children");
    (bus as unknown as { links: Link[] }).links.push(link);

    h.remote.sampling = stub();
    deliver(bus, { t: "sampling?", from: "child" }, { link: "children", origin: location.origin });

    expect(link.post).toHaveBeenCalledWith({
      t: "sampling",
      from: "ctx-1",
      to: "child",
      rules: wire,
    });
  });

  it("does not answer as a sender on a link that it does not own", () => {
    const { bus } = make();
    const link = fakeLink("broadcast");
    (bus as unknown as { links: Link[] }).links.push(link);

    deliver(bus, { t: "sampling?", from: "tab-2" }, { link: "broadcast", origin: "same-origin" });

    expect(link.post).not.toHaveBeenCalled();
  });

  it("answers its own children as a forwarder, and never a sibling on its upstream link", () => {
    const { bus, upstream } = forwarder("openfin");
    const worker = fakeLink("worker");
    (bus as unknown as { links: Link[] }).links.push(worker);

    deliver(bus, { t: "sampling?", from: "sibling" }, { link: "openfin", origin: "openfin" });
    deliver(bus, { t: "sampling?", from: "child" }, { link: "worker", origin: "same-origin" });

    // A sibling answer on OpenFin gives N squared messages, and a stale copy can win.
    expect(upstream.post).not.toHaveBeenCalled();
    expect(worker.post).toHaveBeenCalledWith({
      t: "sampling",
      from: "ctx-1",
      to: "child",
      rules: null,
    });
  });

  it("applies rules from the upstream link that name this context", () => {
    const { bus, handlers: h } = forwarder();

    deliver(bus, { t: "sampling", from: "owner", to: "ctx-1", rules: wire }, parent());

    expect(h.remote.sampling?.current()).toEqual({ rates: { grid: 1 } });
  });

  it("applies rules from the owner link of a worker", () => {
    const { bus, handlers: h } = forwarder("owner");

    deliver(
      bus,
      { t: "sampling", from: "owner", to: "ctx-1", rules: wire },
      { link: "owner", origin: "same-origin" },
    );

    expect(h.remote.sampling).not.toBeNull();
  });

  it("ends its copy of the rules when the upstream has none", () => {
    const { bus, handlers: h, config } = forwarder();
    const none = { t: "sampling", from: "owner", to: "ctx-1", rules: null } as const;

    deliver(bus, none, parent());
    expect(h.remote.sampling).toBeNull();

    applyRemote(h.remote, config, { rules: { rates: {} }, ttlMs: 60_000 });
    deliver(bus, none, parent());

    expect(h.remote.sampling?.current()).toBeNull();
  });

  it("accepts rules from a parent on a trusted origin", () => {
    const { bus, handlers: h } = forwarder("parent", ["https://shell.example"]);

    deliver(
      bus,
      { t: "sampling", from: "owner", to: "ctx-1", rules: wire },
      { link: "parent", origin: "https://shell.example" },
    );

    expect(h.remote.sampling).not.toBeNull();
  });

  it("refuses rules from a parent on an origin that is not trusted, and reports it", () => {
    const { bus, handlers: h, diagnostics } = forwarder();

    // A hostile page can embed the app. It must not lower minLevel and read the DEBUG records.
    deliver(
      bus,
      { t: "sampling", from: "owner", to: "ctx-1", rules: wire },
      { link: "parent", origin: "https://evil.example" },
    );

    expect(h.remote.sampling).toBeNull();
    expect(diagnostics.snapshot()["bus.untrusted_origin"]).toBe(1);
  });

  it("refuses rules from another link, for another context, or as a sender", () => {
    const { bus, handlers: h } = forwarder();

    deliver(
      bus,
      { t: "sampling", from: "peer", to: "ctx-1", rules: wire },
      { link: "broadcast", origin: "same-origin" },
    );
    deliver(bus, { t: "sampling", from: "owner", to: "ctx-2", rules: wire }, parent());
    (bus as unknown as { role: string }).role = "sender";
    deliver(bus, { t: "sampling", from: "owner", to: "ctx-1", rules: wire }, parent());

    expect(h.remote.sampling).toBeNull();
  });

  it("refuses rules that are not valid, and reports them", () => {
    const { bus, handlers: h, diagnostics } = forwarder();

    deliver(
      bus,
      { t: "sampling", from: "owner", to: "ctx-1", rules: { v: 1, ttlMs: -1 } },
      parent(),
    );

    expect(h.remote.sampling).toBeNull();
    expect(diagnostics.snapshot()["config.invalid"]).toBe(1);
  });

  it("asks the upstream for rules at start and at each poll while remote sampling is on", () => {
    vi.useFakeTimers();
    const { bus, upstream, config } = forwarder();
    const poll = () => (bus as unknown as { pollRules: () => void }).pollRules();
    const ask = { t: "sampling?", from: "ctx-1" };

    poll();
    config.sampling.remote = false;
    vi.advanceTimersByTime(REMOTE_SAMPLING_POLL_MS);
    config.sampling.remote = true;
    vi.advanceTimersByTime(REMOTE_SAMPLING_POLL_MS);
    bus.destroy();
    vi.advanceTimersByTime(REMOTE_SAMPLING_POLL_MS);

    expect(upstream.post.mock.calls).toEqual([[ask], [ask]]);
    vi.useRealTimers();
  });

  it("does not poll as a sender, without an upstream, or after destroy", () => {
    vi.useFakeTimers();
    const sender = make();
    sender.config.sampling.remote = true;
    (sender.bus as unknown as { pollRules: () => void }).pollRules();

    const orphan = forwarder();
    (orphan.bus as unknown as { upstream: Link | null }).upstream = null;
    (orphan.bus as unknown as { pollRules: () => void }).pollRules();

    // A shutdown during a handshake must not leave a timer when the welcome arrives later.
    const stopped = forwarder();
    stopped.bus.destroy();
    (stopped.bus as unknown as { upstream: Link | null }).upstream = stopped.upstream;
    (stopped.bus as unknown as { pollRules: () => void }).pollRules();

    expect(vi.getTimerCount()).toBe(0);
    expect(stopped.upstream.post).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
