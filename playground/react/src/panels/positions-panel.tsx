// src/panels/positions-panel.tsx
//
// The positions of the user and their P&L. A dedicated worker computes the P&L. The page
// registers the worker with registerWorker(), so the records that the worker logs reach the page
// over the bus. The page batches and sends them, and its redact hook runs on them. The mid price,
// the P&L and the time of the last pass change on their own, so they carry
// data-observability-live.

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { getLogger, registerWorker } from "@utk09/ui-observability";
import { PAIRS, type Position } from "../api/types";
import { getMarketState } from "../data/market-store";
import { useRuntimeGeneration } from "../observability/runtime-generation";
import { useOrders } from "../data/orders-store";
import { useWorkspace } from "../workspace/context";
import { isFromWorker, type PnlRow, type ToWorker } from "./positions-protocol";

const log = getLogger("positions.panel");

/** How often the panel hands the latest prices to the worker. The worker computes as often. */
const PRICE_PUSH_MS = 500;

/**
 * Creates the worker. The literal URL form is the one that Vite bundles as a worker.
 * @returns A new module worker.
 */
function createWorker(): Worker {
  return new Worker(new URL("./positions.worker.ts", import.meta.url), { type: "module" });
}

/**
 * Renders the positions table.
 * @returns The panel.
 */
export function PositionsPanel(): ReactElement {
  const { api } = useWorkspace();
  const orders = useOrders();
  const [rows, setRows] = useState<PnlRow[]>([]);
  const [computeMs, setComputeMs] = useState<number | null>(null);
  const [error, setError] = useState("");
  const worker = useRef<Worker | null>(null);
  // The last positions that the API gave. A new worker of a new generation gets them at its start,
  // so a restart needs no new request. A request after a logout would get a 401.
  const latest = useRef<Position[]>([]);
  const generation = useRuntimeGeneration();
  // A fill changes the positions, and a fill is the only change that the API nets. The count
  // of filled orders is the cheap signal to read them again.
  const filled = useMemo(
    () => orders.filter((order) => order.status === "filled").length,
    [orders],
  );

  // The worker lives while the panel is mounted. The cleanup removes the registration and ends
  // the worker, so StrictMode can mount, unmount and mount again. Nothing else leaves the panel.
  // A restart of the library removes the registration of the worker with the old runtime, so a
  // new generation starts a new worker and registers it with the new runtime.
  useEffect(() => {
    const instance = createWorker();
    // The worker asks for the journey of the page when its runtime starts. Without journey:read,
    // the bus refuses that request and counts bus.journey_denied. With it, the records of the
    // worker carry the active journey.
    const unregister = registerWorker(instance, { permissions: ["records", "journey:read"] });
    instance.addEventListener("message", (event: MessageEvent) => {
      const message: unknown = event.data;
      if (isFromWorker(message)) {
        setRows(message.rows);
        setComputeMs(message.computeMs);
      }
    });
    instance.addEventListener("error", () => {
      setError("The positions worker stopped.");
      log.error("The positions worker failed.");
    });
    worker.current = instance;
    if (latest.current.length > 0) {
      const known: ToWorker = { type: "positions", rows: latest.current };
      instance.postMessage(known);
    }

    // The worker keeps the latest mid price of each pair, so a push twice a second is enough
    // and a lost push is harmless. A push for each tick would post 64 messages a second.
    const sendPrices = (): void => {
      const { prices } = getMarketState();
      for (const pair of PAIRS) {
        const tile = prices[pair];
        if (tile) {
          const message: ToWorker = { type: "price", pair, bid: tile.bid, ask: tile.ask };
          instance.postMessage(message);
        }
      }
    };
    sendPrices();
    const timer = setInterval(sendPrices, PRICE_PUSH_MS);

    return () => {
      clearInterval(timer);
      unregister();
      instance.terminate();
      worker.current = null;
    };
  }, [generation]);

  useEffect(() => {
    let active = true;
    api
      .positions()
      .then((positions) => {
        if (active) {
          latest.current = positions;
          const message: ToWorker = { type: "positions", rows: positions };
          worker.current?.postMessage(message);
        }
      })
      .catch((reason: unknown) => {
        log.error("positions request failed", reason);
        if (active) {
          setError("The positions could not load.");
        }
      });

    return () => {
      active = false;
    };
  }, [api, filled]);

  return (
    <section className="panel" aria-label="Positions">
      <p className="muted">
        The worker computes P&amp;L from the net position and the live mid price.
        {computeMs !== null && (
          <>
            {" "}
            Last pass: <span data-observability-live>{computeMs}</span> ms.
          </>
        )}
      </p>
      <p role="alert" className="warn">
        {error}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Pair</th>
              <th scope="col">Net quantity</th>
              <th scope="col">Average price</th>
              <th scope="col">Mid</th>
              <th scope="col">P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.pair}>
                <td>{row.pair}</td>
                <td>{row.netQty}</td>
                <td>{row.avgPrice}</td>
                <td data-observability-live>{row.mid ?? "-"}</td>
                <td
                  data-sign={row.pnl === null ? "none" : Math.sign(row.pnl)}
                  data-observability-live
                >
                  {row.pnl ?? "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted">No filled order yet. Place an order.</p>}
      </div>
    </section>
  );
}
