import { type ReactElement, useState } from "react";
import { LoggerProvider, ObservabilityErrorBoundary, useJourney, useLogger } from "./observability";

/**
 * A component whose lifetime is shorter than the workflow it belongs to.
 * @returns Submit button.
 */
function OrderTicket(): ReactElement {
  const log = useLogger("blotter.ticket");
  useJourney("order-lifecycle");
  const [submitted, setSubmitted] = useState(false);

  return (
    <button
      onClick={() => {
        log.logAction("ORDER_SUBMIT", { orderId: "ORD-1001", qty: 100 });
        setSubmitted(true);
      }}
    >
      {submitted ? "submitted" : "submit"}
    </button>
  );
}

/**
 * Fails on render so the boundary has something to report.
 * @returns Never returns.
 */
function Boom(): never {
  throw new Error("render failed on purpose");
}

/**
 * The example application.
 * @returns Root element.
 */
export function App(): ReactElement {
  const [mounted, setMounted] = useState(true);
  const [explode, setExplode] = useState(false);

  return (
    <LoggerProvider namespace="blotter">
      <h1>ui-observability, React example</h1>
      {mounted && <OrderTicket />}
      <button
        onClick={() => {
          setMounted((v) => !v);
        }}
      >
        toggle the ticket
      </button>
      <button
        onClick={() => {
          setExplode(true);
        }}
      >
        break a render
      </button>
      <ObservabilityErrorBoundary fallback={<p>something broke, and it was logged</p>}>
        {explode ? <Boom /> : null}
      </ObservabilityErrorBoundary>
    </LoggerProvider>
  );
}
