import { counter, histogram } from "@utk09/ui-observability";
import { type ReactElement, useState } from "react";
import { LoggerProvider, ObservabilityErrorBoundary, useJourney, useLogger } from "./observability";

// Module scope. A handle stays valid across configure() and shutdown(). The library sums the
// values and sends one point for each attribute set at each interval.
const ordersSubmitted = counter("orders.submitted");
const pricingLatency = histogram("pricing.latency", { unit: "ms" });

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
        ordersSubmitted.add(1, { venue: "LSE" });
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
      <button
        onClick={() => {
          // 20 values give one histogram point at the next interval, not 20 records.
          for (let i = 0; i < 20; i++) {
            pricingLatency.record(Math.round(Math.random() * 400), { venue: "LSE" });
          }
        }}
      >
        price 20 quotes
      </button>
      <button
        onClick={() => {
          // Fetch capture records http.client.request.duration with status 404.
          void fetch("http://localhost:8787/missing");
        }}
      >
        fetch a missing URL
      </button>
      <ObservabilityErrorBoundary fallback={<p>something broke, and it was logged</p>}>
        {explode ? <Boom /> : null}
      </ObservabilityErrorBoundary>
    </LoggerProvider>
  );
}
