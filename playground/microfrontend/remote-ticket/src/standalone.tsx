// The entry for running this remote by itself, loaded by index.html. mount.tsx
// does not import this file, so the federated build cannot drag it into the
// shell, where it would reconfigure the host's runtime.
import { configure } from "@utk09/ui-observability";

configure({
  endpoint: "http://localhost:8787/v1/logs",
  serviceName: "example-ticket-standalone",
  environment: "local",
  minLevel: "TRACE",
  console: { enabled: true },
});

const { mount } = await import("./mount");
const root = document.querySelector<HTMLElement>("#root");

if (!root) {
  throw new Error("index.html is missing #root");
}

mount(root);
