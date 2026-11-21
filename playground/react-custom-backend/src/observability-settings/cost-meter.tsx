// src/observability-settings/cost-meter.tsx
//
// The cost meter panel: two choices, a run button and a history table, so a user can run the
// meter, change a setting and run it again.

import { type ChangeEvent, type ReactElement, useState } from "react";
import {
  MIN_TICKS_PER_BLOCK,
  p99Cell,
  type MeterLevel,
  type MeterPayload,
  type MeterResult,
  runMeter,
} from "./meter";
import { runExclusive, useBusy } from "./operation-queue";
import { getSettingsState } from "./settings-store";
import { summarize } from "./settings";

const PAYLOAD_LABELS: Record<MeterPayload, string> = {
  order: "Order, a small object",
  blotter: "Blotter, 500 rows",
};

function formatNs(value: number): string {
  return String(Math.round(value));
}

/**
 * Runs the cost meter and keeps the results of this page load.
 * @returns The panel.
 */
export function CostMeter(): ReactElement {
  const [level, setLevel] = useState<MeterLevel>("INFO");
  const [payload, setPayload] = useState<MeterPayload>("order");
  const [running, setRunning] = useState(false);
  // A rotation drops the calls of the meter, so the button waits for the queue too.
  const busy = useBusy();
  const [history, setHistory] = useState<MeterResult[]>([]);

  const run = async (): Promise<void> => {
    setRunning(true);
    try {
      // In the queue, so no restart or logout runs while the meter runs, and the other controls
      // are disabled until it ends.
      const result = await runExclusive(() =>
        runMeter({ level, payload, summary: summarize(getSettingsState().applied) }),
      );
      setHistory((previous) => [result, ...previous]);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section aria-labelledby="meter-heading">
      <h3 id="meter-heading">Cost meter</h3>
      <p className="muted">
        The meter times log calls under the settings in force. Its calls are real records in the
        namespace <code>observability.meter</code>, about 5,000 for each run, and they reach the
        backend. Run it, change a setting, and run it again.
      </p>
      <div className="controls">
        <label>
          Level of the calls
          <select
            value={level}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              setLevel(event.target.value === "DEBUG" ? "DEBUG" : "INFO");
            }}
          >
            <option value="INFO">INFO</option>
            <option value="DEBUG">DEBUG</option>
          </select>
        </label>
        <label>
          Payload
          <select
            value={payload}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              setPayload(event.target.value === "blotter" ? "blotter" : "order");
            }}
          >
            <option value="order">{PAYLOAD_LABELS.order}</option>
            <option value="blotter">{PAYLOAD_LABELS.blotter}</option>
          </select>
        </label>
        <button
          type="button"
          disabled={running || busy}
          onClick={() => {
            void run();
          }}
        >
          {running ? "Running" : "Run the meter"}
        </button>
        {history.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setHistory([]);
            }}
          >
            Clear the history
          </button>
        )}
      </div>
      <p className="muted">
        Cross-origin isolated: <strong>{globalThis.crossOriginIsolated ? "yes" : "no"}</strong>.
        Without isolation the clock step is coarse, and a result is marked clock-limited when a
        block spans fewer than {MIN_TICKS_PER_BLOCK} steps.
      </p>
      {history.length > 0 && (
        <div className="table-scroll">
          <table className="history">
            <caption>
              Results, newest first. Times are for one call. The p99 column prints the max of the
              blocks when a run has fewer than 100 blocks, and then it names the number of blocks.
              The meter is a rough tool to compare two settings, not a percentile benchmark.
            </caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Settings</th>
                <th scope="col">Blocks</th>
                <th scope="col">Calls per block</th>
                <th scope="col">Block p50 ns</th>
                <th scope="col">Block p99 ns</th>
                <th scope="col">Block max ns</th>
                <th scope="col">Per call p99 / max µs</th>
                <th scope="col">Clock step µs</th>
                <th scope="col">Steps per block</th>
              </tr>
            </thead>
            <tbody>
              {history.map((result) => (
                <tr key={result.id}>
                  <td>{result.id}</td>
                  <td>
                    {result.level}, {PAYLOAD_LABELS[result.payload]}. {result.summary}
                  </td>
                  <td>{result.blocks}</td>
                  <td>{result.callsPerBlock}</td>
                  <td>{formatNs(result.blockNs.p50)}</td>
                  <td>{p99Cell(result)}</td>
                  <td>{formatNs(result.blockNs.max)}</td>
                  <td>
                    {result.perCallUs.p99} / {result.perCallUs.max}
                  </td>
                  <td>{result.clockStepUs}</td>
                  <td>
                    {result.ticksPerBlock}
                    {result.clockLimited && <strong className="warn"> clock-limited</strong>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
