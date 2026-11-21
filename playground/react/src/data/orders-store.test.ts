import { afterEach, describe, expect, it } from "vitest";
import type { Order } from "../api/types";
import { getOrders, replaceOrders, resetOrders, upsertOrder } from "./orders-store";

function order(id: string, status: Order["status"], updatedAt: string): Order {
  return {
    id,
    pair: "EURUSD",
    side: "BUY",
    qty: 100,
    status,
    price: status === "filled" ? 1.08 : null,
    createdAt: "2026-11-21T10:00:00.000Z",
    updatedAt,
  };
}

afterEach(() => {
  resetOrders();
});

describe("orders store", () => {
  it("adds an order, and replaces the order with the same id", () => {
    upsertOrder(order("ORD-1", "working", "2026-11-21T10:00:00.000Z"));
    upsertOrder(order("ORD-1", "filled", "2026-11-21T10:00:02.000Z"));

    expect(getOrders().map((item) => item.status)).toEqual(["filled"]);
  });

  it("keeps the newer order when a late answer of the POST arrives after the fill", () => {
    upsertOrder(order("ORD-1", "filled", "2026-11-21T10:00:02.000Z"));
    upsertOrder(order("ORD-1", "working", "2026-11-21T10:00:00.000Z"));

    expect(getOrders().map((item) => item.status)).toEqual(["filled"]);
  });

  it("keeps an order that the stream added before the list call answered", () => {
    upsertOrder(order("ORD-2", "working", "2026-11-21T10:00:01.000Z"));
    replaceOrders([order("ORD-1", "filled", "2026-11-21T10:00:00.000Z")]);

    expect(getOrders().map((item) => item.id)).toEqual(["ORD-1", "ORD-2"]);
  });

  it("forgets the orders on reset", () => {
    upsertOrder(order("ORD-1", "working", "2026-11-21T10:00:00.000Z"));
    resetOrders();

    expect(getOrders()).toEqual([]);
  });
});
