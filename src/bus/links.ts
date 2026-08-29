// src/bus/links.ts
//
// Communication link implementations for direct, frame, broadcast, OpenFin, and worker channels.

import { RUNTIME_GLOBAL_KEY } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import {
  type BusMessage,
  envelope,
  type LinkKind,
  type MessageSource,
  unwrap,
} from "../models/bus";

/** Bidirectional communication channel for bus message transport. */
export interface Link {
  /** Channel transport kind. */
  readonly kind: LinkKind;

  /**
   * Sends a message over the channel without throwing.
   * @param message Bus message to transmit.
   */
  post(message: BusMessage): void;

  /** Releases listeners, subscriptions, or channels held open by the link. */
  close(): void;
}

/**
 * Callback invoked when a bus message arrives on a link.
 * @param message Received bus message.
 * @param source Origin and link metadata.
 */
export type Receive = (message: BusMessage, source: MessageSource) => void;

/** Interface exposed on global symbol by same-origin parent runtimes. */
export interface DirectHost {
  /**
   * Accepts a message directly from a child frame and replies synchronously.
   * @param message Child bus message.
   * @param reply Callback for synchronous response.
   */
  busAccept(message: BusMessage, reply: Receive): void;
}

/** Message port or dedicated/shared worker interface. */
export interface WorkerLike {
  /**
   * Sends a message to the worker or port.
   * @param message Payload to send.
   */
  postMessage(message: unknown): void;

  /**
   * Subscribes to incoming message events.
   * @param type Event name ("message").
   * @param listener Event handler callback.
   */
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;

  /**
   * Unsubscribes from message events.
   * @param type Event name ("message").
   * @param listener Event handler to remove.
   */
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;

  /** Starts message delivery on MessagePort instances. */
  start?: () => void;
}

/** Global symbol used to look up same-origin parent runtime instances. */
const RUNTIME_KEY = Symbol.for(RUNTIME_GLOBAL_KEY);

/**
 * Establishes direct synchronous communication with a same-origin parent runtime.
 * @param receive Callback for parent replies.
 * @param diagnostics Diagnostics reporter.
 * @returns Direct link, or null if parent is inaccessible or lacks a runtime.
 */
export function createDirectLink(receive: Receive, diagnostics: Diagnostics): Link | null {
  if (typeof window === "undefined" || window.parent === window) {
    return null;
  }

  let host: DirectHost | undefined;
  try {
    const parentGlobal = window.parent as unknown as Record<symbol, DirectHost | undefined>;
    host = parentGlobal[RUNTIME_KEY];
  } catch {
    // Cross-origin access throws on read.
    return null;
  }
  if (typeof host?.busAccept !== "function") {
    return null;
  }

  const target = host;
  let open = true;

  return {
    kind: "direct",
    post(message) {
      if (!open) {
        return;
      }

      // Catches errors thrown by parent runtime to protect child logging calls.
      diagnostics.guard("bus.send_failed", "direct call into the parent runtime", () => {
        target.busAccept(message, receive);
      });
    },
    close() {
      open = false;
    },
  };
}

/**
 * Creates a postMessage link to the parent window.
 * @param receive Callback for incoming parent messages.
 * @param diagnostics Diagnostics reporter.
 * @returns Link to parent window, or null if running in top-level window.
 */
export function createParentLink(receive: Receive, diagnostics: Diagnostics): Link | null {
  if (typeof window === "undefined" || window.parent === window) {
    return null;
  }

  const onMessage = (event: MessageEvent): void => {
    const message = unwrap(event.data);
    // The parent is trusted by construction: this context chose to talk to it.
    if (message && event.source === window.parent) {
      receive(message, { link: "parent", origin: event.origin });
    }
  };
  addEventListener("message", onMessage);

  return {
    kind: "parent",
    post(message) {
      diagnostics.guard("bus.send_failed", "postMessage to parent", () => {
        // "*" is fine outbound: the payload is this context's own records,
        // and the parent already receives them another way. Inbound trust
        // works differently; see createChildrenLink.
        window.parent.postMessage(envelope(message), "*");
      });
    },
    close() {
      removeEventListener("message", onMessage);
    },
  };
}

/**
 * Creates a link listening to child frames with origin allowlist filtering.
 * @param receive Callback for messages from authorized child frames.
 * @param trustedOrigins Additional origins allowed to communicate.
 * @param diagnostics Diagnostics reporter.
 * @returns Children link, or null in non-window environments.
 */
export function createChildrenLink(
  receive: Receive,
  trustedOrigins: string[],
  diagnostics: Diagnostics,
): Link | null {
  if (typeof window === "undefined") {
    return null;
  }

  const trusted = new Set([window.location.origin, ...trustedOrigins]);
  const sources = new Set<MessageEventSource>();

  const onMessage = (event: MessageEvent): void => {
    const message = unwrap(event.data);
    if (!message) {
      return;
    }
    if (!trusted.has(event.origin)) {
      diagnostics.report(
        "bus.untrusted_origin",
        `ignored a bus message from ${event.origin}. Add it to bus.trustedOrigins if it is yours.`,
        { origin: event.origin, type: message.t },
      );
      return;
    }

    if (event.source) {
      sources.add(event.source);
    }
    receive(message, { link: "children", origin: event.origin });
  };
  addEventListener("message", onMessage);

  return {
    kind: "children",
    post(message) {
      for (const source of sources) {
        const target = source as Window;
        // Evicts closed child windows to prevent memory leaks.
        if (target.closed) {
          sources.delete(source);
          continue;
        }
        diagnostics.guard("bus.send_failed", "postMessage to child", () => {
          target.postMessage(envelope(message), "*");
        });
      }
    },
    close() {
      removeEventListener("message", onMessage);
      sources.clear();
    },
  };
}

/**
 * Creates a same-origin BroadcastChannel link for cross-tab control messages.
 * @param channelName BroadcastChannel identifier.
 * @param receive Callback for incoming cross-tab messages.
 * @param diagnostics Diagnostics reporter.
 * @returns Broadcast link, or null if unsupported.
 */
export function createBroadcastLink(
  channelName: string,
  receive: Receive,
  diagnostics: Diagnostics,
): Link | null {
  const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (typeof BC === "undefined") {
    return null;
  }

  const channel = diagnostics.guard(
    "bus.send_failed",
    "opening BroadcastChannel",
    () => new BC(channelName),
  );
  if (!channel) {
    return null;
  }

  channel.onmessage = (event: MessageEvent): void => {
    const message = unwrap(event.data);
    if (message) {
      receive(message, { link: "broadcast", origin: "same-origin" });
    }
  };

  return {
    kind: "broadcast",
    post(message) {
      diagnostics.guard("bus.send_failed", "BroadcastChannel.postMessage", () => {
        channel.postMessage(envelope(message));
      });
    },
    close() {
      diagnostics.guard("bus.send_failed", "closing BroadcastChannel", () => {
        channel.close();
      });
    },
  };
}

/** Structural interface for OpenFin InterApplicationBus operations. */
interface FinIab {
  /**
   * Publishes a message to all topic subscribers.
   * @param topic Topic name.
   * @param message Message payload.
   */
  publish(topic: string, message: unknown): Promise<void>;

  /**
   * Subscribes a listener to a topic for matching application identities.
   * @param identity Target application identity.
   * @param topic Topic name.
   * @param listener Message callback.
   */
  subscribe(
    identity: { uuid: string },
    topic: string,
    listener: (message: unknown) => void,
  ): Promise<void>;
}

/**
 * Creates an OpenFin InterApplicationBus link across desktop views and applications.
 * @param topic InterApplicationBus topic identifier.
 * @param receive Callback for received topic messages.
 * @param diagnostics Diagnostics reporter.
 * @returns OpenFin link, or null if InterApplicationBus is unavailable.
 */
export function createOpenFinLink(
  topic: string,
  receive: Receive,
  diagnostics: Diagnostics,
): Link | null {
  const fin = (globalThis as { fin?: { InterApplicationBus?: FinIab } }).fin;
  const iab = fin?.InterApplicationBus;
  if (!iab) {
    return null;
  }

  void diagnostics.guardAsync("bus.send_failed", "InterApplicationBus.subscribe", () =>
    iab.subscribe({ uuid: "*" }, topic, (raw) => {
      const message = unwrap(raw);
      if (message) {
        receive(message, { link: "openfin", origin: "openfin" });
      }
    }),
  );

  return {
    kind: "openfin",
    post(message) {
      void diagnostics.guardAsync("bus.send_failed", "InterApplicationBus.publish", () =>
        iab.publish(topic, envelope(message)),
      );
    },
    close() {
      // OpenFin automatically cleans up subscriptions on context teardown.
    },
  };
}

/**
 * Creates the worker-side link pointing at the document that created this
 * worker. Emits `kind: "owner"`.
 * @param receive Callback for incoming messages from the owning document.
 * @param diagnostics Diagnostics reporter.
 * @returns Owner link, or null outside a DedicatedWorkerGlobalScope.
 */
export function createOwnerLink(receive: Receive, diagnostics: Diagnostics): Link | null {
  const scope = globalThis as unknown as {
    postMessage?: (message: unknown) => void;
    addEventListener?: (type: string, listener: (event: MessageEvent) => void) => void;
    WorkerGlobalScope?: unknown;
  };
  const send = scope.postMessage;
  if (typeof scope.WorkerGlobalScope === "undefined" || !send) {
    return null;
  }

  const onMessage = (event: MessageEvent): void => {
    const message = unwrap(event.data);
    if (message) {
      receive(message, { link: "owner", origin: "same-origin" });
    }
  };
  scope.addEventListener?.("message", onMessage);

  return {
    kind: "owner",
    post(message) {
      diagnostics.guard("bus.send_failed", "worker postMessage", () => {
        send(envelope(message));
      });
    },
    close() {
      // Worker scope listeners terminate with the worker lifecycle.
    },
  };
}

/**
 * Creates the document-side link pointing at one attached worker or port.
 * Emits `kind: "worker"`.
 * @param worker Target worker instance or MessagePort.
 * @param receive Callback for messages from the worker.
 * @param diagnostics Diagnostics reporter.
 * @returns Document-to-worker link.
 */
export function createWorkerLink(
  worker: WorkerLike,
  receive: Receive,
  diagnostics: Diagnostics,
): Link {
  const onMessage = (event: MessageEvent): void => {
    const message = unwrap(event.data);
    if (message) {
      receive(message, { link: "worker", origin: "same-origin" });
    }
  };
  worker.addEventListener("message", onMessage);

  // Activates MessagePort message delivery if supported.
  worker.start?.();

  return {
    kind: "worker",
    post(message) {
      diagnostics.guard("bus.send_failed", "postMessage to a worker", () => {
        worker.postMessage(envelope(message));
      });
    },
    close() {
      worker.removeEventListener("message", onMessage);
    },
  };
}
