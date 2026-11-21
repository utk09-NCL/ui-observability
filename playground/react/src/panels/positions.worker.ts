// src/panels/positions.worker.ts
//
// The worker of the Positions panel. It computes the profit and loss and logs what it did. The
// page registers this worker with registerWorker(), so the library forwards the records of this
// worker to the page. The page batches them and runs its redact hook on them.

import { configure, getLogger } from "@utk09/ui-observability";
import { computePnl, isToWorker, type FromWorker, type PositionInput } from "./positions-protocol";

const COMPUTE_EVERY_MS = 500;
// The worker computes twice a second. A summary every 20 passes is one record in 10 seconds.
const LOG_EVERY_COMPUTES = 20;

// The worker calls configure() too. It has no endpoint, so a worker that finds no owner sends
// nothing. That happens when the page runs paused, because a paused runtime starts no bus. A
// worker can't read the consent of the user, because it has no localStorage. With an endpoint, it
// would send its own records around a withdrawal of consent.
configure({
  serviceName: "react-workspace-positions",
  serviceVersion: "0.0.0",
  environment: "local",
  minLevel: "DEBUG",
});

const log = getLogger("positions.worker");

let positions: PositionInput[] = [];
const mids = new Map<string, number>();
let dirty = false;
let computes = 0;

function compute(): void {
  if (!dirty) {
    return;
  }

  dirty = false;
  const startedAt = performance.now();
  const rows = computePnl(positions, mids);
  const computeMs = Number((performance.now() - startedAt).toFixed(3));
  const message: FromWorker = { type: "pnl", rows, computeMs };
  self.postMessage(message);

  computes += 1;
  if (computes % LOG_EVERY_COMPUTES === 0) {
    const total = rows.reduce((sum, row) => sum + (row.pnl ?? 0), 0);
    log.info("pnl summary", { computes, positions: rows.length, total: Number(total.toFixed(2)) });
  }
}

self.addEventListener("message", (event: MessageEvent) => {
  const message: unknown = event.data;
  if (!isToWorker(message)) {
    // The library's own bus messages also arrive here. They are not ours.
    return;
  }

  if (message.type === "positions") {
    positions = message.rows;
    log.info("positions received", { count: positions.length });
  } else {
    mids.set(message.pair, Number(((message.bid + message.ask) / 2).toFixed(6)));
  }
  dirty = true;
});

setInterval(compute, COMPUTE_EVERY_MS);
