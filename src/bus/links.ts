// src/bus/links.ts
//
// Communication link implementations for direct, frame, broadcast, OpenFin, and worker channels.

import { BUS_PROTOCOL, BUS_TYPE_DETAIL_MAX_CHARS, RUNTIME_GLOBAL_KEY } from "../constants";
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
   * The parent's bus protocol tag. A direct call has no envelope to carry it, so the child
   * compares it before it opens the link. A parent on 0.12 or older has no tag.
   */
  readonly protocol?: string;
  /**
   * Accepts a message directly from a child frame and replies synchronously.
   * @param message Child bus message.
   * @param reply Callback for synchronous response.
   */
  busAccept(message: BusMessage, reply: Receive, source?: Window): void;
  /**
   * Checks if the parent permits a direct link from the child window.
   * @param source Child window.
   * @param origin Origin of the child window.
   * @returns True if the parent permits this source.
   */
  busCanAccept?: (source: Window, origin: string) => boolean;
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

/** What an opaque origin reads as, for example in a frame sandboxed without allow-same-origin. */
const OPAQUE_ORIGIN = "null";

/**
 * Bus protocol of a parent that has busCanAccept but no protocol field, which is every release
 * from 0.9.5 to 0.12. Release 0.9.5 added busCanAccept and this tag together.
 */
const UNTAGGED_HOST_PROTOCOL = "ui-observability/2";

/** Location with the ancestor list that Chromium and WebKit give. */
interface LocationWithAncestors {
  origin: string;
  ancestorOrigins?: { length: number; item: (index: number) => string | null };
}

/**
 * Builds the diagnostic text for something we ignored from an untrusted origin.
 * @param origin Origin of the sender.
 * @param what What the bus ignored, for example "a message".
 * @returns The text. For a sandboxed sender it includes the fix for its frame.
 */
function untrustedText(origin: string, what: string): string {
  if (origin === OPAQUE_ORIGIN) {
    return `The bus ignored ${what} from a sandboxed frame. The frame has an opaque origin. Set bus.mode: "sender" in the frame. Add allow-same-origin to the sandbox attribute only for content that you trust.`;
  }

  return `The bus ignored ${what} from ${origin}. If you own this origin, add it to bus.trustedOrigins.`;
}

/**
 * Reads the parent frame's origin. A cross-origin parent doesn't expose it.
 * @param diagnostics Counts a blocked read of the parent's origin global.
 * @returns The origin, or null when the browser doesn't reveal it.
 */
function parentOrigin(diagnostics: Diagnostics): string | null {
  const ancestors = (location as LocationWithAncestors).ancestorOrigins;
  if (ancestors && ancestors.length > 0) {
    return ancestors.item(0);
  }

  return referrerOrigin() ?? sameOriginParent(diagnostics);
}

/**
 * Reads the parent's origin from the referrer, which for a frame is the page that loaded it.
 * Firefox has no ancestorOrigins, so this is its first source.
 * @returns The origin, or null for an empty referrer, as with Referrer-Policy: no-referrer, or
 * for a referrer that isn't a URL.
 */
function referrerOrigin(): string | null {
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
 * Reads the parent's origin straight from its origin global. Firefox gives a srcdoc frame no
 * ancestorOrigins and an empty referrer, so without this it can't find even a same-origin parent.
 * The origin global, unlike location.origin, is also real in a srcdoc parent.
 * @param diagnostics Counts a blocked read.
 * @returns The origin, or null for a cross-origin parent, an opaque one or a value that isn't a
 * string.
 */
function sameOriginParent(diagnostics: Diagnostics): string | null {
  let origin: unknown;
  try {
    origin = (window.parent as { origin?: unknown }).origin;
  } catch {
    // A cross-origin or sandboxed parent throws here. Count it, but don't report it, because the
    // caller already reports the unknown origin.
    diagnostics.count("platform.api_blocked");
    return null;
  }

  // A cross-origin parent with a child frame named "origin" gives that frame's window here
  // instead of a throw, and a parent script can overwrite the global. Only a same-origin parent
  // gives a string, and no message may target "null".
  if (typeof origin !== "string" || origin === OPAQUE_ORIGIN) {
    return null;
  }

  return origin;
}

/**
 * Returns the origin this frame runs on. A srcdoc or about:blank frame runs on the origin of
 * the document that made it, but its location.origin reads "null", because that comes from
 * the URL.
 * @returns location.origin, or the origin global when location.origin is "null". A frame
 * sandboxed from a URL keeps its URL origin here, and the parent refuses its "null" messages.
 */
export function frameOrigin(): string {
  if (location.origin !== OPAQUE_ORIGIN) {
    return location.origin;
  }

  // A same-origin script can overwrite the origin global. docs/threat-model.md leaves such a
  // script out of scope, and it gains nothing here, because it can already call the parent.
  const real = (globalThis as { origin?: unknown }).origin;
  if (typeof real !== "string") {
    return OPAQUE_ORIGIN;
  }

  return real;
}

/**
 * Establishes direct synchronous communication with a same-origin parent runtime.
 * @param receive Callback for parent replies.
 * @param diagnostics Diagnostics reporter.
 * @returns Direct link, or null if the parent is inaccessible, lacks a runtime, uses another
 * bus protocol or refuses this frame. When it is null, the bus tries the message link to the
 * parent.
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

  // Read protocol and busCanAccept once, before any call into the parent. A getter could answer
  // differently on a second read, and the check would then judge one value and act on another.
  const hostProtocol = host.protocol;
  const canAccept = host.busCanAccept;
  const hasSourceCheck = typeof canAccept === "function";

  // Without this, a frame under a 0.9.5 to 0.12 parent falls back to the message link. Where
  // that link can't find the parent's origin, the frame sends its own records and the parent's
  // redact never sees them.
  const untagged = hostProtocol === undefined && hasSourceCheck;
  const protocol = untagged ? UNTAGGED_HOST_PROTOCOL : hostProtocol;

  // A direct call skips the envelope, so this is the only version check on this path. Without
  // it, a parent on another library version gets messages in a shape it doesn't expect.
  if (protocol !== BUS_PROTOCOL) {
    // The parent controls this text, so cap it like an untrusted message type.
    const found =
      typeof protocol === "string" ? protocol.slice(0, BUS_TYPE_DETAIL_MAX_CHARS) : "none";
    diagnostics.report(
      "bus.protocol_mismatch",
      "The same-origin parent runtime uses another bus protocol. This context tries a message link instead of a direct call.",
      { found, own: BUS_PROTOCOL },
    );
    return null;
  }

  // A srcdoc frame's location.origin reads "null", which a parent refuses, and the frame then
  // sends its own records past the parent's redact. The runtime read above proved same-origin.
  const origin = frameOrigin();

  // Called as the parent's method, so a runtime that uses "this" inside it still works.
  if (hasSourceCheck && !canAccept.call(host, window, origin)) {
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
          target.busAccept(message, receive, window);
        },
      );
    },
    close() {
      open = false;
    },
  };
}

/**
 * Creates a postMessage link to a parent window on a trusted origin. Records hold user data,
 * so a page on another origin that frames this app must not get them.
 * @param receive Callback for incoming parent messages.
 * @param trustedOrigins Parent origins that may receive the records, in addition to this origin.
 * @param diagnostics Diagnostics reporter.
 * @returns Link to the parent window, or null at the top level or with an untrusted parent.
 * When it is null, this context sends its own records.
 */
export function createParentLink(
  receive: Receive,
  trustedOrigins: string[],
  diagnostics: Diagnostics,
): Link | null {
  if (typeof window === "undefined" || window.parent === window) {
    return null;
  }

  // No parent can put "null" in its trust list. A srcdoc frame isn't that case, because it
  // runs on a real origin, so it goes on to the parent origin check below.
  const self = frameOrigin();
  if (self === OPAQUE_ORIGIN) {
    diagnostics.report(
      "bus.untrusted_origin",
      'This frame reports the origin "null". No parent can trust that origin. This context sends its own records. A frame that is sandboxed without allow-same-origin has this origin. Set bus.mode: "sender" in the frame. Add allow-same-origin to the sandbox attribute only for content that you trust.',
      { origin: self, type: "parent" },
    );
    return null;
  }

  const trusted = new Set([self, ...trustedOrigins]);
  const target = parentOrigin(diagnostics);
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

  // Report every untrusted origin only once, because a hostile parent can send many messages.
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
        // The parent controls message.t, so keep it out of the message text and truncate it
        // in the detail.
        diagnostics.report("bus.untrusted_origin", untrustedText(event.origin, "a message"), {
          origin: event.origin,
          type: message.t.slice(0, BUS_TYPE_DETAIL_MAX_CHARS),
        });
      }
      return;
    }

    receive(message, { link: "parent", origin: event.origin, peer: event.source });
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
  authorize?: (source: MessageEventSource | null, origin: string) => boolean,
  mayPost?: (message: BusMessage, source: MessageEventSource) => boolean,
): Link | null {
  if (typeof window === "undefined") {
    return null;
  }

  // A sandboxed page has the opaque origin "null", and so does every sandboxed child.
  const trusted = new Set([location.origin, ...trustedOrigins]);
  trusted.delete(OPAQUE_ORIGIN);

  // Remembers every source's origin, so a child that navigates doesn't get the ids of its
  // previous origin.
  const sources = new Map<MessageEventSource, string>();

  /**
   * Posts one message to one child, and forgets a child that is closed or no longer permitted.
   * @param source Child window.
   * @param origin Last known origin of the child.
   * @param message Message to send.
   */
  const send = (source: MessageEventSource, origin: string, message: BusMessage): void => {
    if (authorize && !authorize(source, origin)) {
      sources.delete(source);
      return;
    }
    if (mayPost && !mayPost(message, source)) {
      return;
    }
    const target = source as Window;
    // Evicts closed child windows to prevent memory leaks.
    if (target.closed) {
      sources.delete(source);
      return;
    }
    diagnostics.guard("bus.send_failed", "The postMessage call to a child frame failed.", () => {
      // Targets the last known origin of the child. The browser drops the
      // message if the child navigated to a different origin.
      target.postMessage(envelope(message), origin);
    });
  };

  const onMessage = (event: MessageEvent): void => {
    const message = unwrap(event.data);
    if (!message) {
      return;
    }
    // A nested frame also receives its parent's messages here. Those belong to the parent link.
    if (window.parent !== window && event.source === window.parent) {
      return;
    }
    if (!authorize && !trusted.has(event.origin)) {
      diagnostics.report("bus.untrusted_origin", untrustedText(event.origin, "a message"), {
        origin: event.origin,
        type: message.t.slice(0, BUS_TYPE_DETAIL_MAX_CHARS),
      });
      return;
    }

    if (authorize && !authorize(event.source, event.origin)) {
      return;
    }
    const { source, origin } = event;
    if (source) {
      sources.set(source, origin);
    }
    // Answer only the child that asked. A broadcast would let one child use up every
    // sibling's budget.
    receive(message, {
      link: "children",
      origin,
      peer: source ?? undefined,
      reply: source
        ? (answer) => {
            send(source, origin, answer);
          }
        : undefined,
    });
  };
  addEventListener("message", onMessage);

  return {
    kind: "children",
    post(message) {
      for (const [source, origin] of sources) {
        send(source, origin, message);
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
    // Without a uuid, neither send() nor subscribe() can be scoped to this app, and the link
    // would share this app's bus with every other app.
    diagnostics.report(
      "openfin.unavailable",
      "OpenFin gives no application uuid. The InterApplicationBus link stays closed.",
    );
    return null;
  }

  // The uuid scopes the topic, the subscriber identity and the send target. The identity drops
  // messages from other apps, and send() reaches this app only. publish() would reach every app.
  const scoped = `${topic}.${appUuid}`;
  const app = { uuid: appUuid };
  const listener = (raw: unknown, uuid?: string, name?: string): void => {
    const message = unwrap(raw);
    if (message) {
      receive(message, {
        link: "openfin",
        origin: "openfin",
        peer: uuid && name ? `${uuid}:${name}` : undefined,
      });
    }
  };

  void diagnostics.guardAsync(
    "bus.send_failed",
    "The InterApplicationBus.subscribe call failed.",
    () => iab.subscribe(app, scoped, listener),
  );

  return {
    kind: "openfin",
    post(message) {
      void diagnostics.guardAsync(
        "bus.send_failed",
        "The InterApplicationBus.send call failed.",
        () => iab.send(app, scoped, envelope(message)),
      );
    },
    close() {
      // The listener holds this bus, so a runtime that starts after shutdown() would add one more.
      // An older runtime has no unsubscribe, and it removes the listener when the context closes.
      void diagnostics.guardAsync(
        "bus.send_failed",
        "The InterApplicationBus.unsubscribe call failed.",
        async () => {
          await iab.unsubscribe?.(app, scoped, listener);
        },
      );
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
    removeEventListener?: (type: string, listener: (event: MessageEvent) => void) => void;
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
      // The listener holds this bus. A worker that calls shutdown() and configure() again would
      // otherwise keep every old bus, and each one would still receive messages.
      scope.removeEventListener?.("message", onMessage);
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
      receive(message, { link: "worker", origin: "same-origin", peer: worker });
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
