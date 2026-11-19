import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { configure } from "@utk09/ui-observability";
import { App } from "./app";

// Module scope, before render, exactly once. configure() is idempotent, so a
// second call is survivable, but a call inside a component is work repeated on
// every render and, under StrictMode, immediately doubled.
configure({
  endpoint: "http://localhost:8787/v1/logs",
  // Counter, histogram and HTTP duration points go here in the OTLP metrics format.
  metricsEndpoint: "http://localhost:8787/v1/metrics",
  serviceName: "example-react",
  serviceVersion: "0.0.0",
  environment: "local",
  minLevel: "TRACE",
  consoleOutput: true,
  capture: {
    errors: true,
    rejections: true,
    fetch: true,
    interactions: true,
    navigation: true,
    // The loader is required, because the library never imports web-vitals by name. Without it
    // the library reports config.invalid and LCP, CLS and INP stay off.
    webVitals: { loader: () => import("web-vitals") },
  },
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html is missing #root");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
