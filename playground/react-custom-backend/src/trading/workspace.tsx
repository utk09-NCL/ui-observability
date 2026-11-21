// src/trading/workspace.tsx
//
// The page after the login: the header, the ticket, the fault switch, the blotter and the
// observability settings. It owns the prices and the orders, and the stream feeds both.

import { type ReactElement, useCallback, useEffect, useState } from "react";
import { getLogger } from "@utk09/ui-observability";
import type { Api } from "../api/client";
import type { Order, Pair } from "../api/types";
import { restartObservability } from "../observability/user-context";
import { ObservabilitySettings } from "../observability-settings/observability-settings";
import { useBusy } from "../observability-settings/operation-queue";
import { cancelOrder } from "../orders/cancel-order";
import type { Session } from "../session/session";
import { Blotter } from "./blotter";
import { FaultSwitch } from "./fault-switch";
import { useStream } from "./stream";
import { type Prices, Ticket } from "./ticket";

const log = getLogger("orders.blotter");

/**
 * Adds an order, or replaces the order with the same id. The order with the newer updatedAt
 * wins, so a late answer of the POST can't turn a filled order back into a working one.
 */
function upsert(orders: Order[], order: Order): Order[] {
  const index = orders.findIndex((candidate) => candidate.id === order.id);
  if (index === -1) {
    return [...orders, order];
  }

  return orders.map((candidate, position) => {
    if (position !== index) {
      return candidate;
    }

    return candidate.updatedAt > order.updatedAt ? candidate : order;
  });
}

/**
 * Renders the workspace of a logged-in user.
 * @param props The session, the API client and the logout callback.
 * @returns The workspace.
 */
export function Workspace({
  session,
  api,
  onLogout,
}: {
  session: Session;
  api: Api;
  onLogout: () => void;
}): ReactElement {
  const [prices, setPrices] = useState<Prices>({});
  const [orders, setOrders] = useState<Order[]>([]);
  const [cancelError, setCancelError] = useState("");
  // True while a login, a logout, a restart or a change of setting runs.
  const busy = useBusy();

  const onPrice = useCallback((pair: Pair, bid: number, ask: number) => {
    setPrices((previous) => ({ ...previous, [pair]: { bid, ask } }));
  }, []);
  const onOrder = useCallback((order: Order) => {
    setOrders((previous) => upsert(previous, order));
    if (order.status === "filled") {
      log.logEvent("ORDER_FILLED", { orderId: order.id, price: order.price });
    }
  }, []);
  // The token comes from the session, so a render between the logout and the end of the session
  // can't open a socket with an empty token.
  useStream(session.token, { onPrice, onOrder });

  useEffect(() => {
    let active = true;
    api
      .listOrders()
      .then((list) => {
        if (active) {
          setOrders(list);
        }
      })
      .catch((error: unknown) => {
        log.error("order list failed", error);
      });

    return () => {
      active = false;
    };
  }, [api]);

  const cancel = (id: string): void => {
    setCancelError("");
    void cancelOrder(api, id).then((result) => {
      if (result.ok) {
        onOrder(result.order);
      } else {
        setCancelError(result.message);
      }
    });
  };

  return (
    <>
      <header className="bar">
        <h1>FX ticket, custom backend</h1>
        <p>
          User <strong>{session.user}</strong>, tenant <strong>{session.tenant}</strong>
        </p>
        <button type="button" disabled={busy} data-observability-action="logout" onClick={onLogout}>
          Log out
        </button>
      </header>
      <main className="workspace">
        <div className="trading">
          <div className="grid">
            <Ticket api={api} prices={prices} onPlaced={onOrder} />
            <FaultSwitch api={api} />
          </div>
          <Blotter orders={orders} onCancel={cancel} error={cancelError} busy={busy} />
        </div>
        <aside className="observability" aria-label="Observability">
          <ObservabilitySettings onRestart={restartObservability} />
        </aside>
      </main>
    </>
  );
}
