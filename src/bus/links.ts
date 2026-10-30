// src/bus/links.ts
//
// Communication link implementations for direct, frame, broadcast, OpenFin, and worker channels.

import { BUS_TYPE_DETAIL_MAX_CHARS, RUNTIME_GLOBAL_KEY } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import {
  type BusMessage,
  envelope,
  type LinkKind,
  type MessageSource,
  unwrap,
} from "../models/bus";
import { getFin } from "../utils/openfin";

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

/** Origin of a sandboxed frame without allow-same-origin. */
const OPAQUE_ORIGIN = "null";

/** Location with the ancestor list that Chromium and WebKit give. */
interface LocationWithAncestors {
  origin: string;
  ancestorOrigins?: { length: number; item: (index: number) => string | null };
}

/**
 * Builds the message for an ignored message from an untrusted origin.
 * @param origin Origin of the sender.
 * @param what What the bus ignored, for example "a message".
 * @returns The message. A sandboxed sender gets the fix for its frame.
 */
function untrustedText(origin: string, what: string): string {
  if (origin === OPAQUE_ORIGIN) {
    return `The bus ignored ${what} from a sandboxed frame. The frame has an opaque origin. Set bus.mode: "sender" in the frame. Add allow-same-origin to the sandbox attribute only for content that you trust.`;
  }

  return `The bus ignored ${what} from ${origin}. If you own this origin, add it to bus.trustedOrigins.`;
}

/**
 * Reads the origin of the parent frame. A cross-origin parent does not give its location.
 * @returns The origin, or null when the browser does not give it.
 */
function parentOrigin(): string | null {
  const ancestors = (location as LocationWithAncestors).ancestorOrigins;
  if (ancestors && ancestors.length > 0) {
    return ancestors.item(0);
  }

  // Firefox has no ancestorOrigins. The referrer of a frame is the page that loaded it.
  // A Referrer-Policy of no-referrer gives "". The caller reports an unknown origin.
  const referrer = document.referrer;
  if (referrer === "") {
    return null;
  }

  try {
    return new URL(referrer).origin;
  } catch {
    return null;
  }
}

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
 * Creates a postMessage link to a parent window on a trusted origin. Records hold user data.
 * A page on another origin that frames this app must not get them.
 * @param receive Callback for incoming parent messages.
 * @param trustedOrigins Origins of a parent that can get the records, in addition to this origin.
 * @param diagnostics Diagnostics reporter.
 * @returns Link to the parent window, or null at the top level or with an untrusted parent.
 * With null, this context sends its own records.
 */
export function createParentLink(
  receive: Receive,
  trustedOrigins: string[],
  diagnostics: Diagnostics,
): Link | null {
  if (typeof window === "undefined" || window.parent === window) {
    return null;
  }

  // A sandboxed frame has an opaque origin. No parent can list it in its own trust list.
  const self = location.origin;
  if (self === OPAQUE_ORIGIN) {
    diagnostics.report(
      "bus.untrusted_origin",
      'This frame is sandboxed without allow-same-origin. It has an opaque origin. No parent can trust it. This context sends its own records. Set bus.mode: "sender" in the frame. Add allow-same-origin to the sandbox attribute only for content that you trust.',
      { origin: self, type: "parent" },
    );
    return null;
  }

  const trusted = new Set([self, ...trustedOrigins]);
  const target = parentOrigin();
  if (target === null || !trusted.has(target)) {
    diagnostics.report(
      "bus.untrusted_origin",
      target === null
        ? "The origin of the parent frame is unknown. This context sends its own records."
        : `The parent frame is on ${target}. This origin is not in bus.trustedOrigins. This context sends its own records.`,
      { origin: target ?? "", type: "parent" },
    );
    return null;
  }

  // Report each untrusted origin one time. A hostile parent can send many messages.
  const reported = new Set<string>();

  const onMessage = (event: MessageEvent): void => {
    const message = unwrap(event.data);
    if (!message || event.source !== window.parent) {
      return;
    }

    // The parent can navigate to another origin after this frame loads.
    if (!trusted.has(event.origin)) {
      if (!reported.has(event.origin)) {
        reported.add(event.origin);
        // The parent sets message.t. Keep it out of the message text. Cut it in the detail.
        diagnostics.report("bus.untrusted_origin", untrustedText(event.origin, "a message"), {
          origin: event.origin,
          type: message.t.slice(0, BUS_TYPE_DETAIL_MAX_CHARS),
        });
      }
      return;
    }

    receive(message, { link: "parent", origin: event.origin });
  };
  addEventListener("message", onMessage);

  return {
    kind: "parent",
    post(message) {
      diagnostics.guard("bus.send_failed", "The postMessage call to the parent failed.", () => {
        // Target the trusted origin, not "*". The browser drops the message if the parent
        // navigated to another origin.
        window.parent.postMessage(envelope(message), target);
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

  // A sandboxed page has the opaque origin "null". Each sandboxed child also has it.
  const trusted = new Set([location.origin, ...trustedOrigins]);
  trusted.delete(OPAQUE_ORIGIN);

  // The map keeps the origin of each source.
  // A child that navigates must not get the ids of its previous origin.
  const sources = new Map<MessageEventSource, string>();

  const onMessage = (event: MessageEvent): void => {
    const message = unwrap(event.data);
    if (!message) {
      return;
    }
    if (!trusted.has(event.origin)) {
      diagnostics.report("bus.untrusted_origin", untrustedText(event.origin, "a message"), {
        origin: event.origin,
        type: message.t.slice(0, BUS_TYPE_DETAIL_MAX_CHARS),
      });
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
  const iab = getFin()?.InterApplicationBus;
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
