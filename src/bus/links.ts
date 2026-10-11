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

/** Interface that a same-origin parent runtime exposes on a global symbol. */
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

      // Stops an error in the parent runtime from breaking a logging call in the child.
      diagnostics.guard(
        "bus.send_failed",
        "The direct call into the parent runtime failed.",
        () => {
          target.busAccept(message, receive);
        },
      );
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
    // This context trusts the parent because it selected the parent as its upstream.
    if (message && event.source === window.parent) {
      receive(message, { link: "parent", origin: event.origin });
    }
  };
  addEventListener("message", onMessage);

  return {
    kind: "parent",
    post(message) {
      diagnostics.guard("bus.send_failed", "The postMessage call to the parent failed.", () => {
        // An outbound "*" target is safe. The payload holds only this context's records.
        // The parent already gets these records by another path.
        // For inbound trust, see createChildrenLink.
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
  // The map keeps the origin of each source.
  // A child that navigates must not get the ids of its previous origin.
  const sources = new Map<MessageEventSource, string>();

  const onMessage = (event: MessageEvent): void => {
    const message = unwrap(event.data);
    if (!message) {
      return;
    }
    if (!trusted.has(event.origin)) {
      diagnostics.report(
        "bus.untrusted_origin",
        `The bus ignored a message from ${event.origin}. If you own this origin, add it to bus.trustedOrigins.`,
        { origin: event.origin, type: message.t },
      );
      return;
    }

    if (event.source) {
      sources.set(event.source, event.origin);
    }
    receive(message, { link: "children", origin: event.origin });
  };
  addEventListener("message", onMessage);

  return {
    kind: "children",
    post(message) {
      for (const [source, origin] of sources) {
        const target = source as Window;
        // Evicts closed child windows to prevent memory leaks.
        if (target.closed) {
          sources.delete(source);
          continue;
        }
        diagnostics.guard(
          "bus.send_failed",
          "The postMessage call to a child frame failed.",
          () => {
            // Targets the last known origin of the child. The browser drops the
            // message if the child navigated to a different origin.
            target.postMessage(envelope(message), origin);
          },
        );
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
    "The library could not open the BroadcastChannel.",
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
      diagnostics.guard("bus.send_failed", "The BroadcastChannel.postMessage call failed.", () => {
        channel.postMessage(envelope(message));
      });
    },
    close() {
      diagnostics.guard(
        "bus.send_failed",
        "The library could not close the BroadcastChannel.",
        () => {
          channel.close();
        },
      );
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
 * Creates an OpenFin InterApplicationBus link scoped to one application.
 * @param topic InterApplicationBus topic prefix.
 * @param appUuid OpenFin application uuid owning this context.
 * @param receive Callback for received topic messages.
 * @param diagnostics Diagnostics reporter.
 * @returns OpenFin link, or null if InterApplicationBus or the identity is unavailable.
 */
export function createOpenFinLink(
  topic: string,
  appUuid: string | undefined,
  receive: Receive,
  diagnostics: Diagnostics,
): Link | null {
  const fin = (globalThis as { fin?: { InterApplicationBus?: FinIab } }).fin;
  const iab = fin?.InterApplicationBus;
  if (!iab) {
    return null;
  }
  if (!appUuid) {
    // publish() sends to every subscriber on the runtime. Without a uuid scope,
    // this link shares the bus of this app with all other apps.
    diagnostics.report(
      "openfin.unavailable",
      "OpenFin gives no application uuid. The InterApplicationBus link stays closed.",
    );
    return null;
  }

  // The topic and the subscriber identity both contain the uuid. The topic keeps
  // messages of this app from other apps. The identity rejects messages from other apps.
  const scoped = `${topic}.${appUuid}`;

  void diagnostics.guardAsync(
    "bus.send_failed",
    "The InterApplicationBus.subscribe call failed.",
    () =>
      iab.subscribe({ uuid: appUuid }, scoped, (raw) => {
        const message = unwrap(raw);
        if (message) {
          receive(message, { link: "openfin", origin: "openfin" });
        }
      }),
  );

  return {
    kind: "openfin",
    post(message) {
      void diagnostics.guardAsync(
        "bus.send_failed",
        "The InterApplicationBus.publish call failed.",
        () => iab.publish(scoped, envelope(message)),
      );
    },
    close() {
      // OpenFin removes the subscriptions when the context closes.
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
      diagnostics.guard("bus.send_failed", "The postMessage call of the worker failed.", () => {
        send(envelope(message));
      });
    },
    close() {
      // Worker scope listeners stop when the worker stops.
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

  // Starts delivery on a MessagePort. A Worker has no start method.
  worker.start?.();

  return {
    kind: "worker",
    post(message) {
      diagnostics.guard("bus.send_failed", "The postMessage call to a worker failed.", () => {
        worker.postMessage(envelope(message));
      });
    },
    close() {
      worker.removeEventListener("message", onMessage);
    },
  };
}
