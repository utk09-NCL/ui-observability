// src/workspace/use-workspace-data.ts
//
// The data hooks of a page that shows panels: the main workspace and the window of one panel.
// Each page opens its own WebSocket, because a window is its own document.

import { useEffect } from "react";
import { getLogger } from "@utk09/ui-observability";
import type { Api } from "../api/client";
import type { Order } from "../api/types";
import { applyTick, resetMarket, startTickRate } from "../data/market-store";
import { replaceOrders, resetOrders, upsertOrder } from "../data/orders-store";
import { useStream } from "../data/stream";
import { refreshSession, type Session } from "../session/session";
import { startTokenRefresh } from "../session/token-refresh";

const ordersLog = getLogger("orders.blotter");
const sessionLog = getLogger("session");

function onOrder(order: Order): void {
  upsertOrder(order);
  if (order.status === "filled") {
    ordersLog.logEvent("ORDER_FILLED", { orderId: order.id, price: order.price });
  }
}

/**
 * Starts the data of the page: the stream, the tick-rate meter and the first order list. The
 * cleanup of each effect stops its own work, so StrictMode can run mount, unmount and mount
 * again. The token comes from the session, so a render between the logout and the end of the
 * session can't open a socket with an empty token.
 * @param session The session of the user.
 * @param api The client of the app API.
 */
export function useWorkspaceData(session: Session, api: Api): void {
  useStream(session.token, { onPrice: applyTick, onOrder });

  useEffect(() => startTickRate(), []);

  useEffect(() => {
    let active = true;
    api
      .listOrders()
      .then((list) => {
        if (active) {
          replaceOrders(list);
        }
      })
      .catch((error: unknown) => {
        ordersLog.error("order list failed", error);
      });

    return () => {
      active = false;
      resetOrders();
      resetMarket();
    };
  }, [api, session.token]);
}

/**
 * Refreshes the token on a timer, as the "Token refresh" recipe says. The library needs no call
 * for it, because its headers function reads the current token on each request. The timer is the
 * only thing that leaves the component, and its cleanup stops it.
 * @param session The session of the user.
 * @param api The client of the app API.
 */
export function useTokenRefresh(session: Session, api: Api): void {
  useEffect(
    () =>
      startTokenRefresh({
        refresh: () => refreshSession(api),
        expiresInMs: session.expiresInMs,
        onError: (error) => {
          sessionLog.error("token refresh failed", error);
        },
      }),
    [api, session],
  );
}
