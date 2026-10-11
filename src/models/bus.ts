// src/models/bus.ts
//
// Protocol types, message definitions, and envelope encoding for bus messages between realms.

import { BUS_PROTOCOL } from "../constants";
import type { Journey } from "../core/journey";
import type { LogRecord } from "./log-record";

/** Delivery role indicating whether this context sends records directly or forwards upstream. */
export type BusRole = "sender" | "forwarder";

/**
 * Kind of transport channel. The bus uses it to route incoming and outgoing messages.
 * Without it, `receive` cannot tell the channels apart. Then a same-origin iframe
 * looks like a duplicated tab.
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
  /** Inbound transport channel kind. */
  link: LinkKind;
  /** `event.origin` for `parent` and `children`. Other links use `"same-origin"` or `"openfin"`. */
  origin: string;
}

/** Discriminated union of control and telemetry payload messages. */
export type BusMessage =
  /** Handshake discovery announcement from a starting forwarder. */
  | { t: "hello"; from: string; tabId: string }
  /**
   * Handshake response from an upstream owner. The `to` field holds the address.
   * A welcome on InterApplicationBus goes to every subscriber. Without an address,
   * each waiting view accepts the welcome as its own.
   */
  | { t: "welcome"; from: string; to: string; tabId: string }
  /** Telemetry log records forwarded to an upstream sender. */
  | { t: "records"; from: string; records: LogRecord[] }
  /** Broadcast update announcing a new or ended journey state. */
  | { t: "journey"; from: string; journey: Journey | null }
  /** Query requesting active journey state from connected peers. */
  | { t: "journey?"; from: string }
  /** Tab identifier claim broadcast to detect collisions across windows. */
  | { t: "tab"; from: string; tabId: string };

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
 * Validates the protocol tag and unpacks a raw payload into a bus message. A
 * document gets `message` events from all embedded content on the page. This
 * includes analytics tags, video players and extensions. Without the tag check,
 * the bus parses a message from a video player as a log record.
 * @param data Raw payload received over a transport link.
 * @returns Validated message, or null if payload is invalid or unrecognized.
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
