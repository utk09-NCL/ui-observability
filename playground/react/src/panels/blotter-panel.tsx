// src/panels/blotter-panel.tsx
//
// The blotter: the orders of the user with a status filter, a pair filter and a cancel button.
// It also has two stress controls. They give the library something to see: a long frame, and a
// control that does nothing, which is a dead click and, with three quick clicks, a rage click.

import { type ReactElement, useMemo, useState } from "react";
import { getLogger, profiler } from "@utk09/ui-observability";
import { type OrderStatus, PAIRS } from "../api/types";
import { upsertOrder, useOrders } from "../data/orders-store";
import { useBusy } from "../observability-settings/operation-queue";
import { cancelOrder } from "../orders/cancel-order";
import { useWorkspace } from "../workspace/context";

type StatusFilter = OrderStatus | "all";
type PairFilter = (typeof PAIRS)[number] | "all";

const STATUS_FILTERS: StatusFilter[] = ["all", "working", "filled", "cancelled"];
const FREEZE_MS = 300;
const EXPORT_HINT =
  "Does nothing on purpose. One click is a dead click. Three quick clicks are a rage click.";

const log = getLogger("orders.blotter");

// Probes belong at module scope. While profiler.enabled is false, begin() reads no clock. The
// filter probe times the work of one filter pass. The paint probe times a click on a filter
// until the page has painted the new rows.
const FILTER_PROBE = "blotter.filter";
const paintProbe = profiler.probe("blotter.filter.paint");

function isStatusFilter(value: string): value is StatusFilter {
  return STATUS_FILTERS.some((filter) => filter === value);
}

function isPairFilter(value: string): value is PairFilter {
  return value === "all" || PAIRS.some((pair) => pair === value);
}

/** Blocks the main thread. A page that stops answering for 100 ms or more is a long frame. */
function freeze(durationMs: number): void {
  const end = performance.now() + durationMs;
  while (performance.now() < end) {
    // Spin on purpose. The library's long-frame capture reports this block.
  }
}

/**
 * Renders the blotter, newest order first.
 * @returns The panel.
 */
export function BlotterPanel(): ReactElement {
  const { api } = useWorkspace();
  const orders = useOrders();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [pair, setPair] = useState<PairFilter>("all");
  const [error, setError] = useState("");
  // True while a login, a logout, a restart or a change of setting runs.
  const busy = useBusy();

  // StrictMode runs the function of useMemo twice in development, so the dev server counts two
  // blotter.filter spans for each filter pass.
  const visible = useMemo(
    () =>
      profiler.time(FILTER_PROBE, () =>
        orders
          .filter(
            (order) =>
              (status === "all" || order.status === status) &&
              (pair === "all" || order.pair === pair),
          )
          .reverse(),
      ),
    [orders, status, pair],
  );

  const cancel = (id: string): void => {
    setError("");
    void cancelOrder(api, id).then((result) => {
      if (result.ok) {
        upsertOrder(result.order);
      } else {
        setError(result.message);
      }
    });
  };

  // The span starts in the click handler, and ends after the next paint, so it includes the
  // render, the style, the layout and the paint of the new rows.
  const timed = (change: () => void): void => {
    const token = paintProbe.begin();
    change();
    paintProbe.endAfterPaint(token);
  };

  return (
    <section className="panel" aria-label="Blotter">
      <div className="controls">
        <label>
          Status
          <select
            value={status}
            onChange={(event) => {
              const next = event.target.value;
              if (isStatusFilter(next)) {
                timed(() => {
                  setStatus(next);
                });
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
              const next = event.target.value;
              if (isPairFilter(next)) {
                timed(() => {
                  setPair(next);
                });
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
        <button
          type="button"
          data-observability-action="freeze-page"
          title="Blocks the page for 300 ms, so the library records a long frame."
          onClick={() => {
            freeze(FREEZE_MS);
            log.info("The page froze on purpose.", { durationMs: FREEZE_MS });
          }}
        >
          Freeze 300 ms
        </button>
        <button
          type="button"
          data-observability-action="export-orders"
          title={EXPORT_HINT}
          onClick={() => {
            // No state change and no request, so the page shows no response.
          }}
        >
          Export (does nothing)
        </button>
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
                        cancel(order.id);
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
