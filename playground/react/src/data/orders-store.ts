// src/data/orders-store.ts
//
// The orders of the user. The first list call, a placed order, a cancel and the stream all write
// here, and the blotter and the positions panel read it.

import { useSyncExternalStore } from "react";
import type { Order } from "../api/types";

let orders: readonly Order[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly Order[]): void {
  orders = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getOrders(): readonly Order[] {
  return orders;
}

export function subscribeOrders(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** Reads the orders in a component. */
export function useOrders(): readonly Order[] {
  return useSyncExternalStore(subscribeOrders, getOrders);
}

/**
 * Adds an order, or replaces the order with the same id. The order with the newer updatedAt
 * wins, so a late answer of the POST can't turn a filled order back into a working one.
 * @param order The order to store.
 */
export function upsertOrder(order: Order): void {
  const index = orders.findIndex((candidate) => candidate.id === order.id);
  if (index === -1) {
    publish([...orders, order]);

    return;
  }

  publish(
    orders.map((candidate, position) => {
      if (position !== index) {
        return candidate;
      }

      return candidate.updatedAt > order.updatedAt ? candidate : order;
    }),
  );
}

/**
 * Replaces the list with the answer of the API. An order that the stream added in the meantime
 * stays, because the list call can be older than the push.
 * @param list The orders of the API.
 */
export function replaceOrders(list: readonly Order[]): void {
  const ids = new Set(list.map((order) => order.id));
  const newer = orders.filter((order) => !ids.has(order.id));
  publish([...list, ...newer]);
}

/** Forgets the orders, for example at logout or at a tenant switch. */
export function resetOrders(): void {
  publish([]);
}
