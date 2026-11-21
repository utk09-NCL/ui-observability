// src/orders/place-order.ts
//
// Places one order and records it. It has no React in it, so a spec can call it with a fake
// client. It never throws, because a click handler that throws would leave the ticket stuck.

import {
  counter,
  currentJourney,
  endJourney,
  getLogger,
  histogram,
  startJourney,
  startMeasure,
} from "@utk09/ui-observability";
import { ApiError, type OrderApi } from "../api/client";
import type { NewOrder, Order } from "../api/types";

export type PlaceResult = { ok: true; order: Order } | { ok: false; message: string };

// Metric handles belong at module scope. They stay valid across configure() and shutdown(), so
// a restart from the settings panel doesn't break them.
const ordersPlaced = counter("orders.placed");
const orderLatency = histogram("orders.place.duration", { unit: "ms" });

const log = getLogger("orders.ticket");

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The order failed.";
}

/**
 * Places an order. The journey covers the request, from the click to the answer of the API. A
 * journey is ambient, so a record from other code during the request carries its id too. The
 * fill comes later on the stream, and the records of the fill have the orderId, not this journey.
 * Each click starts its own journey.
 * @param api The client that sends the order.
 * @param order The order to place.
 * @returns The placed order, or the reason that the API refused it.
 */
export async function placeOrder(api: OrderApi, order: NewOrder): Promise<PlaceResult> {
  const journey = startJourney("place-order");
  const measure = startMeasure("order.place", { pair: order.pair });
  const startedAt = performance.now();

  try {
    const placed = await api.placeOrder(order);
    measure.end("ok");
    log.logAction("ORDER_PLACED", {
      orderId: placed.id,
      pair: placed.pair,
      side: placed.side,
      qty: placed.qty,
    });
    ordersPlaced.add(1, { outcome: "placed", pair: order.pair });
    orderLatency.record(performance.now() - startedAt, { outcome: "placed" });

    return { ok: true, order: placed };
  } catch (error) {
    measure.end("error");
    // A 422 is a business refusal and a 500 is a fault. Both are errors for the order, and the
    // status tells them apart in the backend.
    log.error("order refused", error, {
      pair: order.pair,
      side: order.side,
      qty: order.qty,
      ...(error instanceof ApiError ? { "http.response.status_code": error.status } : {}),
    });
    ordersPlaced.add(1, { outcome: "refused", pair: order.pair });
    orderLatency.record(performance.now() - startedAt, { outcome: "refused" });

    return { ok: false, message: messageOf(error) };
  } finally {
    // Another click can have started a newer journey while this request ran. Leave that one.
    if (currentJourney()?.id === journey.id) {
      endJourney();
    }
  }
}
