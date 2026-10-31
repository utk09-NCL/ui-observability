// src/capture/web-socket.ts
//
// Records the open, close and error events of each WebSocket. It counts the messages by direction
// and server. It never reads the content of a message. It is a capture plugin, and the runtime
// loads it as a separate chunk.

import { WEBSOCKET_MAX_PER_WINDOW } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { Counter, MetricAttributes } from "../models/metric";
import type { CapturePlugin, PluginContext } from "../models/plugin";
import { patch } from "../utils/patch";
import { allowInWindow, type StormWindow } from "./storm";

/** Name of the message counter. */
const MESSAGES_METRIC = "ui.websocket.messages";

/** Data of one WebSocket.send call. */
type SendData = Parameters<WebSocket["send"]>[0];

/** State of one install. A wrapper that stays after uninstall reads it and records nothing. */
interface InstallState {
  /** False after uninstall. */
  active: boolean;
  /** Tools of the plugin. */
  ctx: PluginContext;
  /** Counter of the messages. */
  messages: Counter;
  /** Server host name of each tracked socket. */
  servers: WeakMap<WebSocket, string>;
}

/**
 * Removes the user info, the query and the fragment from a socket URL. They can hold a token.
 * @param url Absolute URL of the socket.
 * @returns The URL to record and the host name of the server.
 */
function socketTarget(url: string): { target: string; server: string } {
  const parsed = new URL(url);

  return {
    target: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
    server: parsed.hostname,
  };
}

/**
 * Counts one message of a tracked socket.
 * @param state State of the install that made the socket.
 * @param socket Socket of the message.
 * @param direction Direction of the message.
 */
function count(state: InstallState, socket: WebSocket, direction: "transmit" | "receive"): void {
  const server = state.servers.get(socket);

  if (!state.active || server === undefined) {
    return;
  }

  const attributes: MetricAttributes = {
    "network.io.direction": direction,
    "server.address": server,
  };
  state.messages.add(1, attributes);
}

/** Records the lifecycle and the message counts of each WebSocket that the app opens. */
export class WebSocketCapture implements CapturePlugin {
  /** Capture module identifier. */
  readonly name = "websocket";

  /** Restores the WebSocket constructor. Undefined when the capture is not installed. */
  private restore: (() => boolean) | undefined;

  /** State of the active install. */
  private state: InstallState | undefined;

  /** Rate limit of the lifecycle records. A reconnect loop must not flood the pipeline. */
  private readonly window: StormWindow = { start: 0, count: 0 };

  /**
   * @param diagnostics Diagnostics reporter.
   */
  constructor(private readonly diagnostics: Diagnostics) {}

  /**
   * Replaces the WebSocket constructor with a subclass that tracks each socket.
   * @param ctx Tools of the plugin.
   */
  install(ctx: PluginContext): void {
    if (this.restore || typeof WebSocket === "undefined") {
      return;
    }

    const state: InstallState = {
      active: true,
      ctx,
      messages: ctx.counter(MESSAGES_METRIC),
      servers: new WeakMap(),
    };
    this.state = state;

    const track = (socket: WebSocket): void => {
      this.track(socket, state);
    };

    this.restore = patch(
      globalThis,
      "WebSocket",
      (Original) =>
        class TrackedWebSocket extends Original {
          /**
           * @param url URL of the server.
           * @param protocols Sub-protocols of the app.
           */
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            track(this);
          }

          /**
           * Sends the data, then counts one message. A send that throws counts nothing.
           * @param data Data of the app. The library does not read it.
           */
          override send(data: SendData): void {
            super.send(data);
            count(state, this, "transmit");
          }
        },
    );
  }

  /** Restores the WebSocket constructor and stops each tracked socket from recording. */
  uninstall(): void {
    if (this.state) {
      this.state.active = false;
    }

    // Another script can wrap the constructor after the library. Keep its wrapper.
    if (this.restore && !this.restore()) {
      this.diagnostics.count("capture.install_failed");
    }

    this.restore = undefined;
    this.state = undefined;
  }

  /**
   * Adds the listeners that record the lifecycle and the received messages of one socket.
   * @param socket New socket of the app.
   * @param state State of the install that made the socket.
   */
  private track(socket: WebSocket, state: InstallState): void {
    if (!state.active) {
      return;
    }

    // A read here runs inside the constructor call of the app. A throw must not fail it.
    this.diagnostics.guard(
      "capture.record_failed",
      "The library could not track a WebSocket. The socket works without capture.",
      () => {
        const { target, server } = socketTarget(socket.url);
        const attributes = { "url.full": target, "server.address": server };
        const { logger } = state.ctx;
        state.servers.set(socket, server);

        const lifecycle = (write: () => void): void => {
          if (this.allow(state)) {
            write();
          }
        };

        socket.addEventListener("open", () => {
          lifecycle(() => {
            logger.logEvent("websocket.open", attributes);
          });
        });
        socket.addEventListener("error", () => {
          lifecycle(() => {
            logger.warn("websocket.error", attributes);
          });
        });
        socket.addEventListener("close", (event) => {
          lifecycle(() => {
            logger.logEvent("websocket.close", {
              ...attributes,
              "websocket.close.code": event.code,
              "websocket.close.clean": event.wasClean,
            });
          });
        });
        socket.addEventListener("message", () => {
          count(state, socket, "receive");
        });
      },
    );
  }

  /**
   * Tests if a lifecycle record can go out.
   * @param state State of the install that made the socket.
   * @returns False after uninstall, or when the window has no allowance left.
   */
  private allow(state: InstallState): boolean {
    return (
      state.active &&
      allowInWindow(this.window, WEBSOCKET_MAX_PER_WINDOW, this.diagnostics, "WebSocket events")
    );
  }
}
