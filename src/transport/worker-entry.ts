import {
  TELEMETRY_SDK_VERSION,
  TRANSPORT_WORKER_PROTOCOL,
  TRANSPORT_WORKER_REFUSAL,
  TRANSPORT_WORKER_TYPE,
} from "../constants";
import { Diagnostics, type DiagnosticHandler } from "../core/diagnostics";
import { isObject } from "../utils/guards";

let active: (() => void) | undefined;

/** Installs the worker service synchronously before its delivery module loads. */
export function serveTransportWorker(
  options: { onDiagnostic?: DiagnosticHandler } = {},
): () => void {
  if (active) {
    return active;
  }
  const diagnostics = new Diagnostics(options.onDiagnostic);
  if (typeof document !== "undefined" || typeof addEventListener !== "function") {
    diagnostics.report("config.invalid", "Call serveTransportWorker() in a dedicated worker.");
    return () => undefined;
  }

  let stopped = false;
  let port: MessagePort | undefined;
  let detach: (() => void) | undefined;
  const onMessage = (event: MessageEvent<unknown>): void => {
    diagnostics.guard(
      "transport.http_error",
      "The transport worker could not read its connection.",
      () => {
        const message = event.data;
        if (
          !isObject(message) ||
          message.p !== TRANSPORT_WORKER_PROTOCOL ||
          message.t !== TRANSPORT_WORKER_TYPE.connect
        ) {
          return;
        }
        if (event.ports.length === 0) {
          return;
        }
        const incoming = event.ports[0];
        if (port || message.v !== TELEMETRY_SDK_VERSION) {
          incoming.postMessage(TRANSPORT_WORKER_REFUSAL);
          incoming.close();
          return;
        }

        port = incoming;
        void import("./worker-server")
          .then((module) => {
            if (!stopped) {
              detach = module.serveWorkerPort(incoming, diagnostics);
            }
          })
          .catch((error: unknown) => {
            diagnostics.report(
              "transport.http_error",
              "The transport worker delivery module could not load.",
              undefined,
              error,
            );
            diagnostics.guard(
              "transport.http_error",
              "The failed transport port could not be closed.",
              () => {
                incoming.postMessage(TRANSPORT_WORKER_REFUSAL);
                incoming.close();
              },
            );
          });
      },
    );
  };

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    active = undefined;
    removeEventListener("message", onMessage);
    detach?.();
    diagnostics.guard(
      "transport.http_error",
      "The transport service could not close its port.",
      () => {
        port?.postMessage(TRANSPORT_WORKER_REFUSAL);
      },
    );
    diagnostics.guard("transport.http_error", "The transport port could not close.", () => {
      port?.close();
    });
  };
  addEventListener("message", onMessage);
  active = stop;
  return stop;
}
