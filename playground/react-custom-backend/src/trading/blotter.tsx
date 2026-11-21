// src/trading/blotter.tsx
//
// The blotter: the orders of the user with a status filter, a pair filter and a cancel button.

import { type ReactElement, useMemo, useState } from "react";
import { type Order, type OrderStatus, PAIRS } from "../api/types";

type StatusFilter = OrderStatus | "all";
type PairFilter = (typeof PAIRS)[number] | "all";

const STATUS_FILTERS: StatusFilter[] = ["all", "working", "filled", "cancelled"];

function isStatusFilter(value: string): value is StatusFilter {
  return STATUS_FILTERS.some((filter) => filter === value);
}

function isPairFilter(value: string): value is PairFilter {
  return value === "all" || PAIRS.some((pair) => pair === value);
}

/**
 * Renders the blotter, newest order first.
 * @param props The orders, a cancel callback and the text of the last cancel error.
 * @returns The blotter.
 */
export function Blotter({
  orders,
  onCancel,
  error,
  busy,
}: {
  orders: Order[];
  onCancel: (id: string) => void;
  error: string;
  /** True while a login, a logout, a restart or a change of setting runs. */
  busy: boolean;
}): ReactElement {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [pair, setPair] = useState<PairFilter>("all");
  const visible = useMemo(
    () =>
      orders
        .filter(
          (order) =>
            (status === "all" || order.status === status) &&
            (pair === "all" || order.pair === pair),
        )
        .reverse(),
    [orders, status, pair],
  );

  return (
    <section aria-labelledby="blotter-heading" className="card">
      <h2 id="blotter-heading">Blotter</h2>
      <div className="controls">
        <label>
          Status
          <select
            value={status}
            onChange={(event) => {
              if (isStatusFilter(event.target.value)) {
                setStatus(event.target.value);
              }
            }}
          >
            {STATUS_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {filter}
              </option>
            ))}
          </select>
        </label>
        <label>
          Pair
          <select
            value={pair}
            onChange={(event) => {
              if (isPairFilter(event.target.value)) {
                setPair(event.target.value);
              }
            }}
          >
            <option value="all">all</option>
            {PAIRS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p role="alert" className="warn">
        {error}
      </p>
      <div className="table-scroll">
        <table className="blotter">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Pair</th>
              <th scope="col">Side</th>
              <th scope="col">Quantity</th>
              <th scope="col">Status</th>
              <th scope="col">Price</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((order) => (
              <tr key={order.id}>
                <td>{order.id}</td>
                <td>{order.pair}</td>
                <td>{order.side}</td>
                <td>{order.qty}</td>
                <td data-status={order.status}>{order.status}</td>
                <td>{order.price ?? "-"}</td>
                <td>
                  {order.status === "working" && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Cancel ${order.id}`}
                      data-observability-action="cancel-order"
                      onClick={() => {
                        onCancel(order.id);
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <p className="muted">No order matches the filters.</p>}
      </div>
    </section>
  );
}
