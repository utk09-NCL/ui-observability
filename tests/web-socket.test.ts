// tests/web-socket.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketCapture } from "../src/capture/web-socket";
import { WEBSOCKET_MAX_PER_WINDOW } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { OneLogger } from "../src/core/logger";
import type { MetricAttributes } from "../src/models/metric";
import type { PluginContext } from "../src/models/plugin";
import { runAsLibraryRequest } from "../src/utils/library-request";

const URL_WITH_SECRETS = "wss://user:pw@feed.example/prices?token=abc#x";

const TARGET = { "url.full": "wss://feed.example/prices", "server.address": "feed.example" };

/** Stand-in for the WebSocket of the browser. It opens no connection. */
class FakeSocket extends EventTarget {
  /** True to make send() throw, as a socket that is not open does. */
  static failSend = false;

  readonly url: string;

  readonly sent: unknown[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  send(data: unknown): void {
    if (FakeSocket.failSend) {
      throw new DOMException("The socket is not open.", "InvalidStateError");
    }
    this.sent.push(data);
  }
}

/**
 * Makes a socket with the WebSocket constructor in force.
 * @param url URL of the server.
 * @returns The socket.
 */
function open(url = URL_WITH_SECRETS): FakeSocket {
  const Socket = globalThis.WebSocket as unknown as new (url: string) => FakeSocket;
  return new Socket(url);
}

/**
 * Sends a close event with a code.
 * @param socket Target socket.
 * @param code Close code.
 * @param wasClean True for a clean close.
 */
function close(socket: FakeSocket, code: number, wasClean: boolean): void {
  socket.dispatchEvent(Object.assign(new Event("close"), { code, wasClean }));
}

/**
 * Builds a capture with spy tools, and installs it.
 * @param ignoreUrls URL patterns that the capture does not record.
 * @returns The capture, its spies and its diagnostic events.
 */
function setup(ignoreUrls: string[] = []) {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const logEvent = vi.fn<OneLogger["logEvent"]>();
  const warn = vi.fn<OneLogger["warn"]>();
  const add = vi.fn<(value: number, attributes?: MetricAttributes) => void>();
  const ctx = {
    logger: { logEvent, warn } as unknown as OneLogger,
    counter: () => ({ add }),
    histogram: vi.fn(),
    addBreadcrumb: vi.fn(),
    ownRequest: vi.fn(),
  } as unknown as PluginContext;
  const config = resolveConfig(
    { endpoint: null, serviceName: "svc", capture: { ignoreUrls } },
    new Diagnostics(),
  );
  const capture = new WebSocketCapture(diagnostics, config);

  capture.install(ctx);

  return { capture, ctx, logEvent, warn, add, events, diagnostics };
}

beforeEach(() => {
  FakeSocket.failSend = false;
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebSocketCapture", () => {
  it("records open, error and close with the URL without user info, query and fragment", () => {
    const { capture, logEvent, warn } = setup();
    const socket = open();

    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(new Event("error"));
    close(socket, 1006, false);

    expect(logEvent.mock.calls).toEqual([
      ["websocket.open", TARGET],
      [
        "websocket.close",
        { ...TARGET, "websocket.close.code": 1006, "websocket.close.clean": false },
      ],
    ]);
    expect(warn).toHaveBeenCalledWith("websocket.error", TARGET);
    capture.uninstall();
  });

  it("counts the messages by direction and server, and never reads the content", () => {
    const { capture, add, logEvent } = setup();
    const socket = open();

    socket.send("secret order");
    socket.dispatchEvent(new MessageEvent("message", { data: "secret fill" }));

    expect(socket.sent).toEqual(["secret order"]);
    expect(add.mock.calls).toEqual([
      [1, { "network.io.direction": "transmit", "server.address": "feed.example" }],
      [1, { "network.io.direction": "receive", "server.address": "feed.example" }],
    ]);
    expect(JSON.stringify([add.mock.calls, logEvent.mock.calls])).not.toContain("secret");
    capture.uninstall();
  });

  it("counts nothing for a send that throws, and gives the error to the app", () => {
    const { capture, add } = setup();
    const socket = open();
    FakeSocket.failSend = true;

    expect(() => {
      socket.send("x");
    }).toThrow("The socket is not open.");
    expect(add).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("restores the constructor, and records nothing for a socket after uninstall", () => {
    const { capture, logEvent, add } = setup();
    const socket = open();

    capture.uninstall();
    socket.dispatchEvent(new Event("open"));
    socket.send("x");

    expect(globalThis.WebSocket).toBe(FakeSocket);
    expect(logEvent).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("keeps a later wrapper of another script, and its own wrapper then records nothing", () => {
    const { capture, logEvent, add, events } = setup();
    const Tracked = globalThis.WebSocket;
    const Other = class extends Tracked {};
    globalThis.WebSocket = Other;

    capture.uninstall();
    const socket = open();
    socket.dispatchEvent(new Event("open"));
    socket.send("x");

    expect(globalThis.WebSocket).toBe(Other);
    expect(logEvent).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(events.map((event) => event.code)).toEqual(["capture.install_failed"]);
  });

  it("records nothing for a socket in ignoreUrls, for example the socket of a custom transport", () => {
    const { capture, logEvent, add } = setup(["feed.example/prices"]);
    const socket = open();

    socket.dispatchEvent(new Event("open"));
    socket.send("batch");
    socket.dispatchEvent(new Event("message"));

    expect(logEvent).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("does not count a send that the library makes, so a metric cannot cause the next send", () => {
    const { capture, add } = setup();
    const socket = open();

    runAsLibraryRequest(() => {
      socket.send("batch");
    });

    expect(add).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("keeps instanceof true for a socket that the app opened before the install", () => {
    const early = new FakeSocket(URL_WITH_SECRETS);
    const { capture } = setup();

    expect(early instanceof globalThis.WebSocket).toBe(true);
    expect(open() instanceof globalThis.WebSocket).toBe(true);
    capture.uninstall();
  });

  it("installs one time, and does nothing without WebSocket", () => {
    const { capture, ctx } = setup();
    const Tracked = globalThis.WebSocket;

    capture.install(ctx);
    expect(globalThis.WebSocket).toBe(Tracked);
    capture.uninstall();

    vi.stubGlobal("WebSocket", undefined);
    capture.install(ctx);
    capture.uninstall();

    expect(globalThis.WebSocket).toBeUndefined();
  });

  it("reports a socket that it cannot track, and the socket still works", () => {
    const { capture, add, events } = setup();

    const socket = open("not a url");
    socket.send("x");

    expect(socket.sent).toEqual(["x"]);
    expect(add).not.toHaveBeenCalled();
    expect(events.map((event) => event.code)).toEqual(["capture.record_failed"]);
    capture.uninstall();
  });

  it("limits the lifecycle records of a reconnect loop", () => {
    const { capture, logEvent, events } = setup();
    const socket = open();

    for (let i = 0; i <= WEBSOCKET_MAX_PER_WINDOW; i++) {
      socket.dispatchEvent(new Event("open"));
    }

    expect(logEvent).toHaveBeenCalledTimes(WEBSOCKET_MAX_PER_WINDOW);
    expect(events.map((event) => event.code)).toEqual(["capture.rate_limited"]);
    capture.uninstall();
  });
});
