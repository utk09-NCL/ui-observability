// src/panels/ticket-panel.tsx
//
// The order ticket: a pair, a side, a quantity, the live bid and ask of the pair, and the fault
// switch of the mock API. A placed order is one journey, one measure and one fetch with a
// traceparent header, see orders/place-order.ts. The quote changes on its own, so it carries
// data-observability-live. The form with the controls does not.

import { type ReactElement, type SyntheticEvent, useState } from "react";
import { type Pair, PAIRS, type Side } from "../api/types";
import { upsertOrder } from "../data/orders-store";
import { useMarket } from "../data/market-store";
import { useBusy } from "../observability-settings/operation-queue";
import { placeOrder } from "../orders/place-order";
import { useWorkspace } from "../workspace/context";
import { FaultSwitch } from "./fault-switch";

const MAX_QTY = 1_000_000;

function isPair(value: string): value is Pair {
  return PAIRS.some((pair) => pair === value);
}

/**
 * Renders the ticket and the fault switch.
 * @returns The panel.
 */
export function TicketPanel(): ReactElement {
  const { api } = useWorkspace();
  const { prices } = useMarket();
  const [pair, setPair] = useState<Pair>("EURUSD");
  const [side, setSide] = useState<Side>("BUY");
  const [qty, setQty] = useState("100");
  const [placing, setPlacing] = useState(false);
  const [message, setMessage] = useState("");
  // A call that is lost while the library restarts or rotates would be an order without a record.
  const busy = useBusy() || placing;
  const quote = prices[pair];

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const amount = Number(qty);
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_QTY) {
      setMessage("The quantity must be a whole number from 1 to 1,000,000.");

      return;
    }

    setPlacing(true);
    setMessage("");
    try {
      const result = await placeOrder(api, { pair, side, qty: amount });
      if (result.ok) {
        upsertOrder(result.order);
        setMessage(`Order ${result.order.id} placed.`);
      } else {
        setMessage(`Order refused. ${result.message}`);
      }
    } finally {
      setPlacing(false);
    }
  };

  return (
    <section className="panel" aria-label="Order ticket">
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="field">
          <label htmlFor="ticket-pair">Pair</label>
          <select
            id="ticket-pair"
            value={pair}
            onChange={(event) => {
              if (isPair(event.target.value)) {
                setPair(event.target.value);
              }
            }}
          >
            {PAIRS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <p className="quote" data-observability-live>
          Bid <strong>{quote ? quote.bid : "-"}</strong> Ask{" "}
          <strong>{quote ? quote.ask : "-"}</strong>
        </p>
        <div className="field">
          <label htmlFor="ticket-side">Side</label>
          <select
            id="ticket-side"
            value={side}
            onChange={(event) => {
              setSide(event.target.value === "SELL" ? "SELL" : "BUY");
            }}
          >
            <option value="BUY">Buy</option>
            <option value="SELL">Sell</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ticket-qty">Quantity</label>
          <input
            id="ticket-qty"
            type="number"
            min={1}
            max={MAX_QTY}
            step={1}
            value={qty}
            onChange={(event) => {
              setQty(event.target.value);
            }}
          />
        </div>
        <button type="submit" disabled={busy} data-observability-action="place-order">
          {placing ? "Placing" : "Place order"}
        </button>
        <p role="status" className="muted">
          {message}
        </p>
      </form>
      <FaultSwitch api={api} />
    </section>
  );
}
