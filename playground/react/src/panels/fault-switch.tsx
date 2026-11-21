// src/panels/fault-switch.tsx
//
// Makes the mock API fail the next orders, so a user can see the error record and the span of a
// refused order in the backend.

import { type ReactElement, useEffect, useState } from "react";
import type { Api } from "../api/client";
import type { FaultMode } from "../api/types";

const MODES: { mode: FaultMode; label: string }[] = [
  { mode: "none", label: "None" },
  { mode: "slow", label: "Slow, 2 s" },
  { mode: "reject", label: "Reject, 422" },
  { mode: "error", label: "Error, 500" },
];

/**
 * Renders the switch.
 * @param props The API client.
 * @returns The switch.
 */
export function FaultSwitch({ api }: { api: Pick<Api, "getFault" | "setFault"> }): ReactElement {
  const [mode, setMode] = useState<FaultMode>("none");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api
      .getFault()
      .then((current) => {
        if (active) {
          setMode(current);
        }
      })
      .catch(() => {
        if (active) {
          setError("The fault switch needs the mock app API.");
        }
      });

    return () => {
      active = false;
    };
  }, [api]);

  const choose = (next: FaultMode): void => {
    setError("");
    api
      .setFault(next)
      .then(setMode)
      .catch(() => {
        setError("The mock app API did not accept the mode.");
      });
  };

  return (
    <section aria-labelledby="fault-heading" className="fault">
      <h3 id="fault-heading">Fault switch</h3>
      <p className="muted">Changes how the mock API answers each new order.</p>
      <fieldset>
        <legend>Mode of the order API</legend>
        {MODES.map((item) => (
          <label key={item.mode} className="inline">
            <input
              type="radio"
              name="fault-mode"
              value={item.mode}
              checked={mode === item.mode}
              onChange={() => {
                choose(item.mode);
              }}
            />
            {item.label}
          </label>
        ))}
      </fieldset>
      <p role="alert" className="warn">
        {error}
      </p>
    </section>
  );
}
