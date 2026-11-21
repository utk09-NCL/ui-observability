// src/observability-settings/recent-records.tsx
//
// The recent records that the processor tap saw, with a namespace filter and a switch that hides
// the price ticks. Each field renders as React text, so a record body can't add markup.

import { type ReactElement, useEffect, useState } from "react";
import { readTap, type TappedRecord } from "./tap";

const POLL_MS = 500;
const SHOWN = 50;
const NOISY_NAMESPACE = "market.prices";

/**
 * Lists the recent records, newest first, at most 50 of those that pass the filter.
 * @returns The list.
 */
export function RecentRecords(): ReactElement {
  const [records, setRecords] = useState<readonly TappedRecord[]>([]);
  const [filter, setFilter] = useState("");
  const [hidePrices, setHidePrices] = useState(true);

  useEffect(() => {
    const read = (): void => {
      setRecords([...readTap().recent].reverse());
    };
    read();
    const timer = setInterval(read, POLL_MS);

    return () => {
      clearInterval(timer);
    };
  }, []);

  const shown = records
    .filter((record) => !(hidePrices && record.namespace === NOISY_NAMESPACE))
    .filter((record) => record.namespace.includes(filter.trim()))
    .slice(0, SHOWN);

  return (
    <section aria-labelledby="recent-heading">
      <h3 id="recent-heading">Recent records</h3>
      <div className="controls">
        <label>
          Namespace contains
          <input
            type="search"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={hidePrices}
            onChange={(event) => {
              setHidePrices(event.target.checked);
            }}
          />
          Hide {NOISY_NAMESPACE}
        </label>
      </div>
      <ol className="recent">
        {shown.map((record) => (
          <li key={record.id}>
            <span className={`level level-${record.level.toLowerCase()}`}>{record.level}</span>{" "}
            <span className="muted">
              {record.namespace} {record.type}
            </span>{" "}
            {record.body}
          </li>
        ))}
      </ol>
    </section>
  );
}
