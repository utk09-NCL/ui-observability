import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { configure } from "ui-observability";
import { App } from "./app";

// Module scope, before render, exactly once. configure() is idempotent, so a
// second call is survivable, but a call inside a component is work repeated on
// every render and, under StrictMode, immediately doubled.
configure({
  endpoint: "http://localhost:8787/v1/logs",
  serviceName: "example-react",
  serviceVersion: "0.0.0",
  environment: "local",
  minLevel: "TRACE",
  console: { enabled: true },
  capture: {
    errors: true,
    rejections: true,
    fetch: true,
    interactions: true,
    navigation: true,
    webVitals: true,
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
