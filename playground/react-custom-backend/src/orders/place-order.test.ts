import { describe, expect, it } from "vitest";
import { currentJourney, flush, startJourney } from "@utk09/ui-observability";
import { memory } from "../../test/observability";
import { ApiError, type OrderApi } from "../api/client";
import type { NewOrder, Order } from "../api/types";
import { placeOrder } from "./place-order";

const request: NewOrder = { pair: "EURUSD", side: "BUY", qty: 100 };

const placed: Order = {
  id: "ORD-1001",
  ...request,
  status: "working",
  price: null,
  createdAt: "2026-11-21T10:00:00.000Z",
  updatedAt: "2026-11-21T10:00:00.000Z",
};

const accepting: OrderApi = { placeOrder: () => Promise.resolve(placed) };

function refusing(status: number, message: string): OrderApi {
  return { placeOrder: () => Promise.reject(new ApiError(status, message)) };
}

async function recordsAfterFlush(): Promise<ReturnType<typeof memory.records>> {
  await flush();

  return memory.records();
}

describe("placeOrder", () => {
  it("logs ORDER_PLACED with the order id and a journey id", async () => {
    const result = await placeOrder(accepting, request);
    const record = (await recordsAfterFlush()).find((item) => item.body === "ORDER_PLACED");

    expect(result).toEqual({ ok: true, order: placed });
    expect(record?.attributes).toMatchObject({
      orderId: "ORD-1001",
      "log.type": "action",
      "journey.name": "place-order",
    });
    expect(record?.attributes["journey.id"]).toEqual(expect.any(String));
  });

  it("ends its journey when the answer arrives", async () => {
    await placeOrder(accepting, request);

    expect(currentJourney()).toBeNull();
  });

  it("leaves a newer journey that another click started", async () => {
    const slowButNewer: OrderApi = {
      placeOrder: () => {
        startJourney("second-order");

        return Promise.resolve(placed);
      },
    };

    await placeOrder(slowButNewer, request);

    expect(currentJourney()?.name).toBe("second-order");
  });

  it.each([
    [422, "Insufficient credit"],
    [500, "Internal error"],
  ])("logs an error record when the API answers %i", async (status, message) => {
    const result = await placeOrder(refusing(status, message), request);
    const records = await recordsAfterFlush();
    const error = records.find((item) => item.body === "order refused");

    expect(result).toEqual({ ok: false, message });
    expect(error?.severityText).toBe("ERROR");
    expect(error?.attributes).toMatchObject({
      "http.response.status_code": status,
      "error.message": message,
      pair: "EURUSD",
    });
    expect(error?.attributes["journey.id"]).toEqual(expect.any(String));
    expect(records.some((item) => item.body === "ORDER_PLACED")).toBe(false);
  });

  it("returns a message for an error that is not an ApiError", async () => {
    const broken: OrderApi = { placeOrder: () => Promise.reject(new TypeError("Failed to fetch")) };

    expect(await placeOrder(broken, request)).toEqual({ ok: false, message: "Failed to fetch" });
  });

  it("counts the order in the orders.placed metric", async () => {
    await placeOrder(accepting, request);
    await placeOrder(refusing(422, "Insufficient credit"), request);
    const points = (await recordsAfterFlush()).filter(
      (item) => item.attributes["metric.name"] === "orders.placed",
    );

    expect(points.map((item) => item.attributes["metric.value"])).toContain(1);
    expect(points).toHaveLength(2);
  });
});
