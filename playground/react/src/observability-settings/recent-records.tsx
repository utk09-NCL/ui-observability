// src/observability-settings/recent-records.tsx
//
// The recent records that the processor tap saw, with a namespace filter and a switch that hides
// the price ticks. Each field renders as React text, so a record body can't add markup.

import { type ReactElement, useEffect, useState } from "react";
import { readTap, type TappedRecord } from "./tap";

const POLL_MS = 500;
const SHOWN = 50;
const NOISY_NAMESPACE = "market.prices";

/** True when both lists hold the same records in the same order. The ids are unique. */
function sameRecords(a: readonly TappedRecord[], b: readonly TappedRecord[]): boolean {
  return a.length === b.length && a.every((record, index) => record.id === b[index]?.id);
}

/**
 * The list. It polls the tap and keeps a new list only when the shown records changed. A
 * hidden price tick then causes no render, and no DOM write. The dead-click check of the library
 * counts each DOM write in the document as the answer of the page to a click.
 * @param props The filter text and the switch that hides the price ticks.
 * @returns The list.
 */
function RecentList({ filter, hidePrices }: { filter: string; hidePrices: boolean }): ReactElement {
  const [shown, setShown] = useState<readonly TappedRecord[]>([]);

  useEffect(() => {
    const read = (): void => {
      const next = [...readTap().recent]
        .reverse()
        .filter((record) => !(hidePrices && record.namespace === NOISY_NAMESPACE))
        .filter((record) => record.namespace.includes(filter.trim()))
        .slice(0, SHOWN);
      setShown((previous) => (sameRecords(previous, next) ? previous : next));
    };
    read();
    const timer = setInterval(read, POLL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [filter, hidePrices]);

  return (
    <ol className="recent">
      {shown.map((record) => (
        <li key={record.id}>
          <time className="muted" dateTime={new Date(record.at).toISOString()}>
            {new Date(record.at).toISOString().slice(11, 23)}
          </time>{" "}
          <span className={`level level-${record.level.toLowerCase()}`}>{record.level}</span>{" "}
          <span className="muted">
            {record.namespace} {record.type}
          </span>{" "}
          {record.body}
        </li>
      ))}
    </ol>
  );
}

/**
 * Lists the recent records, newest first, at most 50 of those that pass the filter.
 * @returns The list.
 */
export function RecentRecords(): ReactElement {
  const [filter, setFilter] = useState("");
  const [hidePrices, setHidePrices] = useState(true);

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
      <RecentList filter={filter} hidePrices={hidePrices} />
    </section>
  );
}
