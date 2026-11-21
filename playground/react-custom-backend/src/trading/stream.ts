// src/trading/stream.ts
//
// The WebSocket of the app. One socket carries the price ticks and the order updates. The first
// message is the token, because a token in the URL would end up in server and proxy logs.

import { useEffect, useRef } from "react";
import { getLogger } from "@utk09/ui-observability";
import type { Order, Pair, StreamMessage } from "../api/types";

/** The price handler logs each tick at DEBUG. It is the noisy namespace for sampling and levels. */
const priceLog = getLogger("market.prices");

export interface StreamHandlers {
  onPrice(pair: Pair, bid: number, ask: number): void;
  onOrder(order: Order): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Checks the fields that the app reads. Any other message is ignored. */
function isStreamMessage(value: unknown): value is StreamMessage {
  if (!isObject(value)) {
    return false;
  }
  if (value.type === "price") {
    return (
      typeof value.pair === "string" &&
      typeof value.bid === "number" &&
      typeof value.ask === "number"
    );
  }

  return value.type === "order" && isObject(value.order);
}

function parse(data: unknown): StreamMessage | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const value: unknown = JSON.parse(data);

    return isStreamMessage(value) ? value : null;
  } catch {
    // A message that isn't JSON is not one of ours.
    return null;
  }
}

/**
 * Opens the stream while the component is mounted.
 * @param token The token to send as the first message.
 * @param handlers Called for each price tick and each order update. The latest ones are used,
 * so a new function does not reconnect the socket.
 */
export function useStream(token: string, handlers: StreamHandlers): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  // StrictMode runs this effect as mount, unmount, mount in development. The cleanup closes the
  // socket and nothing else leaves the component, so the second mount is safe.
  useEffect(() => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/api/stream`);
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "auth", token }));
    };
    socket.onmessage = (event: MessageEvent) => {
      const message = parse(event.data);
      if (message?.type === "price") {
        priceLog.debug("price tick", { pair: message.pair, bid: message.bid, ask: message.ask });
        latest.current.onPrice(message.pair, message.bid, message.ask);
      } else if (message?.type === "order") {
        latest.current.onOrder(message.order);
      }
    };

    return () => {
      socket.onmessage = null;
      if (socket.readyState === WebSocket.CONNECTING) {
        // Closing a socket that is still connecting makes the browser print a warning.
        socket.onopen = () => {
          socket.close();
        };
      } else {
        socket.close();
      }
    };
  }, [token]);
}
