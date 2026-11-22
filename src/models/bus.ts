// src/models/bus.ts
//
// Protocol types, message definitions, and envelope encoding for bus messages between realms.

import { BUS_PROTOCOL, type BUS_TYPE } from "../constants";
import type { LogRecord } from "./log-record";

/** What one child window or worker may do. The handshake needs no permission of its own. */
export type BusPermission = "records" | "journey:read" | "journey:write" | "sampling:read";
export interface SourceOptions {
  /** This source's permissions. Without the list, the source can only send records. */
  permissions?: BusPermission[];
}

/** Origin and permissions for one child frame registration. */
export interface FrameOptions extends SourceOptions {
  /** Expected window origin, including its scheme and port. Must match exactly. */
  origin: string;
}

/** Delivery role: whether this context sends its own records or forwards them upstream. */
export type BusRole = "sender" | "forwarder";

/**
 * Kind of transport channel, which the bus uses to route incoming and outgoing messages.
 * Without it, `receive` can't tell the channels apart and a same-origin iframe looks like a
 * duplicated tab.
 */
export type LinkKind =
  /** Synchronous call into a same-origin parent runtime. */
  | "direct"
  /** postMessage to a parent window. */
  | "parent"
  /** postMessage to child frames. */
  | "children"
  /** BroadcastChannel across same-origin tabs and windows. */
  | "broadcast"
  /** OpenFin InterApplicationBus across desktop views and applications. */
  | "openfin"
  /** Dedicated worker communication to its owning document. */
  | "owner"
  /** Document-side communication to a dedicated worker. */
  | "worker";

/** Origin and transport metadata for an incoming bus message. */
export interface MessageSource {
  /** Source identity as the transport reports it. The source can't supply it in message.from. */
  peer?: object | string;
  /** Inbound transport channel kind. */
  link: LinkKind;
  /** `event.origin` for `parent` and `children`. Other links use `"same-origin"` or `"openfin"`. */
  origin: string;
  /** Replies to this source only. A link that can't address a single source omits it. */
  reply?: (message: BusMessage) => void;
}

/** Discriminated union of control and telemetry payload messages. */
export type BusMessage =
  /** Handshake discovery announcement from a starting forwarder. */
  | { t: typeof BUS_TYPE.hello; from: string; tabId: string }
  /**
   * Handshake response from an upstream owner, addressed through the `to` field. A welcome on
   * InterApplicationBus reaches every subscriber, so without an address every waiting view
   * would accept the welcome as its own.
   */
  | {
      t: typeof BUS_TYPE.welcome;
      from: string;
      to: string;
      tabId: string;
      routingContextId?: string;
    }
  /** Telemetry log records forwarded to an upstream sender. */
  | { t: typeof BUS_TYPE.records; from: string; records: LogRecord[]; routingContextId?: string }
  /** Delivery context update. Only the owner from the handshake may send it to its children. */
  | { t: typeof BUS_TYPE.securityContext; from: string; id: string }
  /**
   * Journey update, or the answer to a journey question. An answer carries the asking
   * context's address in `to`. The payload comes from another realm, so the receiver parses it.
   */
  | { t: typeof BUS_TYPE.journey; from: string; to?: string; journey: unknown }
  /** Query requesting active journey state from connected peers. */
  | { t: typeof BUS_TYPE.journeyRequest; from: string }
  /**
   * Tab identifier claim broadcast to detect collisions across windows. `since` is the
   * document's `performance.timeOrigin`, so the older document keeps the id. An older library
   * sends none.
   */
  | { t: typeof BUS_TYPE.tab; from: string; tabId: string; since?: number }
  /** A forwarder's request for the current remote sampling rules. */
  | { t: typeof BUS_TYPE.samplingRequest; from: string }
  /**
   * Remote sampling rules in the header's shape, with the remaining TTL. `to` holds the address
   * of the forwarder that asked. The receiver validates `rules` again. Null rules end the
   * forwarder's copy.
   */
  | { t: typeof BUS_TYPE.sampling; from: string; to: string; rules: unknown }
  /**
   * A forwarder's request to flush. `id` names the request, and `timeoutMs` is the time the
   * forwarder has left. The receiver clamps it to its own range.
   */
  | { t: typeof BUS_TYPE.flushRequest; from: string; id: string; timeoutMs: number }
  /**
   * The answer to a flush request, with the request's id. The result comes from another realm,
   * so the receiver checks each field before it uses one.
   */
  | { t: typeof BUS_TYPE.flushResult; from: string; id: string; result: unknown };

/** Transport envelope wrapping bus messages with a protocol version tag. */
export interface BusEnvelope {
  /** Protocol version identifier. */
  p: typeof BUS_PROTOCOL;
  /** Encapsulated bus payload. */
  m: BusMessage;
}

/**
 * Wraps a bus message in a versioned protocol envelope.
 * @param message Message to encapsulate.
 * @returns Envelope ready for transport.
 */
export function envelope(message: BusMessage): BusEnvelope {
  return { p: BUS_PROTOCOL, m: message };
}

/**
 * Validates the protocol tag and unpacks a raw payload into a bus message. A document gets
 * `message` events from all embedded content on the page, including analytics tags, video
 * players and extensions. Without the tag check, the bus would parse a video player's message
 * as a log record.
 * @param data Raw payload received over a transport link.
 * @returns The validated message, or null if the payload is invalid or unrecognized.
 */
export function unwrap(data: unknown): BusMessage | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }

  // Validates payload structure at runtime without assuming envelope fields exist.
  const wrapper = data as Record<string, unknown>;
  if (wrapper.p !== BUS_PROTOCOL || typeof wrapper.m !== "object" || wrapper.m === null) {
    return null;
  }

  const message = wrapper.m as Record<string, unknown>;
  if (typeof message.t !== "string") {
    return null;
  }

  return message as unknown as BusMessage;
}
