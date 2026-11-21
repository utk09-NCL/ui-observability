// src/orders/cancel-order.ts
//
// Cancels one working order and records it. Like placeOrder(), it never throws.

import { getLogger } from "@utk09/ui-observability";
import type { Api } from "../api/client";
import type { Order } from "../api/types";

const log = getLogger("orders.blotter");

export type CancelResult = { ok: true; order: Order } | { ok: false; message: string };

/**
 * Cancels an order. The server answers 409 for an order that filled in the meantime.
 * @param api The client that sends the cancel.
 * @param id The order id.
 * @returns The cancelled order, or the reason that the API refused it.
 */
export async function cancelOrder(
  api: Pick<Api, "cancelOrder">,
  id: string,
): Promise<CancelResult> {
  try {
    const order = await api.cancelOrder(id);
    log.logAction("ORDER_CANCELLED", { orderId: id });

    return { ok: true, order };
  } catch (error) {
    log.error("cancel refused", error, { orderId: id });

    return { ok: false, message: error instanceof Error ? error.message : "The cancel failed." };
  }
}
