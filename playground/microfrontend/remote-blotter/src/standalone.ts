// The entry for running this remote by itself, loaded by index.html.
// mount.ts does not import this file, so the federated build cannot drag it
// into the shell.
//
// A guard inside mount.ts ("configure only if nothing has configured yet") is
// the tempting alternative and it is a race: in the shell a remote can finish
// loading before the host's configure() runs, and then both configure, in an
// order that changes between reloads.
import { configure } from "@utk09/ui-observability";

configure({
  endpoint: "http://localhost:8787/v1/logs",
  serviceName: "example-blotter-standalone",
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
