// src/capture/web-socket.ts
//
// Records the open, close and error events of every WebSocket, and counts messages by direction
// and server. It never reads message content. This is a capture plugin, so the runtime loads it
// as a separate chunk.

import type { Diagnostics } from "../core/diagnostics";
import type { ResolvedConfig } from "../models/config";
import type { Counter, MetricAttributes } from "../models/metric";
import type { CapturePlugin, PluginContext } from "../models/plugin";
import { isLibraryRequest } from "../utils/library-request";
import { recordedUrl } from "../utils/platform";
import { patch } from "../utils/patch";
import { allowInWindow, type StormWindow } from "./storm";
import { matchesAny } from "./types";

/** Name of the message counter. */
const MESSAGES_METRIC = "ui.websocket.messages";

/** The data argument of one WebSocket.send call. */
type SendData = Parameters<WebSocket["send"]>[0];

/** State of one install. A wrapper left behind after uninstall reads it and records nothing. */
interface InstallState {
  /** False after uninstall. */
  active: boolean;
  /** The plugin's tools. */
  ctx: PluginContext;
  /** Message counter. */
  messages: Counter;
  /** Server host name of every tracked socket. */
  servers: WeakMap<WebSocket, string>;
  /** The delivery context that was current when each socket opened. */
  contexts: WeakMap<WebSocket, string>;
  /** Active capture settings and isolation rule. */
  config: ResolvedConfig;
}

/**
 * Strips the user info, query and fragment from a socket URL, since any of them can hold a token.
 * @param url The socket's absolute URL.
 * @param config Active capture settings.
 * @param diagnostics Diagnostics reporter, for a URL transform that throws.
 * @returns The URL to record and the server's host name.
 */
function socketTarget(
  url: string,
  config: ResolvedConfig,
  diagnostics: Diagnostics,
): { target: string; server: string } {
  const parsed = new URL(url);

  return {
    // Ignore fullUrls. A browser can't set a header on a socket, so apps often put a token in
    // the query. Only urlTransform can record more of the URL.
    target: recordedUrl(url, false, config.capture.urlTransform, diagnostics),
    server: parsed.hostname,
  };
}

/**
 * Counts one message on a tracked socket.
 * @param state State of the install that created the socket.
 * @param socket The socket the message belongs to.
 * @param direction Direction of the message.
 */
function count(state: InstallState, socket: WebSocket, direction: "transmit" | "receive"): void {
  const server = state.servers.get(socket);

  // Don't count the library's own sends, for example a custom transport's, or one send would
  // cause the next.
  const own = direction === "transmit" && isLibraryRequest();
  if (
    !state.active ||
    server === undefined ||
    own ||
    (state.config.securityContext.isolation &&
      state.contexts.get(socket) !== state.config.securityContext.id)
  ) {
    return;
  }

  const attributes: MetricAttributes = {
    "network.io.direction": direction,
    "server.address": server,
  };
  state.messages.add(1, attributes);
}

/** Records the lifecycle and message counts of every WebSocket the app opens. */
export class WebSocketCapture implements CapturePlugin {
  /** Capture module identifier. */
  readonly name = "websocket";

  /** Restores the WebSocket constructor. Undefined while the capture isn't installed. */
  private restore: (() => boolean) | undefined;

  /** State of the active install. */
  private state: InstallState | undefined;

  /** Rate limit for the lifecycle records, so a reconnect loop can't flood the pipeline. */
  private readonly window: StormWindow = { start: 0, count: 0 };

  /**
   * @param diagnostics Diagnostics reporter.
   * @param config Active configuration. The capture reads `capture.ignoreUrls`.
   */
  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly config: ResolvedConfig,
  ) {}

  /**
   * Replaces the WebSocket constructor with a subclass that tracks every socket.
   * @param ctx The plugin's tools.
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
      contexts: new WeakMap(),
      config: this.config,
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
           * Keeps instanceof true for a socket the app opened before the install.
           * @param value Value to test.
           * @returns True for every native socket.
           */
          static override [Symbol.hasInstance](value: unknown): boolean {
            return value instanceof Original;
          }

          /**
           * @param url The server's URL.
           * @param protocols The app's sub-protocols.
           */
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            track(this);
          }

          /**
           * Sends the data, then counts one message. A send that throws counts nothing.
           * @param data The app's data. We never read it.
           */
          override send(data: SendData): void {
            super.send(data);
            count(state, this, "transmit");
          }
        },
    );
  }

  /** Restores the WebSocket constructor and stops every tracked socket from recording. */
  uninstall(): void {
    if (this.state) {
      this.state.active = false;
    }

    // Another script may have wrapped the constructor after us. Keep its wrapper.
    if (this.restore && !this.restore()) {
      this.diagnostics.report(
        "capture.install_failed",
        "Another script wrapped WebSocket after the library. The library keeps that wrapper.",
      );
    }

    this.restore = undefined;
    this.state = undefined;
  }

  /**
   * Adds the listeners that record one socket's lifecycle and received messages.
   * @param socket The app's new socket.
   * @param state State of the install that created the socket.
   */
  private track(socket: WebSocket, state: InstallState): void {
    if (!state.active) {
      return;
    }

    // This read runs inside the app's constructor call, so a throw must not fail it.
    this.diagnostics.guard(
      "capture.record_failed",
      "The library could not track a WebSocket. The socket works without capture.",
      () => {
        // ignoreUrls matches the full URL. A custom transport may send over its own socket.
        if (matchesAny(socket.url, this.config.capture.ignoreUrls)) {
          return;
        }

        const { target, server } = socketTarget(socket.url, this.config, this.diagnostics);
        const attributes = { "url.full": target, "server.address": server };
        const { logger } = state.ctx;
        state.servers.set(socket, server);
        state.contexts.set(socket, this.config.securityContext.id);

        const lifecycle = (write: () => void): void => {
          if (
            (!this.config.securityContext.isolation ||
              state.contexts.get(socket) === this.config.securityContext.id) &&
            this.allow(state)
          ) {
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
   * Checks whether a lifecycle record can go out.
   * @param state State of the install that created the socket.
   * @returns False after uninstall, or when the window has no allowance left.
   */
  private allow(state: InstallState): boolean {
    return (
      state.active &&
      allowInWindow(
        this.window,
        this.config.capturePolicy.webSocketPerWindow,
        this.diagnostics,
        "WebSocket events",
        this.config.capturePolicy.windowMs,
      )
    );
  }
}
